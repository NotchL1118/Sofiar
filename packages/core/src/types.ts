/**
 * 内核对外的唯一类型来源（docs/architecture.md §3、§7、§8）。
 * 术语以根目录 GLOSSARY.md 为准。
 */
import type { AgentEvent, AgentMessage, AgentTool } from "@earendil-works/pi-agent-core"
import { compile, type JsonSchema } from "@earendil-works/pi-schema"
import type {
  Api,
  AssistantMessage,
  Context,
  ImageContent,
  Model,
  SimpleStreamOptions,
  TextContent,
  ThinkingLevel,
  ToolResultMessage,
} from "@earendil-works/pi-ai"

// ───────────────────────── Signal ─────────────────────────

export interface RoomRef {
  /** Channel id，等于注册它的扩展名，如 "telegram" */
  channel: string
  /** 全局唯一，约定 "<channel>:<kind>:<platformId>" */
  id: string
  label: string
  kind: "direct" | "group"
}

export type SignalPriority = "high" | "normal" | "low"

export type SignalSource =
  | { kind: "room"; room: RoomRef; sender: { id: string; name: string; isOwner: boolean } }
  | { kind: "internal"; from: string; room?: RoomRef }

export interface Signal {
  id: string
  /** epoch ms */
  at: number
  source: SignalSource
  priority: SignalPriority
  content: (TextContent | ImageContent)[]
  notes?: string[]
}

export type SignalInput = Omit<Signal, "id" | "at"> & Partial<Pick<Signal, "id" | "at">>

// ───────────────────── 自定义 AgentMessage ─────────────────────

export interface SignalMessage {
  role: "signal"
  signal: Signal
  timestamp: number
}
export interface RecallMessage {
  role: "recall"
  from: string
  items: string[]
  timestamp: number
}
export interface NoticeMessage {
  role: "notice"
  text: string
  timestamp: number
}
/** 由 compaction 条目派生，只存在于工作上下文，从不落盘。 */
export interface SummaryMessage {
  role: "summary"
  summary: string
  timestamp: number
}

declare module "@earendil-works/pi-agent-core" {
  interface CustomAgentMessages {
    signal: SignalMessage
    recall: RecallMessage
    notice: NoticeMessage
    summary: SummaryMessage
  }
}

// ───────────────────────── Timeline ─────────────────────────

export type EntryType = "system" | "signal" | "recall" | "assistant" | "toolResult" | "notice" | "compaction" | "user"

export interface CompactionData {
  summary: string
  firstKeptSeq: number
  tokensBefore: number
}

export interface TimelineEntry {
  seq: number
  id: string
  at: number
  type: EntryType | (string & {})
  runId?: string
  /** RoomRef.id */
  room?: string
  /** signal → Signal；recall → {from, items}；notice → {text}；compaction → CompactionData；其余为 pi 原生消息 */
  data: unknown
}

export interface TimelineQuery {
  since?: number
  until?: number
  room?: string
  runId?: string
  types?: string[]
  /** 取**最近的** N 条（结果仍按时间正序返回） */
  limit?: number
}

export type RunStatus = "ok" | "error" | "aborted" | "interrupted"

export interface RunInfo {
  id: string
  focusRoom?: RoomRef
  startedAt: number
}

// ───────────────────────── Channel ─────────────────────────

export interface ChannelDef {
  /** 默认 1500 */
  debounceMs?: number
  /** 防抖最长等待，默认 5000 */
  maxWaitMs?: number
  deliver(room: RoomRef, text: string): Promise<void>
  onDelta?(room: RoomRef, delta: string): void
  onRunError?(room: RoomRef, error: Error): void
}

// ───────────────────────── Section ─────────────────────────

export type SectionProvider = (ctx: { reason: "run" | "rebuild" }) => string | null

// ───────────────────────── Hook ─────────────────────────

export type CompactionReason = "threshold" | "overflow" | "manual"

export interface HookMap {
  start: { payload: void; result: void }
  shutdown: { payload: { reason: string }; result: void }
  signal: { payload: Signal; result: Signal | { drop: true } | void }
  run_start: { payload: { run: RunInfo; signals: Signal[] }; result: { recall?: string[] } | void }
  context: { payload: { messages: AgentMessage[] }; result: { messages: AgentMessage[] } | void }
  tool_call: {
    payload: { toolName: string; args: unknown; run: RunInfo }
    result: { block?: true; reason?: string } | void
  }
  tool_result: {
    payload: { toolName: string; args: unknown; result: { content: (TextContent | ImageContent)[]; details: unknown }; isError: boolean }
    result: { content?: (TextContent | ImageContent)[]; details?: unknown; isError?: boolean } | void
  }
  turn_end: { payload: { run: RunInfo; message: AssistantMessage; toolResults: ToolResultMessage[] }; result: void }
  run_end: { payload: { run: RunInfo; entries: TimelineEntry[]; error?: Error }; result: void }
  before_compact: {
    payload: {
      entries: TimelineEntry[]
      previousSummary: string | undefined
      tokensBefore: number
      reason: CompactionReason
      signal: AbortSignal
    }
    result: { summary: string } | { cancel: true } | void
  }
  compacted: { payload: { entries: TimelineEntry[]; summary: string }; result: void }
  deliver: { payload: { room: RoomRef; text: string }; result: { text: string } | { cancel: true } | void }
}

export type HookName = keyof HookMap
export type HookHandler<E extends HookName> = (
  payload: HookMap[E]["payload"],
) => HookMap[E]["result"] | Promise<HookMap[E]["result"]>

// ───────────────────────── 事件流 ─────────────────────────

/**
 * 只读事件流。pi-agent-core 的原始事件（agent_start / turn_start / message_end / tool_execution_end …）
 * 原样进入事件流，内核只在上面补 `at`、`runId`、`turn`；内核自己的事件只描述 pi 不知道的事
 * （Queue、调度、Run、Delivery、Compaction、hook）。两者 `type` 不重名。
 */
export type SofiaEvent = { at: number; runId?: string; /** 所属 Run 内的第几个 Turn（从 1 起） */ turn?: number } & (
  | { type: "signal_received"; signal: Signal }
  | { type: "signal_dropped"; signal: Signal; by: string }
  | { type: "bucket_ready"; bucket: string }
  | { type: "run_scheduled"; candidates: { bucket: string; priority: SignalPriority; earliestAt: number }[]; chosen: string; reason: string }
  | { type: "steered"; signal: Signal }
  | { type: "run_start"; run: RunInfo; signals: number }
  | { type: "run_end"; run: RunInfo; status: RunStatus; error?: string }
  | { type: "llm_request"; model: string; role: string; tokens: number; cost: number; ms?: number; stopReason?: string }
  | { type: "llm_retry"; attempt: number; delayMs: number; error: string }
  | { type: "delivery"; room: string; ok: boolean; error?: string }
  | { type: "section_patch"; sections: string[] }
  | { type: "tools_patch"; added: string[]; removed: string[] }
  | { type: "compaction"; reason: CompactionReason; ok: boolean; tokensBefore: number; tokensAfter?: number; by?: string; error?: string }
  | { type: "hook"; ext: string; event: HookName; ms: number; error?: string }
  | { type: "ext_error"; ext: string; error: string }
  | { type: "log"; ext: string; level: LogLevel; message: string; data?: unknown }
  | AgentEvent
)

export type SofiaEventType = SofiaEvent["type"]
/** 发事件时不必带 `at`（内核补上）。 */
export type SofiaEventInput = SofiaEvent extends infer E ? (E extends { at: number } ? Omit<E, "at"> & { at?: number } : never) : never

export type LogLevel = "debug" | "info" | "warn" | "error"
export interface Logger {
  debug(message: string, data?: unknown): void
  info(message: string, data?: unknown): void
  warn(message: string, data?: unknown): void
  error(message: string, data?: unknown): void
}

// ───────────────────────── 模型 ─────────────────────────

export interface ResolvedModel {
  model: Model<Api>
  thinking?: ThinkingLevel
}

/** 内核访问模型的唯一入口；由 daemon 依据 config.json 的 providers / models 构建。 */
export interface ModelRuntime {
  /** Model Role → 模型；未配置的角色回退到 `main`。 */
  resolve(role: string): ResolvedModel
  stream(model: Model<Api>, context: Context, options?: SimpleStreamOptions): ReturnType<import("@earendil-works/pi-ai").Models["streamSimple"]>
  complete(model: Model<Api>, context: Context, options?: SimpleStreamOptions): Promise<AssistantMessage>
}

// ───────────────────────── Extension ─────────────────────────

export interface ExtensionInfo {
  name: string
  use?: string
  status: "loaded" | "error" | "disabled"
  error?: string
  configSchema?: object
  config?: unknown
}

export interface SofiaConfig {
  providers?: Record<string, unknown>
  models?: Record<string, { provider: string; id: string; thinking?: ThinkingLevel }>
  kernel?: Partial<KernelConfig>
  extensions?: { use: string; enabled?: boolean; config?: unknown }[]
}

export interface KernelConfig {
  /** 单个 Run 的 Turn 上限；null 为不限制 */
  maxTurnsPerRun: number | null
  compaction: { reserveTokens: number; keepRecentTokens: number }
  /** 被 await 的 hook 的超时（ms） */
  hookTimeoutMs: number
  /** before_compact / compacted 的超时（ms） */
  compactHookTimeoutMs: number
  /** LLM 请求在首个内容事件之前失败时的重试 */
  retry: { maxRetries: number; baseDelayMs: number }
}

/** 进程内管理接口，由 daemon 提供。 */
export interface HostAPI {
  extensions(): ExtensionInfo[]
  readConfig(): SofiaConfig
  writeConfig(c: SofiaConfig): void
  restart(): void
}

export interface SofiaAPI<Config = unknown> {
  readonly name: string
  readonly config: Config
  /** 数据目录（SOFIA_HOME）；persona.md、memory.md 等共享文件在这里 */
  readonly home: string
  /** ~/.sofia/ext/<name>/ */
  readonly dataDir: string
  readonly log: Logger
  /** 读取密钥：secrets.json 的键，或同名环境变量；没有则 undefined */
  secret(name: string): string | undefined

  on<E extends HookName>(event: E, handler: HookHandler<E>): () => void
  readonly events: { subscribe(fn: (e: SofiaEvent) => void): () => void }

  registerChannel(def: ChannelDef): void
  /** 返回的 name 为加了 `{扩展名}_` 前缀的全名 */
  registerTool(tool: AgentTool<any>): { name: string; unregister(): void }
  registerSection(name: string, provider: SectionProvider): () => void

  signal(input: SignalInput): void
  complete(role: string, context: Context, opts?: SimpleStreamOptions): Promise<AssistantMessage>

  readonly timeline: { query(q: TimelineQuery): TimelineEntry[] }
  currentRun(): { id: string; focusRoom?: RoomRef } | undefined
  abortRun(reason?: string): void
  compact(reason?: string): void

  readonly host: HostAPI
}

export interface ExtensionDef<Config = unknown> {
  name: string
  configSchema?: object
  setup(sofia: SofiaAPI<Config>): void | Promise<void>
}

export const EXTENSION_NAME_RE = /^[a-z][a-z0-9-]{0,23}$/
export const SECTION_NAME_RE = /^[a-z][a-z0-9_:-]*$/
export const TOOL_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/

/** 按扩展的 configSchema（JSON Schema）校验配置；返回问题列表，空数组表示通过。 */
export function validateExtensionConfig(schema: object | undefined, config: unknown): string[] {
  if (!schema) return []
  try {
    return compile(schema as JsonSchema)
      .errors(config ?? {})
      .map((e) => `${e.path || "(root)"}: ${e.message}`)
  } catch (e) {
    return [`invalid configSchema: ${e instanceof Error ? e.message : String(e)}`]
  }
}

export function defineExtension<Config = unknown>(def: ExtensionDef<Config>): ExtensionDef<Config> {
  return def
}
