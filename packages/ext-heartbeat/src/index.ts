/**
 * ext-heartbeat：按 cron 与"主人太久没出现"产生 internal Signal（docs/architecture.md §10.6）。
 * 要不要真的开口由她自己决定——提示语里给了 Silence Token 这条退路。
 */
import { defineExtension, formatTime, type RoomRef, type Signal } from "@sofia/core"

export interface HeartbeatConfig {
  /** 距主人上次说话超过这么多小时就提醒一次；之后每隔同样时长再提醒。不填则不做空闲提醒 */
  idleHours?: number
  /** 5 段 cron 表达式（分 时 日 月 周），本地时区 */
  cron?: string[]
  /** "owner"（默认）：目标为主人最近活跃的私聊 Room；"none"：无目标，不自动投递 */
  target?: "owner" | "none"
}

const RANGES: [number, number][] = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]]

function parseField(field: string, [min, max]: [number, number]): Set<number> | undefined {
  const values = new Set<number>()
  for (const part of field.split(",")) {
    const m = /^(\*|\d+(?:-(\d+))?)(?:\/(\d+))?$/.exec(part)
    if (!m) return undefined
    const step = m[3] === undefined ? 1 : Number(m[3])
    let from = min
    let to = max
    if (m[1] !== "*") {
      from = Number.parseInt(m[1]!, 10)
      to = m[2] !== undefined ? Number(m[2]) : m[3] !== undefined ? max : from
    }
    if (step < 1 || from < min || to > max || from > to) return undefined
    for (let v = from; v <= to; v += step) values.add(v)
  }
  return values
}

/** 解析 5 段 cron，返回"某一分钟是否命中"；表达式非法返回 undefined。 */
export function parseCron(expr: string): ((date: Date) => boolean) | undefined {
  const fields = expr.trim().split(/\s+/)
  if (fields.length !== 5) return undefined
  const sets = fields.map((f, i) => parseField(f, RANGES[i]!))
  if (sets.some((s) => !s)) return undefined
  const [minute, hour, dom, month, dow] = sets as Set<number>[]
  if (dow!.has(7)) dow!.add(0)
  const domAny = fields[2] === "*"
  const dowAny = fields[4] === "*"
  return (d) => {
    if (!minute!.has(d.getMinutes()) || !hour!.has(d.getHours()) || !month!.has(d.getMonth() + 1)) return false
    const domHit = dom!.has(d.getDate())
    const dowHit = dow!.has(d.getDay())
    // 标准 cron：日与周都受限时，命中任一即可
    return domAny || dowAny ? domHit && dowHit : domHit || dowHit
  }
}

const HOUR = 3_600_000

export default defineExtension<HeartbeatConfig>({
  name: "heartbeat",
  configSchema: {
    type: "object",
    properties: {
      idleHours: { type: "number", description: "主人超过多少小时没说话就提醒她一次" },
      cron: { type: "array", items: { type: "string" }, description: "定时提醒（5 段 cron，本地时区）" },
      target: { type: "string", enum: ["owner", "none"], description: "owner：主人最近活跃的私聊；none：无目标" },
    },
  },
  setup(sofia) {
    const config = sofia.config ?? {}
    const idleMs = config.idleHours && config.idleHours > 0 ? config.idleHours * HOUR : undefined
    const crons = (config.cron ?? []).flatMap((expr) => {
      const match = parseCron(expr)
      if (!match) sofia.log.warn(`ignoring invalid cron expression: ${expr}`)
      return match ? [match] : []
    })
    if (!idleMs && crons.length === 0) return

    const isOwner = (s: Signal) => s.source.kind === "room" && s.source.sender.isOwner
    let lastOwnerAt: number | undefined
    let lastFireAt: number | undefined
    let startedAt = Date.now()
    let timer: ReturnType<typeof setTimeout> | undefined

    // 主人说话即刷新空闲计时
    sofia.on("signal", (signal) => {
      if (isOwner(signal)) lastOwnerAt = Math.max(lastOwnerAt ?? 0, signal.at)
    })

    const recentSignals = () => sofia.timeline.query({ types: ["signal"], limit: 200 }).map((e) => e.data as Signal).reverse()

    /** 主人最近活跃的私聊 Room。 */
    const ownerRoom = (): RoomRef | undefined => {
      if (config.target === "none") return undefined
      for (const s of recentSignals()) {
        if (s.source.kind === "room" && s.source.sender.isOwner && s.source.room.kind === "direct") return s.source.room
      }
      return undefined
    }

    const fire = (now: number) => {
      lastFireAt = now
      const hours = lastOwnerAt === undefined ? undefined : Math.floor((now - lastOwnerAt) / HOUR)
      const idle = hours === undefined ? "你还没有和主人说过话。" : hours >= 1 ? `你已经 ${hours} 小时没和主人说话了。` : ""
      const room = ownerRoom()
      sofia.signal({
        source: { kind: "internal", from: sofia.name, ...(room ? { room } : {}) },
        priority: "low",
        content: [{ type: "text", text: `现在是 ${formatTime(now)}，${idle}可以考虑主动问候；如果不想打扰，只回复 [[NO_REPLY]]。` }],
      })
    }

    const tick = () => {
      const now = Date.now()
      const date = new Date(now)
      const cronHit = crons.some((match) => match(date))
      const idleSince = Math.max(lastOwnerAt ?? startedAt, lastFireAt ?? 0)
      const idleHit = idleMs !== undefined && now - idleSince >= idleMs
      if (cronHit || idleHit) fire(now)
      schedule()
    }
    /** 对齐到下一个整分钟。 */
    const schedule = () => {
      timer = setTimeout(tick, 60_000 - (Date.now() % 60_000))
    }

    sofia.on("start", () => {
      startedAt = Date.now()
      for (const s of recentSignals()) {
        if (lastOwnerAt === undefined && isOwner(s)) lastOwnerAt = s.at
        if (lastFireAt === undefined && s.source.kind === "internal" && s.source.from === sofia.name) lastFireAt = s.at
        if (lastOwnerAt !== undefined && lastFireAt !== undefined) break
      }
      schedule()
    })
    sofia.on("shutdown", () => clearTimeout(timer))
  },
})
