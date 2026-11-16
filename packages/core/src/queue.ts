/**
 * Queue：Signal 等待被处理的地方（仅内存；docs/architecture.md §4.1、§4.2）。
 * 每个"桶"带防抖与最长等待；到期后变为就绪，由内核取走开启一个 Run。
 */
import type { RoomRef, Signal, SignalPriority } from "./types.ts"

export const INTERNAL_BUCKET = "internal"

const RANK: Record<SignalPriority, number> = { high: 2, normal: 1, low: 0 }

interface Bucket {
  key: string
  signals: Signal[]
  focusRoom: RoomRef | undefined
  ready: boolean
  debounce: ReturnType<typeof setTimeout> | undefined
  maxWait: ReturnType<typeof setTimeout> | undefined
}

export interface Candidate {
  bucket: string
  priority: SignalPriority
  earliestAt: number
}

export interface Pick {
  key: string
  signals: Signal[]
  focusRoom: RoomRef | undefined
  candidates: Candidate[]
  reason: string
}

/** Signal 的桶：Room（含带目标的 internal）→ room.id；无目标 internal → 共享桶。 */
export function bucketKey(signal: Signal): string {
  return signal.source.room?.id ?? INTERNAL_BUCKET
}

export class SignalQueue {
  private readonly buckets = new Map<string, Bucket>()

  private readonly onReady: (key: string) => void

  constructor(onReady: (key: string) => void) {
    this.onReady = onReady
  }

  add(signal: Signal, timing: { debounceMs: number; maxWaitMs: number }): void {
    const key = bucketKey(signal)
    let bucket = this.buckets.get(key)
    if (!bucket) {
      bucket = { key, signals: [], focusRoom: undefined, ready: false, debounce: undefined, maxWait: undefined }
      this.buckets.set(key, bucket)
    }
    bucket.signals.push(signal)
    if (signal.source.room) bucket.focusRoom = signal.source.room
    if (bucket.ready) return

    if (timing.debounceMs <= 0) return this.markReady(bucket)
    clearTimeout(bucket.debounce)
    bucket.debounce = setTimeout(() => this.markReady(bucket), timing.debounceMs)
    bucket.maxWait ??= setTimeout(() => this.markReady(bucket), timing.maxWaitMs)
  }

  /** Run 结束时的 steer 残留：放回桶首并立即就绪（§4.4）。 */
  requeue(signals: Signal[]): void {
    for (const signal of [...signals].reverse()) {
      const key = bucketKey(signal)
      let bucket = this.buckets.get(key)
      if (!bucket) {
        bucket = { key, signals: [], focusRoom: undefined, ready: false, debounce: undefined, maxWait: undefined }
        this.buckets.set(key, bucket)
      }
      bucket.signals.unshift(signal)
      bucket.focusRoom ??= signal.source.room
      this.markReady(bucket)
    }
  }

  hasReady(): boolean {
    for (const bucket of this.buckets.values()) if (bucket.ready) return true
    return false
  }

  /** 取走优先级最高（同级取最早）的就绪桶的全部 Signal。 */
  take(): Pick | undefined {
    const ready = [...this.buckets.values()].filter((b) => b.ready && b.signals.length > 0)
    if (ready.length === 0) return undefined
    const describe = (b: Bucket): Candidate => ({
      bucket: b.key,
      priority: b.signals.reduce<SignalPriority>((p, s) => (RANK[s.priority] > RANK[p] ? s.priority : p), "low"),
      earliestAt: Math.min(...b.signals.map((s) => s.at)),
    })
    const candidates = ready.map(describe)
    let best = 0
    for (let i = 1; i < candidates.length; i++) {
      const a = candidates[i]!
      const b = candidates[best]!
      if (RANK[a.priority] > RANK[b.priority] || (a.priority === b.priority && a.earliestAt < b.earliestAt)) best = i
    }
    const chosen = ready[best]!
    this.buckets.delete(chosen.key)
    const top = candidates[best]!
    const reason =
      candidates.length === 1
        ? "only ready bucket"
        : candidates.some((c) => c !== top && c.priority === top.priority)
          ? `priority ${top.priority}, earliest signal`
          : `highest priority (${top.priority})`
    return { key: chosen.key, signals: chosen.signals, focusRoom: chosen.focusRoom, candidates, reason }
  }

  clear(): void {
    for (const bucket of this.buckets.values()) {
      clearTimeout(bucket.debounce)
      clearTimeout(bucket.maxWait)
    }
    this.buckets.clear()
  }

  private markReady(bucket: Bucket): void {
    clearTimeout(bucket.debounce)
    clearTimeout(bucket.maxWait)
    bucket.debounce = bucket.maxWait = undefined
    if (bucket.ready || this.buckets.get(bucket.key) !== bucket) return
    bucket.ready = true
    this.onReady(bucket.key)
  }
}
