import { afterEach, describe, expect, it, vi } from "vitest"
import type { Signal } from "@sofia/core"
import { fakeChannel, room, say, setup } from "../../core/test/harness.ts"
import heartbeat, { parseCron } from "../src/index.ts"

const main = room("main")
const MIN = 60_000
const HOUR = 60 * MIN

afterEach(() => vi.useRealTimers())

describe("cron", () => {
  const at = (s: string) => new Date(s)
  it("5 段表达式：通配、列表、范围、步长；日与周同时受限时任一命中", () => {
    expect(parseCron("0 9 * * *")!(at("2026-11-10T09:00:00"))).toBe(true)
    expect(parseCron("0 9 * * *")!(at("2026-11-10T09:01:00"))).toBe(false)
    expect(parseCron("*/15 8-10 * * 1-5")!(at("2026-11-10T10:45:00"))).toBe(true) // 周二
    expect(parseCron("*/15 8-10 * * 1-5")!(at("2026-11-14T10:45:00"))).toBe(false) // 周六
    expect(parseCron("0 0 1 * 7")!(at("2026-11-15T00:00:00"))).toBe(true) // 周日（7 = 0）
    expect(parseCron("0 0 1 * 7")!(at("2026-11-01T00:00:00"))).toBe(true)
    expect(parseCron("0 0 1 * 7")!(at("2026-11-02T00:00:00"))).toBe(false)
    expect(parseCron("0 9,21 * 11 *")!(at("2026-11-10T21:00:00"))).toBe(true)
    for (const bad of ["", "0 9 * *", "60 9 * * *", "a b c d e", "5-1 * * * *", "*/0 * * * *"]) expect(parseCron(bad)).toBeUndefined()
  })
})

describe("ext-heartbeat", () => {
  async function boot(config: object) {
    vi.useFakeTimers({ now: new Date("2026-11-10T08:58:30") })
    const ch = fakeChannel()
    const t = setup({ extensions: [{ def: heartbeat, config }, ch.ext] })
    await t.kernel.start()
    const internal = () => t.entries(["signal"]).map((e) => e.data as Signal).filter((s) => s.source.kind === "internal")
    const advance = async (ms: number) => {
      await vi.advanceTimersByTimeAsync(ms)
      await t.kernel.whenIdle()
    }
    return { ch, t, internal, advance }
  }

  it("cron 命中：low 优先级 internal Signal，目标为主人最近活跃的私聊 Room，回复自动投递", async () => {
    const b = await boot({ cron: ["0 9 * * *", "not a cron"] })
    expect(b.t.of("log").map((e) => e.message)).toEqual(["ignoring invalid cron expression: not a cron"])
    b.t.reply("早", "[[NO_REPLY]]", "主人早上好")
    b.ch.api.signal(say(room("摸鱼小队", "group"), "群里说一句"))
    await b.advance(0)
    b.ch.api.signal(say(main, "我去睡了"))
    await b.advance(MIN)
    expect(b.internal()).toHaveLength(0)

    await b.advance(MIN) // 09:00
    const [signal] = b.internal()
    expect(signal).toMatchObject({ priority: "low", source: { kind: "internal", from: "heartbeat", room: { id: main.id } } })
    expect((signal!.content[0] as any).text).toBe("现在是 2026-11-10 09:00，可以考虑主动问候；如果不想打扰，只回复 [[NO_REPLY]]。")
    expect(b.ch.delivered.at(-1)).toEqual({ room: main.id, text: "主人早上好" })
    await b.advance(2 * HOUR)
    expect(b.internal()).toHaveLength(1)
    await b.t.kernel.stop()
  })

  it("空闲：超过 idleHours 提醒一次，之后每隔 idleHours 再提醒；主人说话即重置", async () => {
    const b = await boot({ idleHours: 6 })
    b.t.reply("嗯", "[[NO_REPLY]]", "[[NO_REPLY]]", "在", "[[NO_REPLY]]")
    b.ch.api.signal(say(main, "我出门了"))
    await b.advance(5 * HOUR + 59 * MIN)
    expect(b.internal()).toHaveLength(0)
    await b.advance(2 * MIN)
    expect(b.internal()).toHaveLength(1)
    expect((b.internal()[0]!.content[0] as any).text).toContain("你已经 6 小时没和主人说话了。")

    await b.advance(5 * HOUR)
    expect(b.internal()).toHaveLength(1)
    await b.advance(HOUR + MIN)
    expect(b.internal()).toHaveLength(2)
    expect((b.internal()[1]!.content[0] as any).text).toContain("你已经 12 小时没和主人说话了。")

    b.ch.api.signal(say(main, "我回来了"))
    await b.advance(5 * HOUR)
    expect(b.internal()).toHaveLength(2)
    await b.advance(HOUR + MIN)
    expect(b.internal()).toHaveLength(3)
    await b.t.kernel.stop()
  })

  it('target: "none" 或找不到主人私聊时无目标，不自动投递', async () => {
    const b = await boot({ cron: ["0 9 * * *"], target: "none" })
    b.t.reply("嗯", "没人听得到")
    b.ch.api.signal(say(main, "在吗"))
    await b.advance(2 * MIN)
    expect(b.internal()[0]!.source).toEqual({ kind: "internal", from: "heartbeat" })
    expect(b.ch.delivered.map((d) => d.text)).toEqual(["嗯"])
    await b.t.kernel.stop()
  })
})
