import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai"
import { describe, expect, it } from "vitest"
import { defineExtension, type HookMap, type SofiaAPI } from "../src/index.ts"
import { deferred, fakeChannel, room, say, setup, tick, userText } from "./harness.ts"

const main = room("main")
const long = (tag: string) => tag + "a".repeat(800) // ≈ 200 token
/** 窗口 2000、预留 1000 → 上下文估算超过 1000 token 即触发；保留最近约 500 token（一问一答约 400） */
const small = { faux: { models: [{ id: "faux-1", contextWindow: 2000 }] }, config: { compaction: { reserveTokens: 1000, keepRecentTokens: 500 } } }

function summarizer(onCompact?: (p: HookMap["before_compact"]["payload"]) => void) {
  const calls: HookMap["before_compact"]["payload"][] = []
  const ext = defineExtension({
    name: "compaction",
    setup: (s) =>
      void s.on("before_compact", (p) => {
        calls.push(p)
        onCompact?.(p)
        return { summary: `摘要#${calls.length}` }
      }),
  })
  return { ext, calls }
}

async function chat(t: ReturnType<typeof setup>, ch: ReturnType<typeof fakeChannel>, n: number, from = 1) {
  for (let i = from; i < from + n; i++) {
    t.reply(long(`答${i}`))
    ch.api.signal(say(main, long(`问${i}`)))
    await t.kernel.whenIdle()
  }
}

describe("Compaction", () => {
  it("Run 开始前超阈值：切点落在 Run 边界，compacted 在 rebuild 前完成，上下文按规则重建", async () => {
    const ch = fakeChannel()
    const sum = summarizer()
    let memory = "记忆 v1"
    let cached = memory
    const mem = defineExtension({
      name: "memory",
      setup(s) {
        s.registerSection("memory", ({ reason }) => (reason === "rebuild" ? (cached = memory) : cached))
        s.on("compacted", async ({ entries }) => {
          await tick()
          memory = `记忆 v2（看过 ${entries.length} 条）`
        })
      },
    })
    const t = setup({ extensions: [mem, sum.ext, ch.ext], ...small })
    await t.kernel.start()
    await chat(t, ch, 4)

    expect(sum.calls.length).toBeGreaterThanOrEqual(1)
    const first = sum.calls[0]!
    expect(first.reason).toBe("threshold")
    expect(first.previousSummary).toBeUndefined()
    const all = t.entries()
    const compactionIndex = all.findIndex((e) => e.type === "compaction")
    const compaction = all[compactionIndex]!
    const checkpoint = all[compactionIndex + 1]!
    expect(checkpoint.type).toBe("system")
    expect((checkpoint.data as any).sections.memory).toBe(`记忆 v2（看过 ${first.entries.length} 条）`)
    expect(Object.keys((checkpoint.data as any).sections)).toEqual(["kernel", "memory"])

    // 切点在 Run 边界：被压缩的最后一条与保留的第一条属于不同的 Run，且保留部分以 signal 开头
    const firstKept = all.find((e) => e.seq === (compaction.data as any).firstKeptSeq)!
    expect(firstKept.type).toBe("signal")
    expect(first.entries.at(-1)!.runId).not.toBe(firstKept.runId)
    expect(first.entries.every((e) => e.type !== "system")).toBe(true)

    // 压缩后的第一次请求：检查点 system → <summary> + 保留的条目 → 新 Signal
    const request = t.requests.find((r) => userText(r).includes("<summary>"))!
    expect(request[0]).toMatchObject({ role: "system", sections: { memory: expect.stringContaining("记忆 v2") } })
    expect(request.filter((m) => m.role === "system")).toHaveLength(1)
    expect(userText(request)).toMatch(/^<summary>\n摘要#1\n<\/summary>/)
    expect(userText(request)).not.toContain("问1")
    expect(request.at(-1)!.role).toBe("user")
    expect(t.of("compaction")[0]).toMatchObject({ ok: true, by: "compaction", reason: "threshold" })
    expect(ch.delivered).toHaveLength(4)
  })

  it("previousSummary 迭代传入；无压缩扩展时沿用旧摘要兜底", async () => {
    const ch = fakeChannel()
    const sum = summarizer()
    const t = setup({ extensions: [sum.ext, ch.ext], ...small })
    await t.kernel.start()
    await chat(t, ch, 8)
    expect(sum.calls.length).toBeGreaterThanOrEqual(2)
    expect(sum.calls[1]!.previousSummary).toBe("摘要#1")

    const bare = fakeChannel()
    const t2 = setup({ extensions: [bare.ext], ...small })
    await t2.kernel.start()
    await chat(t2, bare, 6)
    const compactions = t2.entries(["compaction"])
    expect(compactions.length).toBeGreaterThanOrEqual(1)
    expect((compactions[0]!.data as any).summary).toBe("")
    expect(t2.of("compaction")[0]).toMatchObject({ ok: true })
    expect(t2.of("compaction")[0]!.by).toBeUndefined()
    expect(userText(t2.requests.at(-1)!)).not.toContain("问1")
    expect(bare.delivered).toHaveLength(6)
  })

  it("before_compact 首个返回者生效，可取消；摘要失败时上下文不变", async () => {
    const ch = fakeChannel()
    let mode: "throw" | "cancel" | "ok" = "throw"
    const a = defineExtension({
      name: "a",
      setup: (s) =>
        void s.on("before_compact", () => {
          if (mode === "throw") throw new Error("llm down")
          if (mode === "cancel") return { cancel: true }
          return { summary: "来自 a" }
        }),
    })
    const b = defineExtension({ name: "b", setup: (s) => void s.on("before_compact", () => (mode === "ok" ? { summary: "来自 b" } : undefined)) })
    const t = setup({ extensions: [a, b, ch.ext], ...small })
    await t.kernel.start()
    await chat(t, ch, 4)
    expect(t.entries(["compaction"])).toHaveLength(0)
    expect(t.of("compaction").every((e) => !e.ok && e.error === "a: llm down")).toBe(true)
    expect(userText(t.requests.at(-1)!)).toContain("问1")
    expect(ch.delivered).toHaveLength(4)

    mode = "cancel"
    await chat(t, ch, 1, 5)
    expect(t.entries(["compaction"])).toHaveLength(0)
    expect(t.of("compaction").at(-1)).toMatchObject({ ok: false, error: "cancelled", by: "a" })

    mode = "ok"
    await chat(t, ch, 1, 6)
    expect(t.entries(["compaction"]).map((e) => (e.data as any).summary)).toEqual(["来自 a"])
  })

  it("Turn 之间压缩：在 Turn 边界切，工具调用与结果不被拆开", async () => {
    const ch = fakeChannel()
    const sum = summarizer()
    const tools = defineExtension({
      name: "t",
      setup: (s) =>
        void s.registerTool({
          name: "echo", label: "echo", description: "echo", parameters: { type: "object", properties: {} },
          execute: async () => ({ content: [{ type: "text", text: "ok" }], details: undefined }),
        }),
    })
    const t = setup({ extensions: [sum.ext, tools, ch.ext], ...small })
    await t.kernel.start()
    t.reply(
      fauxAssistantMessage([{ type: "text", text: long("思考").repeat(4) }, fauxToolCall("t_echo", {})], { stopReason: "toolUse" }),
      "查完了",
    )
    ch.api.signal(say(main, long("帮我查")))
    await t.kernel.whenIdle()

    expect(sum.calls).toHaveLength(1)
    expect(sum.calls[0]!.entries.map((e) => e.type)).toEqual(["signal"])
    expect(t.entries().map((e) => e.type)).toEqual(["system", "signal", "assistant", "toolResult", "compaction", "system", "assistant"])
    expect(t.requests[1]!.map((m) => m.role)).toEqual(["system", "user", "assistant", "toolResult"])
    expect((t.requests[1]![0] as any).toolsAdded.map((x: any) => x.name)).toEqual(["t_echo"])
    expect(t.of("run_end")).toHaveLength(1)
    expect(ch.delivered.at(-1)!.text).toBe("查完了")

    // 下一个 Run 从 Timeline 重建，结果一致
    t.reply("嗯")
    ch.api.signal(say(main, "谢谢"))
    await t.kernel.whenIdle()
    expect(t.requests[2]!.map((m) => m.role)).toEqual(["system", "user", "assistant", "toolResult", "assistant", "user"])
    expect(t.entries(["system"])).toHaveLength(2)
  })

  it("溢出 → 强制压缩 → continue 重试；run_end 只触发一次", async () => {
    const ch = fakeChannel()
    const sum = summarizer()
    const t = setup({ extensions: [sum.ext, ch.ext], config: { compaction: { keepRecentTokens: 200 } } })
    await t.kernel.start()
    await chat(t, ch, 2)
    t.reply(fauxAssistantMessage([], { stopReason: "error", errorMessage: "prompt is too long: 300000 tokens > 200000 maximum" }), "挤进来了")
    ch.api.signal(say(main, long("问3")))
    await t.kernel.whenIdle()

    expect(sum.calls).toHaveLength(1)
    expect(sum.calls[0]!.reason).toBe("overflow")
    expect(t.of("llm_retry")).toHaveLength(0)
    expect(t.of("run_end")).toHaveLength(3)
    expect(t.of("run_end").at(-1)!.status).toBe("ok")
    expect(ch.delivered.at(-1)!.text).toBe("挤进来了")
    const retry = t.requests.at(-1)!
    expect(retry.at(-1)!.role).toBe("user")
    expect(retry.some((m) => m.role === "assistant" && m.stopReason === "error")).toBe(false)
    expect(userText(retry)).toContain("<summary>")
    expect(t.entries(["notice"])).toHaveLength(0)
  })

  it("溢出后压缩不了：Run 以 error 结束", async () => {
    const ch = fakeChannel()
    const t = setup({ extensions: [ch.ext] })
    await t.kernel.start()
    t.reply(fauxAssistantMessage([], { stopReason: "error", errorMessage: "prompt is too long: 300000 tokens > 200000 maximum" }))
    ch.api.signal(say(main, "在吗"))
    await t.kernel.whenIdle()
    expect(t.of("run_end")).toHaveLength(1)
    expect(t.of("run_end")[0]!.status).toBe("error")
    expect(ch.errors).toHaveLength(1)
  })

  it("sofia.compact()：空闲时立即执行；有 Run 时在其结束后、下一个 Run 开始前执行", async () => {
    const ch = fakeChannel()
    const sum = summarizer()
    const t = setup({ extensions: [sum.ext, ch.ext], config: { compaction: { keepRecentTokens: 200 } } })
    await t.kernel.start()
    await chat(t, ch, 3)
    ch.api.compact()
    await t.kernel.whenIdle()
    expect(sum.calls.map((c) => c.reason)).toEqual(["manual"])
    expect(t.entries(["compaction"])).toHaveLength(1)

    await chat(t, ch, 2, 4)
    const gate = deferred()
    t.reply(async () => (await gate.promise, fauxAssistantMessage(long("答6"))), "答7")
    ch.api.signal(say(main, long("问6")))
    await tick()
    ch.api.compact()
    ch.api.signal(say(room("other"), "问7"))
    await tick()
    expect(sum.calls).toHaveLength(1)
    gate.resolve()
    await t.kernel.whenIdle()
    expect(sum.calls).toHaveLength(2)
    const order = t.events.filter((e) => e.type === "run_end" || e.type === "run_start" || (e.type === "compaction" && e.ok)).map((e) => e.type).slice(-4)
    expect(order).toEqual(["run_end", "compaction", "run_start", "run_end"])
  })
})

describe("重启恢复", () => {
  it("interrupted notice；Section / 工具 diff 只在有变化时追加补丁", async () => {
    const home = mkdtempSync(join(tmpdir(), "sofia-restart-"))
    const dbPath = join(home, "timeline.db")
    const boot = (persona: string, withTool: boolean) => {
      const ch = fakeChannel()
      const ext = defineExtension({
        name: "persona",
        setup(s: SofiaAPI) {
          s.registerSection("persona", () => persona)
          if (withTool) {
            s.registerTool({
              name: "wave", label: "wave", description: "wave", parameters: { type: "object", properties: {} },
              execute: async () => ({ content: [], details: undefined }),
            })
          }
        },
      })
      return { ch, t: setup({ extensions: [ext, ch.ext], home, dbPath }) }
    }

    const first = boot("v1", false)
    await first.t.kernel.start()
    first.t.reply("你好")
    first.ch.api.signal(say(main, "在吗"))
    await first.t.kernel.whenIdle()
    // 模拟崩溃：留下一个未结束的 Run
    first.t.kernel.timeline.startRun({ id: "crashed", startedAt: Date.now() })
    first.t.kernel.timeline.close()

    const second = boot("v1", false)
    await second.t.kernel.start()
    expect(second.t.kernel.timeline.getRun("crashed")).toMatchObject({ status: "interrupted" })
    expect(second.t.entries().map((e) => e.type)).toEqual(["system", "signal", "assistant", "notice"])
    expect((second.t.entries(["notice"])[0]!.data as any).text).toBe("（你刚才被中断了）")
    second.t.reply("我回来了")
    second.ch.api.signal(say(main, "怎么了"))
    await second.t.kernel.whenIdle()
    expect(second.t.requests[0]!.map((m) => m.role)).toEqual(["system", "user", "assistant", "user"])
    expect(userText(second.t.requests[0]!)).toContain("<notice>（你刚才被中断了）</notice>")
    await second.t.kernel.stop()

    const third = boot("v2", true)
    await third.t.kernel.start()
    const systems = third.t.entries(["system"])
    expect(systems).toHaveLength(2)
    expect(systems[1]!.data).toMatchObject({ sections: { persona: "v2" }, toolsAdded: [{ name: "persona_wave" }] })
    expect(third.t.entries(["notice"])).toHaveLength(1)
    await third.t.kernel.stop()
  })

  it("stop：中止当前 Run 并触发 shutdown", async () => {
    const ch = fakeChannel()
    let reason: string | undefined
    const ext = defineExtension({ name: "x", setup: (s) => void s.on("shutdown", (p) => void (reason = p.reason)) })
    const t = setup({ extensions: [ch.ext, ext], faux: { tokensPerSecond: 20 } })
    await t.kernel.start()
    t.reply("很长的一段话".repeat(50))
    ch.api.signal(say(main, "讲"))
    await tick(30)
    const runId = ch.api.currentRun()!.id
    const notices: unknown[] = []
    t.kernel.events.subscribe((e) => e.type === "run_end" && notices.push(...t.entries(["notice"]).map((n) => (n.data as any).text)))
    await t.kernel.stop("restart")
    expect(reason).toBe("restart")
    expect(notices).toEqual(["（你刚才被中断了）"])
    expect(t.of("run_end")[0]).toMatchObject({ status: "aborted", run: { id: runId } })
  })
})
