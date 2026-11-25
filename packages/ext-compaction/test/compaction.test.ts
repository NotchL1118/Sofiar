import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fauxAssistantMessage } from "@earendil-works/pi-ai"
import { expect, it } from "vitest"
import { fakeChannel, room, say, setup, userText } from "../../core/test/harness.ts"
import compaction from "../src/index.ts"

const main = room("main")
const long = (tag: string) => tag + "a".repeat(800)

async function chat(t: ReturnType<typeof setup>, ch: ReturnType<typeof fakeChannel>, tags: string[]) {
  for (const tag of tags) {
    t.reply(long(`答${tag}`))
    ch.api.signal(say(main, long(`问${tag}`)))
    await t.kernel.whenIdle()
  }
}

it("用 main 角色写交接简报，带入 previousSummary 迭代更新；摘要进入下一次上下文", async () => {
  const ch = fakeChannel()
  const t = setup({ extensions: [compaction, ch.ext], config: { compaction: { keepRecentTokens: 500 } } })
  await t.kernel.start()
  await chat(t, ch, ["1", "2", "3"])

  t.reply("简报一：主人问了 1 和 2。")
  ch.api.compact()
  await t.kernel.whenIdle()
  const first = t.requests.at(-1)!
  expect((first[0] as any).content).toContain("上下文摘要助手")
  expect(userText(first)).toMatch(/<transcript>\n\[main · [^\]]+\] 阿洋（主人）：问1a+\nSofia：答1a+/)
  expect(userText(first)).not.toContain("previous_summary")
  expect(userText(first)).not.toContain("问3")
  expect(t.of("compaction").at(-1)).toMatchObject({ ok: true, by: "compaction", reason: "manual" })
  expect(t.of("llm_request").at(-1)).toMatchObject({ role: "main" })

  await chat(t, ch, ["4"])
  expect(userText(t.requests.at(-1)!)).toContain("<summary>\n简报一：主人问了 1 和 2。\n</summary>")

  t.reply("简报二")
  ch.api.compact()
  await t.kernel.whenIdle()
  expect(userText(t.requests.at(-1)!)).toContain("<previous_summary>\n简报一：主人问了 1 和 2。\n</previous_summary>")
  expect(t.entries(["compaction"]).map((e) => (e.data as any).summary)).toEqual(["简报一：主人问了 1 和 2。", "简报二"])
})

it("摘要失败、为空或被截断时保留原上下文，之后可用完整的短摘要压缩", async () => {
  const ch = fakeChannel()
  const t = setup({ extensions: [compaction, ch.ext], config: { compaction: { keepRecentTokens: 500 } } })
  await t.kernel.start()
  await chat(t, ch, ["1", "2", "3"])
  const before = t.entries()
  for (const bad of [
    fauxAssistantMessage([], { stopReason: "error", errorMessage: "invalid api key" }),
    fauxAssistantMessage("  "),
    fauxAssistantMessage("她刚答应", { stopReason: "length" }),
  ]) {
    t.reply(bad)
    ch.api.compact()
    await t.kernel.whenIdle()
  }
  expect(t.entries()).toEqual(before)
  expect(t.of("compaction").map((e) => e.error)).toEqual([
    "compaction: invalid api key",
    "compaction: summary model returned no text",
    "compaction: summary reached the output token limit",
  ])

  t.reply("周六见。")
  ch.api.compact()
  await t.kernel.whenIdle()
  expect(t.entries(["compaction"])).toMatchObject([{ data: { summary: "周六见。" } }])
})

it("promptFile 覆盖摘要提示词", async () => {
  const home = mkdtempSync(join(tmpdir(), "sofia-compaction-"))
  writeFileSync(join(home, "summary.md"), "自定义提示词")
  const ch = fakeChannel()
  const t = setup({ home, extensions: [{ def: compaction, config: { promptFile: "summary.md", role: "main" } }, ch.ext], config: { compaction: { keepRecentTokens: 500 } } })
  await t.kernel.start()
  await chat(t, ch, ["1", "2", "3"])
  t.reply("简报")
  ch.api.compact()
  await t.kernel.whenIdle()
  expect((t.requests.at(-1)![0] as any).content).toBe("自定义提示词")
  expect(t.of("llm_request").at(-1)).toMatchObject({ role: "main" })
})
