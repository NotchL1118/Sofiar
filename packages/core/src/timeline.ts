/**
 * Timeline：唯一、永久、只追加的经历记录（ADR-0003，docs/architecture.md §7）。
 * 本模块只管存取与"从 Timeline 重建工作上下文"，不做任何调度。
 */
import { DatabaseSync } from "node:sqlite"
import type { AgentMessage } from "@earendil-works/pi-agent-core"
import { uuidv7 } from "@earendil-works/pi-ai"
import type { CompactionData, RoomRef, RunInfo, RunStatus, Signal, TimelineEntry, TimelineQuery } from "./types.ts"

const SCHEMA = `
CREATE TABLE IF NOT EXISTS entries (
  seq     INTEGER PRIMARY KEY AUTOINCREMENT,
  id      TEXT NOT NULL UNIQUE,
  at      INTEGER NOT NULL,
  type    TEXT NOT NULL,
  run_id  TEXT,
  room    TEXT,
  data    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS entries_run  ON entries(run_id);
CREATE INDEX IF NOT EXISTS entries_room ON entries(room, at);
CREATE INDEX IF NOT EXISTS entries_type ON entries(type, seq);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY, focus_room TEXT, started_at INTEGER NOT NULL,
  ended_at INTEGER, status TEXT
);
`

interface Row {
  seq: number
  id: string
  at: number
  type: string
  run_id: string | null
  room: string | null
  data: string
}

function toEntry(row: Row): TimelineEntry {
  return {
    seq: row.seq,
    id: row.id,
    at: row.at,
    type: row.type,
    ...(row.run_id === null ? {} : { runId: row.run_id }),
    ...(row.room === null ? {} : { room: row.room }),
    data: JSON.parse(row.data),
  }
}

/** AgentMessage → 条目的 type 与 data。`summary` 是派生消息，不落盘。 */
export function messageToEntry(message: AgentMessage): { type: string; data: unknown; room?: string } | undefined {
  switch (message.role) {
    case "signal":
      return { type: "signal", data: message.signal, room: message.signal.source.room?.id }
    case "recall":
      return { type: "recall", data: { from: message.from, items: message.items } }
    case "notice":
      return { type: "notice", data: { text: message.text } }
    case "summary":
      return undefined
    default:
      return { type: message.role, data: message }
  }
}

/** 条目 → AgentMessage；compaction 条目没有对应消息。 */
export function entryToMessage(entry: TimelineEntry): AgentMessage | undefined {
  switch (entry.type) {
    case "signal": {
      const signal = entry.data as Signal
      return { role: "signal", signal, timestamp: signal.at }
    }
    case "recall": {
      const data = entry.data as { from: string; items: string[] }
      return { role: "recall", from: data.from, items: data.items, timestamp: entry.at }
    }
    case "notice":
      return { role: "notice", text: (entry.data as { text: string }).text, timestamp: entry.at }
    case "system":
    case "user":
    case "assistant":
    case "toolResult":
      return entry.data as AgentMessage
    default:
      return undefined
  }
}

function isFailedAssistant(entry: TimelineEntry): boolean {
  if (entry.type !== "assistant") return false
  const stop = (entry.data as { stopReason?: string }).stopReason
  return stop === "error" || stop === "aborted"
}

/** 从 Timeline 重建出的工作上下文。 */
export interface LoadedContext {
  messages: AgentMessage[]
  /** 进入上下文的非 system 条目（已剔除 error/aborted assistant），按 seq 正序；供切点计算。 */
  entries: TimelineEntry[]
  previousSummary: string | undefined
  /** 最近一次 compaction 之后还没有全量 system 检查点（写入中途崩溃）。 */
  missingCheckpoint: boolean
}

export class Timeline {
  private readonly db: DatabaseSync

  constructor(path: string) {
    this.db = new DatabaseSync(path)
    if (path !== ":memory:") this.db.exec("PRAGMA journal_mode = WAL")
    this.db.exec("PRAGMA synchronous = NORMAL")
    this.db.exec(SCHEMA)
  }

  close(): void {
    this.db.close()
  }

  append(input: { type: string; data: unknown; runId?: string; room?: string; at?: number; id?: string }): TimelineEntry {
    const id = input.id ?? uuidv7()
    const at = input.at ?? Date.now()
    const result = this.db
      .prepare("INSERT INTO entries (id, at, type, run_id, room, data) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, at, input.type, input.runId ?? null, input.room ?? null, JSON.stringify(input.data))
    return {
      seq: Number(result.lastInsertRowid),
      id,
      at,
      type: input.type,
      ...(input.runId === undefined ? {} : { runId: input.runId }),
      ...(input.room === undefined ? {} : { room: input.room }),
      data: input.data,
    }
  }

  query(q: TimelineQuery = {}): TimelineEntry[] {
    const where: string[] = []
    const params: (string | number)[] = []
    if (q.since !== undefined) (where.push("at >= ?"), params.push(q.since))
    if (q.until !== undefined) (where.push("at <= ?"), params.push(q.until))
    if (q.room !== undefined) (where.push("room = ?"), params.push(q.room))
    if (q.runId !== undefined) (where.push("run_id = ?"), params.push(q.runId))
    if (q.types?.length) {
      where.push(`type IN (${q.types.map(() => "?").join(",")})`)
      params.push(...q.types)
    }
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : ""
    if (q.limit !== undefined) {
      const rows = this.db
        .prepare(`SELECT * FROM entries ${clause} ORDER BY seq DESC LIMIT ?`)
        .all(...params, Math.max(0, Math.floor(q.limit))) as unknown as Row[]
      return rows.reverse().map(toEntry)
    }
    return (this.db.prepare(`SELECT * FROM entries ${clause} ORDER BY seq ASC`).all(...params) as unknown as Row[]).map(toEntry)
  }

  lastSeq(): number {
    const row = this.db.prepare("SELECT MAX(seq) AS seq FROM entries").get() as { seq: number | null }
    return row.seq ?? 0
  }

  // ───────────── runs ─────────────

  startRun(run: RunInfo): void {
    this.db
      .prepare("INSERT INTO runs (id, focus_room, started_at) VALUES (?, ?, ?)")
      .run(run.id, run.focusRoom?.id ?? null, run.startedAt)
  }

  endRun(id: string, status: RunStatus, endedAt = Date.now()): void {
    this.db.prepare("UPDATE runs SET ended_at = ?, status = ? WHERE id = ?").run(endedAt, status, id)
  }

  getRun(id: string): { id: string; focusRoom?: string; startedAt: number; endedAt?: number; status?: RunStatus } | undefined {
    const row = this.db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as
      | { id: string; focus_room: string | null; started_at: number; ended_at: number | null; status: RunStatus | null }
      | undefined
    if (!row) return undefined
    return {
      id: row.id,
      startedAt: row.started_at,
      ...(row.focus_room === null ? {} : { focusRoom: row.focus_room }),
      ...(row.ended_at === null ? {} : { endedAt: row.ended_at }),
      ...(row.status === null ? {} : { status: row.status }),
    }
  }

  /** 把未结束的 Run 标为 interrupted，返回其 id（启动恢复，§7.4）。 */
  markInterruptedRuns(now = Date.now()): string[] {
    const rows = this.db.prepare("SELECT id FROM runs WHERE ended_at IS NULL").all() as { id: string }[]
    if (rows.length > 0) {
      this.db.prepare("UPDATE runs SET ended_at = ?, status = 'interrupted' WHERE ended_at IS NULL").run(now)
    }
    return rows.map((r) => r.id)
  }

  // ───────────── 重建上下文（§7.3） ─────────────

  latestCompaction(): (TimelineEntry & { data: CompactionData }) | undefined {
    const row = this.db.prepare("SELECT * FROM entries WHERE type = 'compaction' ORDER BY seq DESC LIMIT 1").get() as
      | Row
      | undefined
    return row ? (toEntry(row) as TimelineEntry & { data: CompactionData }) : undefined
  }

  /**
   * 检查点 system → `<summary>` → firstKeptSeq 之后、compaction 之前的非 system 条目
   * → compaction 之后的全部条目；error / aborted 的 assistant 一律剔除。
   */
  loadContext(): LoadedContext {
    const compaction = this.latestCompaction()
    const fromSeq = compaction ? Math.min(compaction.data.firstKeptSeq, compaction.seq) : 0
    const rows = (this.db.prepare("SELECT * FROM entries WHERE seq >= ? ORDER BY seq ASC").all(fromSeq) as unknown as Row[]).map(toEntry)

    const messages: AgentMessage[] = []
    const entries: TimelineEntry[] = []
    const push = (entry: TimelineEntry) => {
      if (isFailedAssistant(entry)) return
      const message = entryToMessage(entry)
      if (!message) return
      messages.push(message)
      if (entry.type !== "system") entries.push(entry)
    }

    if (!compaction) {
      for (const entry of rows) push(entry)
      return { messages, entries, previousSummary: undefined, missingCheckpoint: false }
    }

    const kept = rows.filter((e) => e.seq < compaction.seq && e.type !== "system")
    const after = rows.filter((e) => e.seq > compaction.seq)
    const summary: AgentMessage = { role: "summary", summary: compaction.data.summary, timestamp: compaction.at }
    // compaction 之后的第一条 system 必为全量检查点（缺失时启动恢复会补写）
    const checkpointIndex = after.findIndex((e) => e.type === "system")
    const checkpoint = checkpointIndex >= 0 ? after.splice(checkpointIndex, 1)[0] : undefined
    if (checkpoint) push(checkpoint)
    messages.push(summary)
    for (const entry of kept) push(entry)
    for (const entry of after) push(entry)
    return { messages, entries, previousSummary: compaction.data.summary, missingCheckpoint: !checkpoint }
  }
}

export function roomOf(run: { focusRoom?: RoomRef } | undefined): string | undefined {
  return run?.focusRoom?.id
}
