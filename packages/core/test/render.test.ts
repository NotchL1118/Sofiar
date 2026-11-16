import { describe, expect, it } from "vitest"
import { convertToLlm, couldBecomeSilence, findCut, isSilence, type Signal, type TimelineEntry } from "../src/index.ts"
import { room, say } from "./harness.ts"

const at = Date.UTC(2026, 10, 10, 21, 0)
const signal = (input: ReturnType<typeof say>): Signal => ({ id: "s", at, ...input })

describe("Signal 渲染", () => {
  it("Room Signal：Room、时间、主人标记、notes；sender.name 去换行", () => {
    const s = signal(say(room("摸鱼小队", "group"), "在吗", { name: "阿\n洋" }))
    s.notes = ["@了你"]
    const [user] = convertToLlm([{ role: "signal", signal: s, timestamp: at }])
    expect(user).toMatchObject({ role: "user", content: [{ type: "text", text: "[摸鱼小队 · 2026-11-10 21:00] 阿 洋（主人）：在吗\n  （@了你）" }] })
  })

  it("internal Signal 渲染为 <internal>", () => {
    const s: Signal = { id: "s", at, source: { kind: "internal", from: "heartbeat" }, priority: "low", content: [{ type: "text", text: "该问候了" }] }
    const [user] = convertToLlm([{ role: "signal", signal: s, timestamp: at }])
    expect((user as any).content[0].text).toBe('<internal from="heartbeat" at="2026-11-10 21:00">该问候了</internal>')
  })

  it("相邻的 recall / notice / signal 合并为一条 user 消息，图片原样随附", () => {
    const s = signal(say(room("main"), "看图", { owner: false }))
    s.content.push({ type: "image", data: "AAAA", mimeType: "image/png" })
    const out = convertToLlm([
      { role: "system", content: "sys", timestamp: 0 },
      { role: "notice", text: "（你刚才被中断了）", timestamp: at },
      { role: "recall", from: "mem", items: ["他喜欢猫"], timestamp: at },
      { role: "signal", signal: s, timestamp: at },
    ])
    expect(out.map((m) => m.role)).toEqual(["system", "user"])
    const content = (out[1] as any).content
    expect(content).toHaveLength(2)
    expect(content[0].text).toBe(
      "<notice>（你刚才被中断了）</notice>\n\n<recall>\n你想起了这些：\n- 他喜欢猫\n</recall>\n\n[main · 2026-11-10 21:00] 小王：看图",
    )
    expect(content[1].type).toBe("image")
  })
})

describe("Silence Token", () => {
  it("各种写法", () => {
    for (const t of ["[[NO_REPLY]]", "[NO_REPLY]", "NO_REPLY", "  [[no_reply]]\n"]) expect(isSilence(t)).toBe(true)
    for (const t of ["", "好的 [[NO_REPLY]]", "[[NO_REPLY]] 嗯", "NO_REPLYX"]) expect(isSilence(t)).toBe(false)
  })
  it("前缀判定", () => {
    for (const t of ["", " ", "[", "[[", "[[NO", "[[NO_REPLY", "[[NO_REPLY]", "[[NO_REPLY]] \n", "no_r"]) expect(couldBecomeSilence(t)).toBe(true)
    for (const t of ["你", "[[N你", "[[NO_REPLY]] 嗯", "NOPE"]) expect(couldBecomeSilence(t)).toBe(false)
  })
})

describe("切点", () => {
  const e = (seq: number, runId: string, type: string, chars = 400): TimelineEntry => ({
    seq, id: String(seq), at: seq, type, runId,
    data:
      type === "signal"
        ? { id: "s", at: 0, source: { kind: "internal", from: "t" }, priority: "low", content: [{ type: "text", text: "x".repeat(chars) }] }
        : { role: type, content: [{ type: "text", text: "x".repeat(chars) }], stopReason: "stop", usage: {} },
  })
  it("不足 keepRecentTokens 时不切", () => {
    expect(findCut([e(1, "a", "signal"), e(2, "a", "assistant")], 10_000)).toBe(0)
  })
  it("落在 Run 边界", () => {
    const entries = [e(1, "a", "signal"), e(2, "a", "assistant"), e(3, "b", "signal"), e(4, "b", "assistant"), e(5, "c", "signal"), e(6, "c", "assistant")]
    // 每条约 100+ token；保留约 250 → 阈值落在 Run b 中间，切到 Run c 开头
    expect(findCut(entries, 250)).toBe(4)
  })
  it("当前 Run 自身超出时退化为 Turn 边界，不以 toolResult 开头", () => {
    const entries = [e(1, "a", "signal"), e(2, "a", "assistant"), e(3, "a", "toolResult"), e(4, "a", "assistant"), e(5, "a", "toolResult")]
    expect(findCut(entries, 250)).toBe(3)
  })
})
