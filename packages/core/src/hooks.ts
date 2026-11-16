/**
 * Hook 分发与只读事件流（docs/architecture.md §8.3、§8.4）。
 * - hook 按扩展加载顺序串行执行；抛异常或超时的 handler 被跳过，不影响主流程。
 * - 事件流订阅者的异常被吞掉。
 */
import type { HookHandler, HookMap, HookName, SofiaEvent, SofiaEventInput } from "./types.ts"

export class EventBus {
  private readonly subscribers = new Set<(e: SofiaEvent) => void>()

  subscribe(fn: (e: SofiaEvent) => void): () => void {
    this.subscribers.add(fn)
    return () => this.subscribers.delete(fn)
  }

  /** 每个事件都会补上的上下文（当前 Run 的 runId 与 turn）；事件自带的同名字段优先。 */
  stamp: (() => { runId?: string; turn?: number }) | undefined

  emit(event: SofiaEventInput): void {
    const full = { ...this.stamp?.(), ...event, at: event.at ?? Date.now() } as SofiaEvent
    for (const fn of this.subscribers) {
      try {
        fn(full)
      } catch {
        // 订阅者异常不影响主流程
      }
    }
  }
}

interface Registration {
  ext: string
  order: number
  seq: number
  handler: (payload: unknown) => unknown
}

export interface HookOutcome {
  /** 抛异常或超时的 handler 数 */
  failed: number
  errors: string[]
}

const TIMEOUT = Symbol("timeout")

export class HookBus {
  private readonly handlers = new Map<HookName, Registration[]>()
  private seq = 0
  private readonly events: EventBus

  constructor(events: EventBus) {
    this.events = events
  }

  on<E extends HookName>(ext: string, order: number, event: E, handler: HookHandler<E>): () => void {
    const reg: Registration = { ext, order, seq: this.seq++, handler: handler as (payload: unknown) => unknown }
    const list = this.handlers.get(event) ?? []
    list.push(reg)
    list.sort((a, b) => a.order - b.order || a.seq - b.seq)
    this.handlers.set(event, list)
    return () => {
      const current = this.handlers.get(event)
      if (current) this.handlers.set(event, current.filter((r) => r !== reg))
    }
  }

  has(event: HookName): boolean {
    return (this.handlers.get(event)?.length ?? 0) > 0
  }

  /**
   * 依次调用 handler。`payload` 每次重新求值（链式 hook 传入上一个结果）；
   * `onResult` 返回 "stop" 则不再调用后续 handler。永不抛异常。
   */
  async run<E extends HookName>(
    event: E,
    payload: () => HookMap[E]["payload"],
    opts: {
      timeoutMs: number
      onResult?: (result: Exclude<HookMap[E]["result"], void>, ext: string) => "stop" | void
      onTimeout?: () => void
    },
  ): Promise<HookOutcome> {
    const outcome: HookOutcome = { failed: 0, errors: [] }
    for (const reg of [...(this.handlers.get(event) ?? [])]) {
      const startedAt = performance.now()
      let error: string | undefined
      let stop = false
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const result = await Promise.race([
          Promise.resolve().then(() => reg.handler(payload())),
          new Promise<typeof TIMEOUT>((resolve) => {
            timer = setTimeout(() => resolve(TIMEOUT), opts.timeoutMs)
          }),
        ])
        if (result === TIMEOUT) {
          error = "timeout"
          opts.onTimeout?.()
        } else if (result !== undefined && result !== null && opts.onResult) {
          stop = opts.onResult(result as Exclude<HookMap[E]["result"], void>, reg.ext) === "stop"
        }
      } catch (e) {
        error = e instanceof Error ? e.message : String(e)
      } finally {
        clearTimeout(timer)
      }
      if (error !== undefined) {
        outcome.failed++
        outcome.errors.push(`${reg.ext}: ${error}`)
      }
      this.events.emit({
        type: "hook",
        ext: reg.ext,
        event,
        ms: Math.round(performance.now() - startedAt),
        ...(error === undefined ? {} : { error }),
      })
      if (stop) break
    }
    return outcome
  }
}
