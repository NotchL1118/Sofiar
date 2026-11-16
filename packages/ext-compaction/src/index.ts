/**
 * ext-compaction：官方 LLM 摘要压缩（docs/architecture.md §10.3）。
 * 内核决定何时压缩、切在哪里；本扩展只负责把即将离开上下文的条目写成"交接简报"。
 */
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { defineExtension, renderEntries } from "@sofia/core"

export interface CompactionConfig {
  /** Model Role，默认 cheap（未配置时内核回退到 main） */
  role?: string
  /** 覆盖摘要的系统提示词 */
  prompt?: string
  /** 同上，从文件读取（相对数据目录）；优先于 prompt */
  promptFile?: string
}

export const DEFAULT_PROMPT = `你是上下文摘要助手。下面是一个陪伴型 AI（记录里的「Sofia」）的一段经历记录，这段记录即将离开她的工作上下文。请替她写一份"交接简报"，让她读完能接着过日子，不会忘了正在发生的事。

简报用第二人称（"你"指 Sofia）、纯文本，包含四部分：
1. 近期发生的事（按 Room 分开写，保留具体的人名、时间、原话里的关键细节）
2. 进行中的话题与未完成的约定（谁答应了谁什么、什么时候）
3. 主人当前的状态与情绪
4. 各 Room 关键人物近况

要求：
- 如果给了已有的简报，在它的基础上更新：保留仍然有效的内容，并入新的，删掉已经结束或过时的；不要另起一份。
- 只写记录里出现过的事实，不推测，不评价。
- 主人在私聊里说的事要注明是私聊里说的。
- 控制在 800 字以内。只输出简报本身。`

export default defineExtension<CompactionConfig>({
  name: "compaction",
  configSchema: {
    type: "object",
    properties: {
      role: { type: "string", description: "用于摘要的 Model Role，默认 cheap" },
      prompt: { type: "string", description: "覆盖摘要的系统提示词" },
      promptFile: { type: "string", description: "从文件读取摘要提示词（相对数据目录）" },
    },
  },
  setup(sofia) {
    const config = sofia.config ?? {}
    const systemPrompt = () => {
      if (config.promptFile) {
        try {
          const text = readFileSync(resolve(sofia.home, config.promptFile), "utf8").trim()
          if (text) return text
        } catch (e) {
          sofia.log.warn(`cannot read promptFile, using default: ${e instanceof Error ? e.message : String(e)}`)
        }
      }
      return config.prompt?.trim() || DEFAULT_PROMPT
    }

    sofia.on("before_compact", async ({ entries, previousSummary, signal }) => {
      const transcript = renderEntries(entries)
      if (transcript.trim() === "") return undefined // 没有可摘要的内容：交给内核兜底（沿用旧摘要）
      const user = [
        previousSummary?.trim() ? `<previous_summary>\n${previousSummary.trim()}\n</previous_summary>` : "",
        `<transcript>\n${transcript}\n</transcript>`,
        "请输出更新后的交接简报。",
      ]
        .filter(Boolean)
        .join("\n\n")
      const reply = await sofia.complete(
        config.role ?? "cheap",
        { systemPrompt: systemPrompt(), messages: [{ role: "user", content: user, timestamp: Date.now() }] },
        { signal },
      )
      // 抛异常 = 摘要失败：内核本次不压缩、上下文不变
      if (reply.stopReason === "error" || reply.stopReason === "aborted") {
        throw new Error(reply.errorMessage ?? `summary request ${reply.stopReason}`)
      }
      const summary = reply.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n").trim()
      if (summary === "") throw new Error("summary model returned no text")
      return { summary }
    })
  },
})
