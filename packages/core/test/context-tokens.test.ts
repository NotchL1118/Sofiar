import { type AssistantMessage, fauxAssistantMessage } from "@earendil-works/pi-ai"
import { expect, it } from "vitest"
import { estimateContextTokens, estimateMessageTokens, Timeline } from "../src/index.ts"

function reply(text: string, totalTokens: number, stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
  const message = fauxAssistantMessage(text, { stopReason })
  return { ...message, usage: { ...message.usage, totalTokens } }
}

it("找不到压缩后的有效 usage 时估算所有消息，包括保留下来的旧回复", () => {
  const old = reply("旧", 5000)
  const messages = [old, reply("零", 0), reply("", 8000, "error"), reply("", 9000, "aborted")]
  expect(estimateContextTokens(messages, 1)).toBe(2)
  expect(estimateContextTokens(messages)).toBe(5001)
})

it("压缩后使用最新的正用量，加上它后面的消息；总数为零时可用分项用量", () => {
  const measured = reply("新", 0)
  measured.usage = { ...measured.usage, input: 30, output: 10, cacheRead: 4, cacheWrite: 2 }
  const messages = [reply("旧", 5000), reply("前", 100), measured, reply("后续", 0)]
  expect(estimateContextTokens(messages, 1)).toBe(48)
})

it("直接从已有 Timeline 的最后一次压缩重建 usage 边界，兼容缺失的检查点", () => {
  const timeline = new Timeline(":memory:")
  try {
    const appendReply = (message: AssistantMessage) => timeline.append({ type: "assistant", data: message })
    const checkpoint = { type: "system", data: { role: "system", content: "系统", timestamp: 0 } }
    timeline.append({ type: "user", data: { role: "user", content: "首次提问", timestamp: 0 } })
    const old = appendReply(reply("旧回复", 5000))
    expect(timeline.loadContext().usageStartIndex).toBe(0)

    timeline.append({ type: "compaction", data: { summary: "首次摘要", firstKeptSeq: old.seq, tokensBefore: 5000 } })
    const incomplete = timeline.loadContext()
    expect(incomplete.usageStartIndex).toBe(2) // 摘要、旧回复
    expect(incomplete.missingCheckpoint).toBe(true)
    timeline.append(checkpoint)
    const recent = appendReply(reply("新回复", 80))
    appendReply(reply("", 9000, "error"))
    const first = timeline.loadContext()
    expect(first.usageStartIndex).toBe(3) // system、摘要、旧回复
    expect(estimateContextTokens(first.messages, first.usageStartIndex)).toBe(80)

    timeline.append({ type: "compaction", data: { summary: "第二次摘要", firstKeptSeq: recent.seq, tokensBefore: 80 } })
    timeline.append(checkpoint)
    const second = timeline.loadContext()
    expect(second.messages.map((m) => m.role)).toEqual(["system", "summary", "assistant"])
    expect(second.usageStartIndex).toBe(second.messages.length)
    expect(estimateContextTokens(second.messages, second.usageStartIndex)).toBe(
      second.messages.reduce((sum, m) => sum + estimateMessageTokens(m), 0),
    )
  } finally {
    timeline.close()
  }
})
