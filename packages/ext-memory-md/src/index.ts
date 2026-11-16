/**
 * ext-memory-md：默认记忆（docs/architecture.md §10.2，ADR-0006）。
 * 一份人可读可改的 memory.md 作为 `memory` Section；只在 Compaction 时用增量编辑更新，
 * Section 内容只在重建上下文时刷新，两次压缩之间字节不变。
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { defineExtension, estimateTextTokens, renderEntries } from "@sofia/core"

export interface MemoryConfig {
  /** memory.md 的大小预算（估算 token），默认 1500 */
  budgetTokens?: number
  /** Model Role，默认 cheap */
  role?: string
  /** 记忆文件，相对数据目录；默认 memory.md */
  file?: string
}

export type MemoryOp = { op: "add"; text: string } | { op: "update"; index: number; text: string } | { op: "remove"; index: number }

const ENTRY = /^\s*[-*]\s+(.*)$/
const oneLine = (text: string) => text.replace(/\s*[\r\n]+\s*/g, " ").replace(/^[-*]\s+/, "").trim()

/** memory.md 中的条目（以 "- " 开头的行），编号从 1 起。其余行（标题、空行）不是条目。 */
export function listEntries(file: string): string[] {
  return file.split("\n").flatMap((line) => {
    const m = ENTRY.exec(line)
    return m ? [m[1]!.trim()] : []
  })
}

/** 解析模型输出的编辑操作；认不出的行忽略。 */
export function parseOps(output: string): MemoryOp[] {
  const ops: MemoryOp[] = []
  for (const raw of output.split("\n")) {
    const line = raw.replace(/^[\s>*`-]+/, "").replace(/`+$/, "").trim()
    let m: RegExpExecArray | null
    if ((m = /^ADD\s*[:：]\s*(.+)$/i.exec(line))) {
      const text = oneLine(m[1]!)
      if (text) ops.push({ op: "add", text })
    } else if ((m = /^UPDATE\s*#?(\d+)\s*[:：]\s*(.+)$/i.exec(line))) {
      const text = oneLine(m[2]!)
      if (text) ops.push({ op: "update", index: Number(m[1]), text })
    } else if ((m = /^REMOVE\s*#?(\d+)/i.exec(line))) {
      ops.push({ op: "remove", index: Number(m[1]) })
    }
  }
  return ops
}

/** 应用编辑操作：未涉及的行原样保留；编号指向应用前的条目；新增条目接在最后一条之后。 */
export function applyOps(file: string, ops: readonly MemoryOp[]): string {
  const lines = file === "" ? [] : file.replace(/\n+$/, "").split("\n")
  const entryLines = lines.flatMap((line, i) => (ENTRY.test(line) ? [i] : []))
  const removed = new Set<number>()
  const added: string[] = []
  for (const op of ops) {
    if (op.op === "add") {
      added.push(`- ${op.text}`)
      continue
    }
    const at = entryLines[op.index - 1]
    if (at === undefined) continue // 编号不存在：忽略这一条
    if (op.op === "update") lines[at] = `- ${op.text}`
    else removed.add(at)
  }
  const insertAfter = entryLines.at(-1) ?? lines.length - 1
  const out: string[] = []
  lines.forEach((line, i) => {
    if (!removed.has(i)) out.push(line)
    if (i === insertAfter) out.push(...added)
  })
  if (lines.length === 0) out.push(...added)
  return out.length > 0 ? `${out.join("\n")}\n` : ""
}

const SYSTEM_PROMPT = `你负责维护一个陪伴型 AI（记录里的「Sofia」）的长期记忆。记忆是一个条目列表，每行一条。

你会收到【当前记忆】（带编号）和【即将被遗忘的对话记录】。记录里的内容马上就要从她的上下文里消失，请判断其中有哪些值得长期记住，并输出对记忆的编辑操作。

值得记的：主人和其他人的身份、喜好、习惯、重要经历、人与人的关系、约定与承诺（含她自己答应过的事）、她自己形成的看法。
不值得记的：寒暄、一次性的琐事、已经办完且不会再提的事、工具调用的过程。

输出格式——每行一条操作，只能是下面三种：
ADD: <新条目>
UPDATE <编号>: <改写后的完整条目>
REMOVE <编号>

规则：
- 没有变化的条目不要输出，它们会原样保留。
- 新信息与已有条目是同一件事时用 UPDATE 合并，不要 ADD 出重复的条目；与已有条目冲突时以新的为准。
- 已经过时的条目用 REMOVE 删除。
- 每条一句话，离开上下文也能看懂：写清是谁、什么事；时间写成具体日期，不写"昨天""下周"。
- 主人在私聊里说的事，在条目里注明"（私聊）"。
- 只记录里出现过的事实，不推测。
- 记忆超出预算时，合并相近的条目、删除最不重要的，直到回到预算内。
- 没有需要改动的，只输出 NONE。`

export default defineExtension<MemoryConfig>({
  name: "memory-md",
  configSchema: {
    type: "object",
    properties: {
      budgetTokens: { type: "number", description: "memory.md 的大小预算（估算 token），默认 1500" },
      role: { type: "string", description: "用于整理记忆的 Model Role，默认 cheap" },
      file: { type: "string", description: "记忆文件（相对数据目录），默认 memory.md" },
    },
  },
  setup(sofia) {
    const config = sofia.config ?? {}
    const budget = config.budgetTokens ?? 1500
    const path = resolve(sofia.home, config.file ?? "memory.md")
    const read = () => {
      try {
        return readFileSync(path, "utf8")
      } catch {
        return ""
      }
    }
    const render = (file: string) => (file.trim() === "" ? null : `# 你的长期记忆\n\n这些是你记下来的事。它们不一定是最新的；近期对话里的说法与这里冲突时，以近期对话为准。\n\n${file.trim()}`)

    // "rebuild" 时读文件并缓存，"run" 时返回缓存：两次压缩之间 Section 字节不变
    let cached: string | null | undefined
    sofia.registerSection("memory", ({ reason }) => {
      if (reason === "rebuild" || cached === undefined) cached = render(read())
      return cached
    })

    sofia.on("compacted", async ({ entries }) => {
      const transcript = renderEntries(entries)
      if (transcript.trim() === "") return
      const file = read()
      const current = listEntries(file)
      const used = estimateTextTokens(file)
      const today = new Date()
      const user = [
        `【当前记忆】（约 ${used} token，预算 ${budget} token${used > budget ? "，已超出预算" : ""}）`,
        current.length > 0 ? current.map((text, i) => `${i + 1}. ${text}`).join("\n") : "（空）",
        "",
        "【即将被遗忘的对话记录】",
        transcript,
        "",
        `今天是 ${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}。请输出编辑操作。`,
      ].join("\n")
      const reply = await sofia.complete(config.role ?? "cheap", {
        systemPrompt: SYSTEM_PROMPT,
        messages: [{ role: "user", content: user, timestamp: Date.now() }],
      })
      if (reply.stopReason === "error" || reply.stopReason === "aborted") {
        throw new Error(reply.errorMessage ?? `memory request ${reply.stopReason}`)
      }
      const ops = parseOps(reply.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n"))
      if (ops.length === 0) return
      const next = applyOps(file, ops)
      if (next === file) return
      if (file !== "") {
        const history = join(sofia.dataDir, "history")
        mkdirSync(history, { recursive: true })
        writeFileSync(join(history, `${new Date().toISOString().replace(/[:.]/g, "-")}.md`), file)
      }
      writeFileSync(path, next)
      sofia.log.info(`memory updated: ${ops.length} edit(s), ~${estimateTextTokens(next)} tokens`)
    })
  },
})
