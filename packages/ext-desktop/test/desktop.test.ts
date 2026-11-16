import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai"
import { createKernel, createModelRuntime, type Signal } from "@sofia/core"
import { afterEach, expect, it } from "vitest"
import { WebSocket } from "ws"
import desktop from "../src/index.ts"

const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms))
let port = 47900 + Math.floor(Math.random() * 500)
let cleanup: (() => Promise<void>) | undefined
afterEach(async () => {
  await cleanup?.()
  cleanup = undefined
})

async function boot() {
  port++
  const faux = fauxProvider({ tokenSize: { min: 1, max: 1 } })
  const models = createModels()
  models.setProvider(faux.provider)
  const kernel = createKernel({
    home: mkdtempSync(join(tmpdir(), "sofia-desktop-")),
    dbPath: ":memory:",
    models: createModelRuntime(models, { main: { model: faux.getModel() } }),
    extensions: [{ def: desktop, config: { port, allowedOrigins: ["http://localhost:5173"] } }],
  })
  await kernel.start()
  cleanup = () => kernel.stop()
  const connect = async (origin?: string) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, origin ? { origin } : {})
    const received: any[] = []
    ws.on("message", (d) => received.push(JSON.parse(d.toString())))
    await new Promise<void>((resolve, reject) => (ws.once("open", () => resolve()), ws.once("error", reject)))
    return { ws, received, send: (m: object) => ws.send(JSON.stringify(m)) }
  }
  const settle = async () => {
    await tick()
    await kernel.whenIdle()
    await tick()
  }
  const sections = () => kernel.timeline.query({ types: ["system"] }).map((e) => (e.data as any).sections ?? {})
  return { faux, kernel, connect, settle, sections }
}

it("say → 主人的 high 优先级 Signal；回复以 reply_delta + reply_end 推给客户端；图片随附", async () => {
  const t = await boot()
  const c = await t.connect()
  t.faux.setResponses([fauxAssistantMessage("在的，主人")])
  c.send({ type: "say", text: "在吗", images: [{ data: "AAAA", mimeType: "image/png" }, { data: "x", mimeType: "text/html" }] })
  await t.settle()
  const [s] = t.kernel.timeline.query({ types: ["signal"] }).map((e) => e.data as Signal)
  expect(s).toMatchObject({ priority: "high", source: { kind: "room", room: { id: "desktop:direct:main", kind: "direct" }, sender: { isOwner: true } } })
  expect(s!.content).toEqual([{ type: "text", text: "在吗" }, { type: "image", data: "AAAA", mimeType: "image/png" }])
  expect(c.received.filter((m) => m.type === "reply_delta").map((m) => m.text).join("")).toBe("在的，主人")
  expect(c.received.at(-1)).toEqual({ type: "reply_end", text: "在的，主人" })
})

it("hello 注册表情/动作工具与 Section，下一个 Run 生效；工具调用推给客户端；断开后注销", async () => {
  const t = await boot()
  const c = await t.connect()
  c.send({ type: "hello", expressions: ["smile", "angry", 3], motions: ["wave"] })
  await tick()
  t.faux.setResponses([fauxAssistantMessage([fauxToolCall("desktop_expression", { name: "smile" }), fauxToolCall("desktop_motion", { name: "wave" })], { stopReason: "toolUse" }), fauxAssistantMessage("嘿")])
  c.send({ type: "say", text: "笑一个" })
  await t.settle()
  expect(c.received.filter((m) => m.type === "expression" || m.type === "motion")).toEqual([{ type: "expression", name: "smile" }, { type: "motion", name: "wave" }])
  const section = t.sections().at(-1)["channel:desktop"]
  expect(section).toContain("用 desktop_expression 可以做表情：smile、angry")
  expect(section).toContain("用 desktop_motion 可以做动作：wave")
  expect(t.kernel.timeline.query({ types: ["toolResult"] }).every((e) => !(e.data as any).isError)).toBe(true)

  c.ws.close()
  await tick()
  // 未连接：投递丢弃，不算失败
  t.faux.setResponses([fauxAssistantMessage("有人吗")])
  t.kernel.signal({ source: { kind: "internal", from: "test", room: { channel: "desktop", id: "desktop:direct:main", label: "桌面", kind: "direct" } }, priority: "low", content: [{ type: "text", text: "想想" }] })
  await t.settle()
  const last = t.kernel.timeline.query({ types: ["system"] }).at(-1)!.data as any
  expect(last.sections["channel:desktop"]).toBeNull()
  expect(last.toolsRemoved.map((x: any) => x.name).sort()).toEqual(["desktop_expression", "desktop_motion"])
  expect(t.kernel.timeline.query({ types: ["notice"] })).toEqual([])
})

it("stop 中止当前 Run；Run 出错时推送 error；拒绝未列入的网页来源", async () => {
  const t = await boot()
  const c = await t.connect("http://localhost:5173")
  await expect(t.connect("https://evil.example")).rejects.toThrow()

  t.faux.setResponses([fauxAssistantMessage([], { stopReason: "error", errorMessage: "invalid api key" })])
  c.send({ type: "say", text: "在吗" })
  await t.settle()
  expect(c.received).toEqual([{ type: "error", message: "invalid api key" }])

  const statuses: string[] = []
  t.kernel.events.subscribe((e) => e.type === "run_end" && statuses.push(e.status))
  t.faux.setResponses([async () => (await tick(300), fauxAssistantMessage("太慢了"))])
  c.send({ type: "say", text: "讲个故事" })
  await tick(60)
  c.send({ type: "stop" })
  await t.settle()
  await tick(300)
  expect(statuses).toEqual(["aborted"])
  c.send({ type: "bogus" })
  await tick()
  expect(c.received.at(-1)).toEqual({ type: "error", message: "unknown message type: bogus" })
})
