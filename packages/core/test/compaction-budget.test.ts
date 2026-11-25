import { fauxAssistantMessage } from "@earendil-works/pi-ai"
import { expect, it } from "vitest"
import { fakeChannel, room, say, setup } from "./harness.ts"

function seedHistory(t: ReturnType<typeof setup>) {
  for (const runId of ["one", "two", "three"]) {
    t.kernel.timeline.append({ type: "user", runId, data: { role: "user", content: "a".repeat(800), timestamp: 0 } })
  }
}

it.each([
  { provider: "faux", id: "vendor/chat", matches: true },
  { provider: "another", id: "vendor/chat", matches: false },
  { provider: "faux", id: "vendor/chat-v2", matches: false },
])("只为精确匹配的 $provider/$id 覆盖预留量，保留量继承全局", async ({ provider, id, matches }) => {
  const ch = fakeChannel()
  const t = setup({
    extensions: [ch.ext],
    faux: { provider, models: [{ id, contextWindow: 2000 }] },
    config: {
      compaction: { reserveTokens: 0, keepRecentTokens: 200, modelOverrides: { "faux/vendor/chat": { reserveTokens: 1500 } } },
    },
  })
  await t.kernel.start()
  seedHistory(t)
  t.reply("收到")
  ch.api.signal(say(room("r"), "你好"))
  await t.kernel.whenIdle()
  expect(t.of("compaction").map((e) => [e.reason, e.ok])).toEqual(matches ? [["threshold", true]] : [])
  const keptRuns = t.kernel.timeline.loadContext().entries.filter((e) => e.type === "user").map((e) => e.runId)
  expect(keptRuns).toEqual(matches ? ["three"] : ["one", "two", "three"])
  await t.kernel.stop()
})

it.each(["manual", "overflow"] as const)("%s 按主模型覆盖保留量，预留量继承全局", async (reason) => {
  const ch = fakeChannel()
  const t = setup({
    extensions: [ch.ext],
    faux: { models: [{ id: "vendor/chat", contextWindow: 2000 }] },
    config: { compaction: { reserveTokens: 0, modelOverrides: { "faux/vendor/chat": { keepRecentTokens: 200 } } } },
  })
  await t.kernel.start()
  seedHistory(t)
  if (reason === "manual") {
    ch.api.compact()
  } else {
    const overflow = fauxAssistantMessage([], { stopReason: "error", errorMessage: "prompt is too long: 2100 tokens > 2000 maximum" })
    t.reply(overflow, "收到")
    ch.api.signal(say(room("r"), "你好"))
  }
  await t.kernel.whenIdle()
  expect(t.of("compaction").map((e) => [e.reason, e.ok])).toEqual([[reason, true]])
  expect(t.kernel.timeline.loadContext().entries.filter((e) => e.type === "user").map((e) => e.runId)).toEqual(["three"])
  await t.kernel.stop()
})
