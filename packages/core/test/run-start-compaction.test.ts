import { getCurrentSystemMessage } from "@earendil-works/pi-ai"
import { expect, it, onTestFinished, vi } from "vitest"
import { defineExtension, type ExtensionDef } from "../src/index.ts"
import { fakeChannel, room, say, setup, userText } from "./harness.ts"

const currentRoom = room("main")

async function boot(...extensions: ExtensionDef[]) {
  const channel = fakeChannel()
  const summarize = vi.fn(() => ({ summary: "较早对话的摘要" }))
  const summarizer = defineExtension({ name: "summary", setup: (s) => void s.on("before_compact", summarize) })
  const t = setup({
    extensions: [...extensions, summarizer, channel.ext],
    faux: { models: [{ id: "faux-1", contextWindow: 4000 }] },
    config: { compaction: { reserveTokens: 1000, keepRecentTokens: 500 } },
  })
  onTestFinished(() => t.kernel.stop())
  await t.kernel.start()
  for (const runId of ["old", "recent"]) {
    t.kernel.timeline.append({ type: "user", runId, data: { role: "user", content: runId + "文".repeat(700), timestamp: 0 } })
  }
  return { ...t, channel, summarize }
}

it("仅本轮 Recall 使上下文超阈值，摘要只处理旧历史，Recall 和 Signal 各发送一次", async () => {
  const recall = "新".repeat(1800)
  const onStart = vi.fn(() => ({ recall: [recall] }))
  const t = await boot(defineExtension({ name: "memory", setup: (s) => void s.on("run_start", onStart) }))
  t.reply("答")
  t.channel.api.signal(say(currentRoom, "本次提问"))
  await t.kernel.whenIdle()

  expect(onStart).toHaveBeenCalledTimes(1)
  expect(t.summarize).toHaveBeenCalledOnce()
  expect(t.summarize).toHaveBeenCalledWith(expect.objectContaining({
    reason: "threshold", entries: [expect.objectContaining({ runId: "old" })],
  }))
  expect(t.entries().slice(-5).map((e) => e.type)).toEqual(["compaction", "system", "recall", "signal", "assistant"])
  expect(userText(t.requests[0]!)).toContain(`<recall>\n你想起了这些：\n- ${recall}\n</recall>`)
  expect(userText(t.requests[0]!).match(/本次提问/g)).toHaveLength(1)
})

it("仅 Section 补丁使上下文超阈值，压缩后用新记忆和本轮的 Section", async () => {
  let updated = false
  const t = await boot(defineExtension({
    name: "persona",
    setup(s) {
      s.registerSection("persona", ({ reason }) => {
        if (reason === "rebuild") return "基础提示"
        return updated ? "本轮新提示" : "旧".repeat(1800)
      })
      s.registerSection("memory", () => updated ? "新记忆" : "旧记忆")
      s.on("compacted", () => { updated = true })
    },
  }))
  t.reply("答")
  t.channel.api.signal(say(currentRoom, "本次提问"))
  await t.kernel.whenIdle()

  expect(t.of("compaction")).toMatchObject([{ ok: true, reason: "threshold" }])
  const systems = t.entries(["system"])
  expect(systems.slice(1).map((e) => e.data)).toMatchObject([
    { sections: { persona: "基础提示", memory: "新记忆" } },
    { sections: { persona: "本轮新提示" } },
  ])
  expect(getCurrentSystemMessage(t.requests[0]!)?.sections).toMatchObject({ persona: "本轮新提示", memory: "新记忆" })
})

it("新注册工具的声明计入阈值，压缩检查点声明一次", async () => {
  const t = await boot()
  t.channel.api.registerTool({
    name: "read", label: "读", description: "读".repeat(1800), parameters: { type: "object", properties: {} },
    execute: async () => ({ content: [], details: undefined }),
  })
  t.reply("答")
  t.channel.api.signal(say(currentRoom, "本次提问"))
  await t.kernel.whenIdle()

  expect(t.of("compaction")).toMatchObject([{ ok: true, reason: "threshold" }])
  expect(t.requests[0]!.filter((m) => m.role === "system")).toMatchObject([{ toolsAdded: [{ name: "fake_read" }] }])
})

it("run_start 收集 Recall 时中止会保留已消费的 Signal，并跳过压缩和请求", async () => {
  const t = await boot(defineExtension({
    name: "cancel",
    setup(s) {
      s.on("run_start", () => {
        s.abortRun()
        return { recall: ["忆".repeat(1800)] }
      })
    },
  }))
  t.channel.api.signal(say(currentRoom, "本次提问"))
  await t.kernel.whenIdle()

  expect(t.of("compaction")).toHaveLength(0)
  expect(t.of("llm_request")).toHaveLength(0)
  expect(t.of("run_end")).toMatchObject([{ status: "aborted" }])
  expect(t.entries(["signal", "recall"]).map((e) => e.type)).toEqual(["signal"])
})
