/**
 * ext-trace：订阅只读事件流，写入 trace.db（docs/architecture.md §10.7）。
 * Trace 与 Timeline 分开，可随时删除。默认不记录完整的消息内容。
 */
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { defineExtension, type SofiaEvent } from "@sofia/core"

export interface TraceConfig {
  /** 记录完整的消息、工具参数与结果（图片数据除外）；默认只记元信息 */
  recordPayloads?: boolean
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY, at INTEGER, kind TEXT, run_id TEXT, turn INTEGER,
                                   room TEXT, ext TEXT, ms INTEGER, data TEXT);
CREATE INDEX IF NOT EXISTS events_run ON events(run_id);
CREATE INDEX IF NOT EXISTS events_at ON events(at);
`

const SKIPPED = new Set(["message_update", "tool_execution_update"])

const textChars = (content: unknown): number =>
  typeof content === "string"
    ? content.length
    : Array.isArray(content)
      ? content.reduce((n, b) => n + (typeof b?.text === "string" ? b.text.length : 0), 0)
      : 0

/** 一条消息的元信息（不含内容）。 */
function brief(message: any): Record<string, unknown> {
  if (message?.role === "assistant") {
    const u = message.usage ?? {}
    return {
      role: "assistant",
      model: message.model,
      stopReason: message.stopReason,
      ...(message.errorMessage ? { error: message.errorMessage } : {}),
      chars: textChars(message.content),
      toolCalls: (message.content ?? []).flatMap((b: any) => (b.type === "toolCall" ? [b.name] : [])),
      usage: { input: u.input, output: u.output, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite, total: u.totalTokens, cost: u.cost?.total },
    }
  }
  if (message?.role === "toolResult") return { role: "toolResult", toolName: message.toolName, isError: message.isError, chars: textChars(message.content) }
  if (message?.role === "signal") return { role: "signal", signalId: message.signal?.id }
  if (message?.role === "system") {
    return { role: "system", sections: Object.keys(message.sections ?? {}), toolsAdded: message.toolsAdded?.length ?? 0, toolsRemoved: message.toolsRemoved?.length ?? 0 }
  }
  return { role: message?.role }
}

function briefSignal(signal: any): Record<string, unknown> {
  const source = signal?.source ?? {}
  return {
    signalId: signal?.id,
    priority: signal?.priority,
    source: source.kind,
    ...(source.kind === "room" ? { sender: source.sender?.name, isOwner: source.sender?.isOwner } : { from: source.from }),
    chars: textChars(signal?.content),
  }
}

interface Row {
  room?: string
  ext?: string
  ms?: number
  data: Record<string, unknown>
}

function toRow(e: any, payloads: boolean): Row {
  const { type: _type, at: _at, runId: _runId, turn: _turn, ...rest } = e
  switch (e.type) {
    case "signal_received":
    case "signal_dropped":
    case "steered":
      return { room: e.signal?.source?.room?.id, ext: e.by, data: payloads ? rest : { ...briefSignal(e.signal), ...(e.by ? { by: e.by } : {}) } }
    case "run_start":
      return { room: e.run?.focusRoom?.id, data: { signals: e.signals } }
    case "run_end":
      return { room: e.run?.focusRoom?.id, ms: e.at - e.run?.startedAt, data: { status: e.status, ...(e.error ? { error: e.error } : {}) } }
    case "delivery":
      return { room: e.room, data: { ok: e.ok, ...(e.error ? { error: e.error } : {}) } }
    case "message_start":
    case "message_end":
      return { ms: e.type === "message_end" ? e.message?.durationMs : undefined, data: payloads ? { message: e.message } : brief(e.message) }
    case "turn_end":
      return { data: { stopReason: e.message?.stopReason, toolResults: e.toolResults?.length ?? 0 } }
    case "agent_end":
      return { data: { messages: e.messages?.length ?? 0 } }
    case "tool_execution_start":
      return { data: { toolCallId: e.toolCallId, toolName: e.toolName, ...(payloads ? { args: e.args } : {}) } }
    case "tool_execution_end":
      return { ms: e.durationMs, data: { toolCallId: e.toolCallId, toolName: e.toolName, isError: e.isError, ...(payloads ? { result: e.result } : {}) } }
    default: {
      const { ext, ms, ...data } = rest
      return { ext: ext ?? rest.by, ms, data }
    }
  }
}

/** 图片的 base64 数据从不写入 Trace。 */
const withoutImages = (_key: string, value: any) =>
  value && value.type === "image" && typeof value.data === "string" ? { ...value, data: `[${value.data.length} chars base64]` } : value

export default defineExtension<TraceConfig>({
  name: "trace",
  configSchema: {
    type: "object",
    properties: { recordPayloads: { type: "boolean", description: "记录完整的消息与工具内容（默认只记元信息）" } },
  },
  setup(sofia) {
    const payloads = sofia.config?.recordPayloads === true
    const db = new DatabaseSync(join(sofia.home, "trace.db"))
    db.exec("PRAGMA journal_mode = WAL")
    db.exec("PRAGMA synchronous = NORMAL")
    db.exec(SCHEMA)
    const insert = db.prepare("INSERT INTO events (at, kind, run_id, turn, room, ext, ms, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")

    const runRooms = new Map<string, string>()
    let closed = false
    let failing = false
    let writing = false

    const unsubscribe = sofia.events.subscribe((e: SofiaEvent) => {
      if (closed || writing || SKIPPED.has(e.type)) return
      writing = true // 写入失败时打的日志本身也是事件，不能再进来
      try {
        const row = toRow(e, payloads)
        if (e.type === "run_start" && e.runId && row.room) runRooms.set(e.runId, row.room)
        const room = row.room ?? (e.runId ? runRooms.get(e.runId) : undefined)
        if (e.type === "run_end" && e.runId) runRooms.delete(e.runId)
        insert.run(
          e.at,
          e.type,
          e.runId ?? null,
          e.turn ?? null,
          room ?? null,
          row.ext ?? null,
          typeof row.ms === "number" && Number.isFinite(row.ms) ? Math.round(row.ms) : null,
          JSON.stringify(row.data, withoutImages),
        )
        failing = false
      } catch (err) {
        if (!failing) sofia.log.error(`trace write failed: ${err instanceof Error ? err.message : String(err)}`)
        failing = true
      } finally {
        writing = false
      }
    })

    sofia.on("shutdown", () => {
      unsubscribe()
      closed = true
      db.close()
    })
  },
})
