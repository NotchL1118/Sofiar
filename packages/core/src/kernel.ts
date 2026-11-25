/**
 * 内核：Queue 与调度、Run 生命周期、Delivery、Compaction 的触发与记账、Hook 分发。
 * pi-agent-core 的 `Agent` 只在本模块内被接触（docs/architecture.md §2.4）。
 *
 * 内核没有任何"功能"——人设、记忆、压缩策略、Channel 全部是 Extension。
 */
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { Agent, type AgentEvent, type AgentMessage, type AgentTool } from "@earendil-works/pi-agent-core"
import {
  type AssistantMessage,
  getCurrentSystemMessage,
  getToolStateChanges,
  isContextOverflow,
  type SystemMessage,
  toToolDeclaration,
  uuidv7,
} from "@earendil-works/pi-ai"
import { estimateContextTokens, findCut } from "./compaction.ts"
import { EventBus, HookBus } from "./hooks.ts"
import { bucketKey, type Pick, SignalQueue } from "./queue.ts"
import { convertToLlm, couldBecomeSilence, isSilence, KERNEL_SECTION, notices } from "./render.ts"
import { withRetry } from "./stream.ts"
import { type LoadedContext, messageToEntry, Timeline } from "./timeline.ts"
import {
  type ChannelDef,
  type CompactionReason,
  EXTENSION_NAME_RE,
  type ExtensionDef,
  type ExtensionInfo,
  type HostAPI,
  type KernelConfig,
  type Logger,
  type LogLevel,
  type ModelRuntime,
  type RoomRef,
  type RunInfo,
  type RunStatus,
  SECTION_NAME_RE,
  type SectionProvider,
  type Signal,
  type SignalInput,
  type SofiaAPI,
  type SofiaConfig,
  type SofiaEvent,
  TOOL_NAME_RE,
  validateExtensionConfig,
} from "./types.ts"

export const DEFAULT_KERNEL_CONFIG: KernelConfig = {
  maxTurnsPerRun: null,
  compaction: { reserveTokens: 16384, keepRecentTokens: 20000 },
  hookTimeoutMs: 10_000,
  compactHookTimeoutMs: 120_000,
  retry: { maxRetries: 3, baseDelayMs: 1000 },
}

const DEFAULT_DEBOUNCE_MS = 1500
const DEFAULT_MAX_WAIT_MS = 5000
const KERNEL = "kernel"

export interface KernelOptions {
  /** 数据目录（SOFIA_HOME） */
  home: string
  /** 默认 `<home>/timeline.db`；测试可传 ":memory:" */
  dbPath?: string
  models: ModelRuntime
  config?: SofiaConfig["kernel"]
  /** 有序：顺序决定 hook 执行顺序与 Section 顺序 */
  extensions?: { def: ExtensionDef<any>; config?: unknown; use?: string }[]
  host?: HostAPI
  /** 密钥查询（daemon 提供：secrets.json 或同名环境变量） */
  secrets?: (name: string) => string | undefined
}

interface ActiveRun {
  info: RunInfo
  /** 同 Room 的 Signal 此时可经 agent.steer() 注入 */
  steerable: boolean
  aborted: string | undefined
  turn: number
  turnsDone: number
  turnLimitHit: boolean
  /** 当前 loop 上下文中，第一条可使用主模型 usage 的消息下标。 */
  usageStartIndex: number
  lastAssistant: AssistantMessage | undefined
  /** 当前 assistant 消息的流式文本与是否已放行（Silence Token 前缀扣留） */
  stream: { text: string; released: boolean }
  /** Run 收尾阶段到达的 notice，Run 结束后直接写入 Timeline */
  pendingNotices: string[]
}

interface ToolReg {
  ext: string
  order: number
  seq: number
  tool: AgentTool<any>
}

interface SectionReg {
  ext: string
  order: number
  seq: number
  name: string
  provider: SectionProvider
}

const toError = (e: unknown): Error => (e instanceof Error ? e : new Error(String(e)))

export class Kernel {
  readonly events = new EventBus()
  readonly timeline: Timeline

  private readonly cfg: KernelConfig
  private readonly hooks = new HookBus(this.events)
  private readonly queue = new SignalQueue((key) => {
    this.events.emit({ type: "bucket_ready", bucket: key })
    this.schedule()
  })
  private readonly agent: Agent
  private readonly channels = new Map<string, ChannelDef>()
  private readonly tools = new Map<string, ToolReg>()
  private readonly sections: SectionReg[] = []
  private readonly extensions: ExtensionInfo[] = []
  private regSeq = 0

  private run: ActiveRun | undefined
  private compacting = false
  private compactAbort: AbortController | undefined
  private pendingCompact = false
  private started = false
  private stopping = false
  /** Signal 入队前的 `signal` hook 是异步的；串成一条链以保持到达顺序 */
  private intake: Promise<void> = Promise.resolve()
  private readonly deliveries = new Map<string, Promise<void>>()
  private idleWaiters: (() => void)[] = []

  private readonly options: KernelOptions

  constructor(options: KernelOptions) {
    this.options = options
    this.cfg = {
      ...DEFAULT_KERNEL_CONFIG,
      ...options.config,
      compaction: { ...DEFAULT_KERNEL_CONFIG.compaction, ...options.config?.compaction },
      retry: { ...DEFAULT_KERNEL_CONFIG.retry, ...options.config?.retry },
    }
    this.events.stamp = () => {
      const run = this.run
      return run ? { runId: run.info.id, ...(run.turn > 0 ? { turn: run.turn } : {}) } : {}
    }
    mkdirSync(options.home, { recursive: true })
    this.timeline = new Timeline(options.dbPath ?? join(options.home, "timeline.db"))
    this.sections.push({ ext: KERNEL, order: -1, seq: this.regSeq++, name: KERNEL, provider: () => KERNEL_SECTION })

    this.agent = new Agent({
      streamFn: withRetry(
        (model, context, opts) => options.models.stream(model, context, opts),
        this.cfg.retry,
        (info) => this.emit({ type: "llm_retry", ...info }),
      ),
      convertToLlm,
      steeringMode: "all",
      transformContext: async (messages) => {
        let current = messages
        await this.hooks.run("context", () => ({ messages: current.slice() }), {
          timeoutMs: this.cfg.hookTimeoutMs,
          onResult: (r) => {
            if (Array.isArray(r.messages)) current = r.messages
          },
        })
        return current
      },
      beforeToolCall: async (ctx) => {
        const run = this.run
        if (!run) return undefined
        let blocked: { block: true; reason?: string } | undefined
        await this.hooks.run("tool_call", () => ({ toolName: ctx.toolCall.name, args: ctx.args, run: run.info }), {
          timeoutMs: this.cfg.hookTimeoutMs,
          onResult: (r) => {
            if (!r.block) return
            blocked = { block: true, ...(r.reason === undefined ? {} : { reason: r.reason }) }
            return "stop"
          },
        })
        return blocked
      },
      afterToolCall: async (ctx) => {
        let result = { content: ctx.result.content, details: ctx.result.details as unknown }
        let isError = ctx.isError
        let changed = false
        await this.hooks.run("tool_result", () => ({ toolName: ctx.toolCall.name, args: ctx.args, result, isError }), {
          timeoutMs: this.cfg.hookTimeoutMs,
          onResult: (r) => {
            changed = true
            result = { content: r.content ?? result.content, details: r.details ?? result.details }
            isError = r.isError ?? isError
          },
        })
        return changed ? { content: result.content, details: result.details, isError } : undefined
      },
      finishTurn: (turn) => {
        const run = this.run
        const max = this.cfg.maxTurnsPerRun
        if (!run || max === null) return undefined
        run.turnsDone++
        const failed = turn.message.stopReason === "error" || turn.message.stopReason === "aborted"
        const wouldContinue = turn.toolResults.length > 0 || this.agent.hasQueuedMessages()
        if (failed || run.turnsDone < max || !wouldContinue) return undefined
        run.turnLimitHit = true
        return { action: "end" }
      },
      prepareNextTurnWithContext: async (turn) => {
        const run = this.run
        if (!run || run.aborted !== undefined) return undefined
        // loop 确定还要继续时，把攒下的旁白带进下一个 Turn（不为它额外催生 Turn）
        const messages: AgentMessage[] = run.pendingNotices
          .splice(0)
          .map((text) => ({ role: "notice", text, timestamp: Date.now() }))
        const rebuilt = this.overThreshold(turn.context.messages, run.usageStartIndex) && (await this.compact("threshold"))
        if (!rebuilt) return messages.length > 0 ? { messages } : undefined
        run.usageStartIndex = rebuilt.usageStartIndex
        return { context: { messages: rebuilt.messages, tools: turn.context.tools ?? [] }, messages }
      },
    })
    this.agent.subscribe((event) => this.onAgentEvent(event))
  }

  // ═══════════════════════════ 生命周期 ═══════════════════════════

  /** 启动恢复（§7.4）→ 扩展 setup → system 状态对齐 → `start` hook → 开始调度。 */
  async start(): Promise<void> {
    if (this.started) return
    const interrupted = this.timeline.markInterruptedRuns()
    const lastInterrupted = interrupted[interrupted.length - 1]
    if (lastInterrupted !== undefined) {
      this.timeline.append({ type: "notice", data: { text: notices.interrupted() }, runId: lastInterrupted })
    }

    for (const [index, ext] of (this.options.extensions ?? []).entries()) await this.setupExtension(index, ext)

    const ctx = this.timeline.loadContext()
    if (ctx.missingCheckpoint) {
      this.writeCheckpoint(ctx.messages, undefined)
    } else {
      const patch = this.systemPatch("rebuild", ctx.messages)
      if (patch) this.persist(patch, undefined)
    }

    await this.hooks.run("start", () => undefined, { timeoutMs: this.cfg.hookTimeoutMs })
    this.started = true
    this.schedule()
  }

  /** 中止当前 Run、触发 `shutdown`、关闭 Timeline。排队中的 Signal 丢失（§7.4）。 */
  async stop(reason = "stop"): Promise<void> {
    if (this.stopping) return
    this.stopping = true
    this.queue.clear()
    if (this.run) this.abortRun("shutdown")
    else this.compactAbort?.abort()
    while (this.run || this.compacting) await new Promise<void>((resolve) => this.idleWaiters.push(resolve))
    await Promise.allSettled([...this.deliveries.values()])
    await this.hooks.run("shutdown", () => ({ reason }), { timeoutMs: this.cfg.hookTimeoutMs })
    this.timeline.close()
  }

  /** 等到没有 Run、没有压缩、没有就绪桶且投递都已落定。仍在防抖中的桶不算。 */
  async whenIdle(): Promise<void> {
    for (;;) {
      const intake = this.intake
      await intake
      await Promise.allSettled([...this.deliveries.values()])
      if (intake !== this.intake) continue
      if (!this.run && !this.compacting && !this.pendingCompact && !this.queue.hasReady()) return
      await new Promise<void>((resolve) => this.idleWaiters.push(resolve))
    }
  }

  currentRun(): { id: string; focusRoom?: RoomRef } | undefined {
    const info = this.run?.info
    return info ? { id: info.id, ...(info.focusRoom ? { focusRoom: info.focusRoom } : {}) } : undefined
  }

  /** 中止当前 Run；无 Run 时无操作（§5.5）。 */
  abortRun(reason = "owner"): void {
    const run = this.run
    if (!run || run.aborted !== undefined) return
    run.aborted = reason
    this.compactAbort?.abort()
    this.agent.abort()
  }

  /** 请求压缩：空闲时立即执行，否则在当前 Run 结束后、下一个 Run 开始前执行（§7.3）。 */
  requestCompact(): void {
    this.pendingCompact = true
    this.schedule()
  }

  // ═══════════════════════════ Signal 入口与调度 ═══════════════════════════

  signal(input: SignalInput): void {
    const signal: Signal = { ...input, id: input.id ?? uuidv7(), at: input.at ?? Date.now() }
    this.intake = this.intake.then(() => this.admit(signal)).catch((e) => this.kernelError(e))
  }

  private async admit(initial: Signal): Promise<void> {
    if (this.stopping) return
    let signal = initial
    let droppedBy: string | undefined
    await this.hooks.run("signal", () => signal, {
      timeoutMs: this.cfg.hookTimeoutMs,
      onResult: (r, ext) => {
        if ("drop" in r) {
          if (!r.drop) return
          droppedBy = ext
          return "stop"
        }
        signal = r
      },
    })
    if (droppedBy !== undefined) return this.emit({ type: "signal_dropped", signal, by: droppedBy })
    this.emit({ type: "signal_received", signal })

    const run = this.run
    const room = signal.source.room
    if (run?.steerable && room && run.info.focusRoom?.id === room.id) {
      this.agent.steer({ role: "signal", signal, timestamp: signal.at })
      this.emit({ type: "steered", signal })
      return
    }
    const channel = room ? this.channels.get(room.channel) : undefined
    this.queue.add(signal, {
      debounceMs: room ? (channel?.debounceMs ?? DEFAULT_DEBOUNCE_MS) : 0,
      maxWaitMs: channel?.maxWaitMs ?? DEFAULT_MAX_WAIT_MS,
    })
  }

  /** 唯一的"思考流"空闲时，选择下一件事：待办的压缩优先，其次是就绪桶（§4.2）。 */
  private schedule(): void {
    if (this.run || this.compacting) return
    if (!this.started || this.stopping) return this.wakeIdleWaiters()
    if (this.pendingCompact) {
      this.pendingCompact = false
      this.compacting = true
      void this.compact("manual")
        .catch((e) => this.kernelError(e))
        .finally(() => {
          this.compacting = false
          this.schedule()
        })
      return
    }
    const pick = this.queue.take()
    if (!pick) return this.wakeIdleWaiters()
    this.emit({ type: "run_scheduled", candidates: pick.candidates, chosen: pick.key, reason: pick.reason })
    void this.executeRun(pick)
      .catch((e) => this.kernelError(e))
      .finally(() => {
        this.run = undefined
        this.schedule()
      })
  }

  private wakeIdleWaiters(): void {
    const waiters = this.idleWaiters
    this.idleWaiters = []
    for (const resolve of waiters) resolve()
  }

  // ═══════════════════════════ Run 生命周期（§5） ═══════════════════════════

  private async executeRun(pick: Pick): Promise<void> {
    const info: RunInfo = { id: uuidv7(), startedAt: Date.now(), ...(pick.focusRoom ? { focusRoom: pick.focusRoom } : {}) }
    const run: ActiveRun = {
      info,
      steerable: true,
      aborted: undefined,
      turn: 0,
      turnsDone: 0,
      turnLimitHit: false,
      usageStartIndex: 0,
      lastAssistant: undefined,
      stream: { text: "", released: false },
      pendingNotices: [],
    }
    this.run = run
    this.timeline.startRun(info)
    this.emit({ type: "run_start", run: info, signals: pick.signals.length })

    const signalMessages: AgentMessage[] = pick.signals.map((signal) => ({ role: "signal", signal, timestamp: signal.at }))
    let thrown: Error | undefined
    let prompted = false
    try {
      const main = this.options.models.resolve("main")
      this.agent.state.model = main.model
      this.agent.state.thinkingLevel = main.thinking ?? "off"

      let ctx = this.timeline.loadContext()
      this.agent.state.tools = this.toolList()
      const prompt: AgentMessage[] = []
      let patch = this.systemPatch("run", ctx.messages, this.agent.state.tools)

      await this.hooks.run("run_start", () => ({ run: info, signals: pick.signals }), {
        timeoutMs: this.cfg.hookTimeoutMs,
        onResult: (r, ext) => {
          const items = (r.recall ?? []).filter((item) => typeof item === "string" && item.length > 0)
          if (items.length > 0) prompt.push({ role: "recall", from: ext, items, timestamp: Date.now() })
        },
      })
      prompt.push(...signalMessages)

      const candidate = patch ? [...ctx.messages, patch, ...prompt] : [...ctx.messages, ...prompt]
      if (run.aborted === undefined && this.overThreshold(candidate, ctx.usageStartIndex)) {
        const rebuilt = await this.compact("threshold")
        if (rebuilt) {
          ctx = rebuilt
          // compacted 可更新 Section；旧补丁只能用于估算，发送时以新检查点为准。
          patch = this.systemPatch("run", ctx.messages, this.agent.state.tools)
        }
      }
      if (run.aborted === undefined) {
        run.usageStartIndex = ctx.usageStartIndex
        this.agent.state.messages = ctx.messages
        if (patch) prompt.unshift(patch)
        prompted = true
        await this.agent.prompt(prompt)
        await this.recoverFromOverflow(run, main.model.contextWindow)
      }
    } catch (e) {
      thrown = toError(e)
    }
    // Run 还没进入 loop 就结束时，已消费的 Signal 由内核直接落盘（它们不会重新入队）
    if (!prompted) for (const message of signalMessages) this.persist(message, run)

    await this.finishRun(run, thrown)
  }

  /** 溢出是硬退出：强制压缩 → 重建 → continue() 重试一次，仍属同一个 Run（§7.3）。 */
  private async recoverFromOverflow(run: ActiveRun, contextWindow: number): Promise<void> {
    const last = run.lastAssistant
    if (!last || last.stopReason !== "error" || run.aborted !== undefined) return
    if (!isContextOverflow(last, contextWindow)) return
    const rebuilt = await this.compact("overflow")
    if (!rebuilt || run.aborted !== undefined) return
    const tail = rebuilt.messages.at(-1)
    if (!tail || tail.role === "assistant" || rebuilt.messages.every((m) => m.role === "system")) return
    run.usageStartIndex = rebuilt.usageStartIndex
    this.agent.state.messages = rebuilt.messages
    run.lastAssistant = undefined
    await this.agent.continue()
  }

  private async finishRun(run: ActiveRun, thrown: Error | undefined): Promise<void> {
    const { info } = run
    const room = info.focusRoom

    // §4.4：最后一次轮询之后才到达的 steer。此后同 Room 的 Signal 改走 Queue。
    run.steerable = false
    const residual = this.agent.hasQueuedMessages() ? this.agent.peekQueuedMessages() : []
    this.agent.clearSteeringQueue()

    const last = run.lastAssistant
    let status: RunStatus = "ok"
    let error: Error | undefined
    let notice: string | undefined
    if (run.aborted !== undefined || last?.stopReason === "aborted") {
      status = "aborted"
      notice = run.aborted === "shutdown" ? notices.interrupted() : notices.aborted()
    } else if (thrown || last?.stopReason === "error") {
      status = "error"
      error = thrown ?? new Error(last?.errorMessage ?? "unknown error")
      notice = notices.runFailed(room, error.message)
    } else if (run.turnLimitHit) {
      status = "error"
      error = new Error(`turn limit reached (${this.cfg.maxTurnsPerRun})`)
      notice = notices.turnLimit(room)
    }

    const requeue: Signal[] = []
    for (const message of residual) {
      if (message.role === "signal" && status !== "aborted") requeue.push(message.signal)
    }
    if (notice !== undefined) run.pendingNotices.unshift(notice)
    this.flushNotices(run)

    this.timeline.endRun(info.id, status)
    this.emit({ type: "run_end", run: info, status, ...(error ? { error: error.message } : {}) })
    await this.hooks.run(
      "run_end",
      () => ({ run: info, entries: this.timeline.query({ runId: info.id }), ...(error ? { error } : {}) }),
      { timeoutMs: this.cfg.hookTimeoutMs },
    )
    if (status === "error" && room && error) {
      try {
        this.channels.get(room.channel)?.onRunError?.(room, error)
      } catch (e) {
        this.extError(room.channel, e)
      }
    }
    this.flushNotices(run)
    this.queue.requeue(requeue)
  }

  private flushNotices(run: ActiveRun): void {
    for (const text of run.pendingNotices.splice(0)) {
      this.timeline.append({ type: "notice", data: { text }, runId: run.info.id, ...(run.info.focusRoom ? { room: run.info.focusRoom.id } : {}) })
    }
  }

  /**
   * 把一条旁白告诉她：Run 进行中先攒着——loop 还要继续就随下一个 Turn 注入，否则在 Run 结束时写入；
   * 没有 Run 时直接写入 Timeline。从不为此唤醒新 Run 或催生额外的 Turn。
   */
  private notify(text: string, room: RoomRef): void {
    const run = this.run
    if (run) run.pendingNotices.push(text)
    else if (!this.stopping) this.timeline.append({ type: "notice", data: { text }, room: room.id })
  }

  // ═══════════════════════════ pi-agent-core 事件 ═══════════════════════════

  private async onAgentEvent(event: AgentEvent): Promise<void> {
    const run = this.run
    if (!run) return
    switch (event.type) {
      case "turn_start":
        run.turn++
        break
      case "message_start":
        if (event.message.role === "assistant") run.stream = { text: "", released: false }
        break
      case "message_update": {
        const e = event.assistantMessageEvent
        if (e.type === "text_start" && run.stream.text.length > 0) this.streamDelta(run, "\n")
        else if (e.type === "text_delta") this.streamDelta(run, e.delta)
        break
      }
      case "message_end":
        // Run 进行中，消息只在这里落盘（§5.1）
        this.persist(event.message, run)
        if (event.message.role === "assistant") await this.onAssistantMessage(run, event.message)
        break
      case "turn_end": {
        const message = event.message
        if (message.role === "assistant") {
          await this.hooks.run("turn_end", () => ({ run: run.info, message, toolResults: event.toolResults }), {
            timeoutMs: this.cfg.hookTimeoutMs,
          })
        }
        break
      }
    }
    this.emit(event) // pi 原始事件原样广播，emit 补上 runId 与 turn
  }

  private persist(message: AgentMessage, run: ActiveRun | undefined): void {
    const entry = messageToEntry(message)
    if (!entry) return
    const room = entry.room ?? run?.info.focusRoom?.id
    this.timeline.append({
      type: entry.type,
      data: entry.data,
      ...(run ? { runId: run.info.id } : {}),
      ...(room === undefined ? {} : { room }),
    })
    if (message.role === "system") {
      if (message.sections) this.emit({ type: "section_patch", sections: Object.keys(message.sections) })
      if (message.toolsAdded?.length || message.toolsRemoved?.length) {
        this.emit({
          type: "tools_patch",
          added: (message.toolsAdded ?? []).map((t) => t.name),
          removed: (message.toolsRemoved ?? []).map((t) => t.name),
        })
      }
    }
  }

  // ═══════════════════════════ Delivery（§5.2，ADR-0004） ═══════════════════════════

  private async onAssistantMessage(run: ActiveRun, message: AssistantMessage): Promise<void> {
    run.lastAssistant = message
    this.emit({
      type: "llm_request",
      model: message.model,
      role: "main",
      tokens: message.usage.totalTokens,
      cost: message.usage.cost.total,
      stopReason: message.stopReason,
      ...(message.durationMs === undefined ? {} : { ms: message.durationMs }),
    })
    // error / aborted 的回复不进入上下文，也不投递——她不该说了自己不记得的话
    if (message.stopReason === "error" || message.stopReason === "aborted") return
    const room = run.info.focusRoom
    if (!room) return
    let text = message.content
      .flatMap((block) => (block.type === "text" ? [block.text] : []))
      .join("\n")
      .trim()
    if (text === "" || isSilence(text)) return

    let cancelled = false
    await this.hooks.run("deliver", () => ({ room, text }), {
      timeoutMs: this.cfg.hookTimeoutMs,
      onResult: (r) => {
        if ("cancel" in r) {
          if (!r.cancel) return
          cancelled = true
          return "stop"
        }
        if (typeof r.text === "string") text = r.text
      },
    })
    if (cancelled || text.trim() === "") return
    this.deliver(room, text)
  }

  /** 不 await：同一 Room 的投递串成一条 Promise 链，保证先说的先到。 */
  private deliver(room: RoomRef, text: string): void {
    const channel = this.channels.get(room.channel)
    const previous = this.deliveries.get(room.id) ?? Promise.resolve()
    const next = previous
      .then(() => {
        if (!channel) throw new Error(`no channel "${room.channel}"`)
        return channel.deliver(room, text)
      })
      .then(
        () => this.emit({ type: "delivery", room: room.id, ok: true }),
        (e) => {
          this.emit({ type: "delivery", room: room.id, ok: false, error: toError(e).message })
          this.notify(notices.deliveryFailed(room), room)
        },
      )
      .finally(() => {
        if (this.deliveries.get(room.id) === next) this.deliveries.delete(room.id)
      })
    this.deliveries.set(room.id, next)
  }

  /** 流式转发文本增量；仍可能是 Silence Token 前缀时先扣住。 */
  private streamDelta(run: ActiveRun, delta: string): void {
    const room = run.info.focusRoom
    const channel = room && this.channels.get(room.channel)
    if (!room || !channel?.onDelta) return
    const stream = run.stream
    stream.text += delta
    let out = delta
    if (!stream.released) {
      if (couldBecomeSilence(stream.text)) return
      stream.released = true
      out = stream.text
    }
    try {
      channel.onDelta(room, out)
    } catch (e) {
      this.extError(room.channel, e)
    }
  }

  // ═══════════════════════════ Section 与工具（§6） ═══════════════════════════

  private toolList(): AgentTool<any>[] {
    return [...this.tools.values()].sort((a, b) => a.order - b.order || a.seq - b.seq).map((r) => r.tool)
  }

  /** 调用所有 Section provider，得到目标内容（按 kernel → 扩展顺序 → 注册顺序）。 */
  private computeSections(reason: "run" | "rebuild", current: Record<string, string | null>): Record<string, string> {
    const target: Record<string, string> = {}
    for (const reg of [...this.sections].sort((a, b) => a.order - b.order || a.seq - b.seq)) {
      let value: string | null
      try {
        value = reg.provider({ reason })
      } catch (e) {
        this.extError(reg.ext, e)
        value = current[reg.name] ?? null // provider 出错时保持现状，不产生补丁
      }
      if (typeof value === "string") target[reg.name] = value
    }
    return target
  }

  /** 计算本次请求的 Section 与工具增量，供 token 估算和实际发送共用。 */
  private systemPatch(reason: "run" | "rebuild", messages: AgentMessage[], tools?: AgentTool<any>[]): SystemMessage | undefined {
    const system = getCurrentSystemMessage(messages)
    const current = system?.sections ?? {}
    const target = this.computeSections(reason, current)
    const patch: Record<string, string | null> = {}
    for (const [name, value] of Object.entries(target)) if (current[name] !== value) patch[name] = value
    for (const name of Object.keys(current)) if (!(name in target) && current[name] !== null) patch[name] = null
    const { toolsAdded, toolsRemoved } = getToolStateChanges(system?.toolsAdded ?? [], (tools ?? this.toolList()).map(toToolDeclaration))
    const hasSections = Object.keys(patch).length > 0
    if (!hasSections && toolsAdded.length === 0 && toolsRemoved.length === 0) return undefined
    return {
      role: "system",
      content: "",
      ...(hasSections ? { sections: patch } : {}),
      ...(toolsAdded.length > 0 ? { toolsAdded } : {}),
      ...(toolsRemoved.length > 0 ? { toolsRemoved } : {}),
      timestamp: Date.now(),
    }
  }

  /** 全量 system 检查点：Compaction 之后、重建上下文的第一条。 */
  private writeCheckpoint(messages: AgentMessage[], run: ActiveRun | undefined): void {
    const current = getCurrentSystemMessage(messages)?.sections ?? {}
    // Run 进行中工具集不变，沿用本 Run 的；Run 之间取注册表当前内容
    const tools = (run ? this.agent.state.tools : this.toolList()).map(toToolDeclaration)
    const checkpoint: SystemMessage = {
      role: "system",
      content: "",
      sections: this.computeSections("rebuild", current),
      ...(tools.length > 0 ? { toolsAdded: tools } : {}),
      timestamp: Date.now(),
    }
    this.persist(checkpoint, run)
  }

  // ═══════════════════════════ Compaction（§7.3） ═══════════════════════════

  private compactionBudget() {
    const model = this.run ? this.agent.state.model : this.options.models.resolve("main").model
    const config = this.cfg.compaction
    const override = config.modelOverrides?.[`${model.provider}/${model.id}`]
    return {
      contextWindow: model.contextWindow,
      reserveTokens: override?.reserveTokens ?? config.reserveTokens,
      keepRecentTokens: override?.keepRecentTokens ?? config.keepRecentTokens,
    }
  }

  private overThreshold(messages: readonly AgentMessage[], usageStartIndex: number): boolean {
    const { contextWindow, reserveTokens } = this.compactionBudget()
    if (!contextWindow || contextWindow <= 0) return false
    return estimateContextTokens(messages, usageStartIndex) > contextWindow - reserveTokens
  }

  /** 触发与记账；摘要由 `before_compact` 提供。成功时返回重建后的上下文。 */
  private async compact(reason: CompactionReason): Promise<LoadedContext | undefined> {
    const run = this.run
    const ctx = this.timeline.loadContext()
    const tokensBefore = estimateContextTokens(ctx.messages, ctx.usageStartIndex)
    const fail = (error: string, by?: string) => {
      this.emit({ type: "compaction", reason, ok: false, tokensBefore, error, ...(by === undefined ? {} : { by }) })
      return undefined
    }

    let cut = findCut(ctx.entries, this.compactionBudget().keepRecentTokens)
    const runStart = run ? ctx.entries.findIndex((e) => e.runId === run.info.id) : -1
    if (runStart >= 0 && cut > runStart) {
      // 保住待回答的首批输入，或最近的 assistant 及其全部工具结果、后续输入。
      const lastAssistant = ctx.entries.findLastIndex((e) => e.type === "assistant")
      cut = Math.min(cut, Math.max(runStart, lastAssistant))
    }
    if (cut === 0) return fail("nothing to compact")
    let entries = ctx.entries.slice(0, cut)
    let firstKeptSeq = ctx.entries[cut]?.seq ?? this.timeline.lastSeq() + 1

    const abort = new AbortController()
    this.compactAbort = abort
    let summary: string | undefined
    let by: string | undefined
    let cancelledBy: string | undefined
    let outcome
    try {
      outcome = await this.hooks.run(
        "before_compact",
        (signal) => ({ entries, previousSummary: ctx.previousSummary, tokensBefore, reason, signal }),
        {
          timeoutMs: this.cfg.compactHookTimeoutMs,
          signal: abort.signal,
          onResult: (r, ext) => {
            if ("cancel" in r) {
              if (!r.cancel) return
              cancelledBy = ext
              return "stop"
            }
            if (typeof r.summary !== "string") return
            summary = r.summary
            by = ext
            return "stop"
          },
        },
      )
    } finally {
      this.compactAbort = undefined
    }
    if (abort.signal.aborted) return fail("aborted")
    if (cancelledBy !== undefined) return fail("cancelled", cancelledBy)
    if (summary === undefined) {
      // 摘要失败：本次不压缩、上下文不变，下一个检查点自然会再次触发
      if (outcome.failed > 0) return fail(outcome.errors.join("; "))
      // 旧摘要没有记录当前 Run，兜底时只能丢弃更早的 Run。
      if (runStart >= 0 && cut > runStart) {
        if (runStart === 0) return fail("nothing to compact")
        entries = ctx.entries.slice(0, runStart)
        firstKeptSeq = ctx.entries[runStart]!.seq
      }
      summary = ctx.previousSummary ?? ""
    }

    this.timeline.append({
      type: "compaction",
      data: { summary, firstKeptSeq, tokensBefore },
      ...(run ? { runId: run.info.id } : {}),
    })
    // 内核 await 全部 handler，这样其中更新的内容（如 memory.md）在 rebuild 时立即生效
    const finalSummary = summary
    await this.hooks.run("compacted", () => ({ entries, summary: finalSummary }), { timeoutMs: this.cfg.compactHookTimeoutMs })
    this.writeCheckpoint(ctx.messages, run)

    const rebuilt = this.timeline.loadContext()
    const tokensAfter = estimateContextTokens(rebuilt.messages, rebuilt.usageStartIndex)
    this.emit({ type: "compaction", reason, ok: true, tokensBefore, tokensAfter, ...(by === undefined ? {} : { by }) })
    return rebuilt
  }

  // ═══════════════════════════ Extension（§8） ═══════════════════════════

  extensionInfos(): ExtensionInfo[] {
    return this.extensions.map((e) => ({ ...e }))
  }

  private async setupExtension(order: number, ext: { def: ExtensionDef<any>; config?: unknown; use?: string }): Promise<void> {
    const name = ext.def?.name
    const info: ExtensionInfo = {
      name: String(name),
      status: "loaded",
      ...(ext.use === undefined ? {} : { use: ext.use }),
      ...(ext.def?.configSchema ? { configSchema: ext.def.configSchema } : {}),
      config: ext.config,
    }
    this.extensions.push(info)
    const reject = (error: string) => {
      info.status = "error"
      info.error = error
      this.emit({ type: "ext_error", ext: info.name, error })
    }
    if (typeof name !== "string" || !EXTENSION_NAME_RE.test(name)) return reject(`invalid extension name: ${String(name)}`)
    if (this.extensions.some((e) => e !== info && e.name === name && e.status === "loaded")) {
      return reject(`duplicate extension name: ${name}`)
    }
    const problems = validateExtensionConfig(ext.def.configSchema, ext.config)
    if (problems.length > 0) return reject(`invalid config: ${problems.join("; ")}`)
    try {
      await ext.def.setup(this.createApi(name, order, ext.config ?? (ext.def.configSchema ? {} : undefined)))
    } catch (e) {
      reject(toError(e).message)
    }
  }

  private createApi(name: string, order: number, config: unknown): SofiaAPI<any> {
    const dataDir = join(this.options.home, "ext", name)
    const kernel = this
    const log = (level: LogLevel) => (message: string, data?: unknown) =>
      this.emit({ type: "log", ext: name, level, message, ...(data === undefined ? {} : { data }) })
    const logger: Logger = { debug: log("debug"), info: log("info"), warn: log("warn"), error: log("error") }
    const host: HostAPI = this.options.host ?? {
      extensions: () => this.extensionInfos(),
      readConfig: () => {
        throw new Error("host.readConfig is provided by the daemon")
      },
      writeConfig: () => {
        throw new Error("host.writeConfig is provided by the daemon")
      },
      restart: () => {
        throw new Error("host.restart is provided by the daemon")
      },
    }

    return {
      name,
      config,
      home: this.options.home,
      get dataDir() {
        mkdirSync(dataDir, { recursive: true })
        return dataDir
      },
      log: logger,
      secret: (key) => this.options.secrets?.(key) || undefined,
      on: (event, handler) => this.hooks.on(name, order, event, handler),
      events: { subscribe: (fn: (e: SofiaEvent) => void) => this.events.subscribe(fn) },

      registerChannel: (def) => {
        if (this.channels.has(name)) this.emit({ type: "ext_error", ext: name, error: "channel already registered; replacing" })
        this.channels.set(name, def)
      },
      registerTool: (tool) => {
        const fullName = `${name}_${tool.name}`
        if (!TOOL_NAME_RE.test(fullName)) {
          this.emit({ type: "ext_error", ext: name, error: `invalid tool name: ${fullName}` })
          return { name: fullName, unregister: () => {} }
        }
        const reg: ToolReg = { ext: name, order, seq: this.regSeq++, tool: { ...tool, name: fullName } }
        this.tools.set(fullName, reg) // 同一扩展重复注册同名工具 → 替换旧的
        return {
          name: fullName,
          unregister: () => {
            if (this.tools.get(fullName) === reg) this.tools.delete(fullName)
          },
        }
      },
      registerSection: (sectionName, provider) => {
        if (!SECTION_NAME_RE.test(sectionName) || sectionName === KERNEL) {
          this.emit({ type: "ext_error", ext: name, error: `invalid section name: ${sectionName}` })
          return () => {}
        }
        const existing = this.sections.findIndex((s) => s.name === sectionName)
        if (existing >= 0) {
          if (this.sections[existing]!.ext !== name) {
            this.emit({ type: "ext_error", ext: name, error: `section "${sectionName}" belongs to ${this.sections[existing]!.ext}` })
            return () => {}
          }
          this.sections.splice(existing, 1)
        }
        const reg: SectionReg = { ext: name, order, seq: this.regSeq++, name: sectionName, provider }
        this.sections.push(reg)
        return () => {
          const index = this.sections.indexOf(reg)
          if (index >= 0) this.sections.splice(index, 1)
        }
      },

      signal: (input) => this.signal(input),
      complete: async (role, context, opts) => {
        const resolved = this.options.models.resolve(role)
        const message = await this.options.models.complete(resolved.model, context, {
          ...(resolved.thinking ? { reasoning: resolved.thinking } : {}),
          ...opts,
        })
        this.emit({
          type: "llm_request",
          model: message.model,
          role,
          tokens: message.usage.totalTokens,
          cost: message.usage.cost.total,
          stopReason: message.stopReason,
          ...(message.durationMs === undefined ? {} : { ms: message.durationMs }),
        })
        return message
      },

      timeline: { query: (q) => kernel.timeline.query(q) },
      currentRun: () => this.currentRun(),
      abortRun: (reason) => this.abortRun(reason),
      compact: () => this.requestCompact(),
      host,
    }
  }

  // ═══════════════════════════ 杂项 ═══════════════════════════

  private emit(event: Parameters<EventBus["emit"]>[0]): void {
    this.events.emit(event) // runId 与 turn 由 events.stamp 统一补上（hook 事件也走这里）
  }

  private extError(ext: string, e: unknown): void {
    this.emit({ type: "ext_error", ext, error: toError(e).message })
  }

  private kernelError(e: unknown): void {
    this.extError(KERNEL, e)
  }
}

export function createKernel(options: KernelOptions): Kernel {
  return new Kernel(options)
}
