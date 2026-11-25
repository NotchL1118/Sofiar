/**
 * Compaction 的记账部分：token 估算与切点（docs/architecture.md §7.3）。
 * 摘要策略不在这里——那是扩展的事。
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core"
import { entryToMessage } from "./timeline.ts"
import { renderSignal } from "./render.ts"
import type { TimelineEntry } from "./types.ts"

const IMAGE_TOKENS = 1200
const CJK = /[\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]/g

/** 文本的粗略 token 估算：中日韩字符按每字 1 token，其余按 4 字符 1 token。 */
export function estimateTextTokens(text: string): number {
  const cjk = text.match(CJK)?.length ?? 0
  return cjk + Math.ceil((text.length - cjk) / 4)
}

function blocksTokens(blocks: readonly object[]): number {
  let tokens = 0
  for (const block of blocks as readonly { type: string; [k: string]: unknown }[]) {
    if (block.type === "text") tokens += estimateTextTokens(String(block.text ?? ""))
    else if (block.type === "thinking") tokens += estimateTextTokens(String(block.thinking ?? ""))
    else if (block.type === "image") tokens += IMAGE_TOKENS
    else if (block.type === "toolCall") tokens += estimateTextTokens(String(block.name ?? "") + JSON.stringify(block.arguments ?? {}))
  }
  return tokens
}

/** 单条消息的粗略 token 估算（图片按固定值）。 */
export function estimateMessageTokens(message: AgentMessage): number {
  switch (message.role) {
    case "signal":
      return blocksTokens(renderSignal(message.signal))
    case "recall":
      return estimateTextTokens(message.items.join("\n")) + 8
    case "notice":
      return estimateTextTokens(message.text) + 4
    case "summary":
      return estimateTextTokens(message.summary) + 4
    case "system": {
      const { timestamp: _t, role: _r, ...rest } = message
      return estimateTextTokens(JSON.stringify(rest))
    }
    case "user":
      return typeof message.content === "string"
        ? estimateTextTokens(message.content)
        : blocksTokens(message.content)
    case "assistant":
    case "toolResult":
      return blocksTokens(message.content)
    default:
      return 0
  }
}

/** 从压缩后的首个可用下标寻找最近一次有效 usage；尚无实测用量时估算整个上下文。 */
export function estimateContextTokens(messages: readonly AgentMessage[], usageStartIndex = 0): number {
  let tail = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!
    if (i >= usageStartIndex && m.role === "assistant" && m.stopReason !== "error" && m.stopReason !== "aborted") {
      const u = m.usage
      const used = u.totalTokens || u.input + u.output + u.cacheRead + u.cacheWrite
      if (used > 0) return used + tail
    }
    tail += estimateMessageTokens(m)
  }
  return tail
}

/**
 * 切点：返回第一条**保留**条目的下标（0 表示没有可压缩的内容，`entries.length` 表示全部压缩）。
 *
 * 从末尾向前累加到 `keepRecentTokens`，切点落在其后最近的 Run 边界；
 * 若落点所在的 Run 已是最后一个（它自身就超出），退化为在 Turn 边界切——
 * 即不以 toolResult 开头，保证工具调用与结果不被拆开。
 */
export function findCut(entries: readonly TimelineEntry[], keepRecentTokens: number): number {
  const n = entries.length
  let acc = 0
  let threshold = -1
  for (let i = n - 1; i >= 0; i--) {
    const message = entryToMessage(entries[i]!)
    acc += message ? estimateMessageTokens(message) : 0
    if (acc >= keepRecentTokens) {
      threshold = i
      break
    }
  }
  if (threshold < 0) return 0

  const isRunBoundary = (i: number) => i > 0 && entries[i]!.runId !== entries[i - 1]!.runId
  // 在达到上限的那一条或其后找边界（保留量至多超出一条）
  const start = Math.max(threshold, 1)
  for (let i = start; i < n; i++) if (isRunBoundary(i)) return i
  for (let i = start; i < n; i++) if (entries[i]!.type !== "toolResult") return i
  return n
}
