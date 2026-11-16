import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai"
import { createKernel, createModelRuntime, type Signal } from "@sofia/core"
import { afterEach, expect, it } from "vitest"
import telegram from "../src/index.ts"

const OWNER = 111
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms))

/** 假的 Bot API：脚本化 getUpdates，记录所有调用。 */
function fakeTelegram() {
  const calls: { method: string; body: any }[] = []
  const pending: any[] = []
  let updateId = 1
  let failSend = 0
  let waiter: (() => void) | undefined
  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    const url = req.url ?? ""
    if (url.startsWith("/file/")) return void res.end(Buffer.from("PNGDATA"))
    const method = url.split("/").pop()!
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}
    calls.push({ method, body })
    const ok = (result: unknown) => res.end(JSON.stringify({ ok: true, result }))
    if (method === "getMe") return ok({ id: 999, username: "sofia_bot" })
    if (method === "getFile") return ok({ file_path: "photos/a.png" })
    if (method === "sendMessage") {
      if (failSend > 0) {
        failSend--
        calls.pop() // 失败的那次不算"已发送"
        res.statusCode = 502
        return res.end(JSON.stringify({ ok: false, error_code: 502, description: "Bad Gateway" }))
      }
      return ok({ message_id: 1 })
    }
    if (method === "getUpdates") {
      if (pending.length === 0) await new Promise<void>((r) => ((waiter = r), setTimeout(r, 200)))
      return ok(pending.splice(0).filter((u) => u.update_id >= body.offset))
    }
    ok(true)
  })
  return {
    server, calls,
    push: (message: any) => (pending.push({ update_id: updateId++, message: { message_id: updateId, date: 1794300000, ...message } }), waiter?.()),
    failNextSends: (n: number) => (failSend = n),
    sent: () => calls.filter((c) => c.method === "sendMessage").map((c) => c.body),
  }
}

let cleanup: (() => Promise<void>) | undefined
afterEach(async () => {
  await cleanup?.()
  cleanup = undefined
})

async function boot() {
  const tg = fakeTelegram()
  await new Promise<void>((r) => tg.server.listen(0, "127.0.0.1", r))
  const faux = fauxProvider()
  const models = createModels()
  models.setProvider(faux.provider)
  const kernel = createKernel({
    home: mkdtempSync(join(tmpdir(), "sofia-tg-")),
    dbPath: ":memory:",
    models: createModelRuntime(models, { main: { model: faux.getModel() } }),
    secrets: (name) => (name === "TELEGRAM_BOT_TOKEN" ? "TOKEN" : undefined),
    extensions: [{ def: telegram, config: { ownerUserId: OWNER, debounceMs: 0, pollTimeoutSec: 1, apiBase: `http://127.0.0.1:${(tg.server.address() as AddressInfo).port}` } }],
  })
  await kernel.start()
  cleanup = async () => {
    await kernel.stop()
    tg.server.closeAllConnections()
    await new Promise((r) => tg.server.close(r))
  }
  const settle = async () => {
    await tick(80)
    await kernel.whenIdle()
  }
  const signals = () => kernel.timeline.query({ types: ["signal"] }).map((e) => e.data as Signal)
  return { tg, faux, kernel, settle, signals }
}

const owner = { id: OWNER, first_name: "阿洋" }
const dm = { id: OWNER, type: "private", first_name: "阿洋" }
const group = { id: -100123, type: "supergroup", title: "摸鱼小队" }

it("主人私聊：high 优先级 Signal，回复投递回该聊天；/stop 不产生 Signal", async () => {
  const t = await boot()
  t.faux.setResponses([fauxAssistantMessage("来了")])
  t.tg.push({ chat: dm, from: owner, text: "在吗" })
  await t.settle()
  const [s] = t.signals()
  expect(s).toMatchObject({
    at: 1794300000000, priority: "high",
    source: { kind: "room", room: { channel: "telegram", id: `telegram:direct:${OWNER}`, label: "私聊·阿洋", kind: "direct" }, sender: { id: String(OWNER), name: "阿洋", isOwner: true } },
    content: [{ type: "text", text: "在吗" }],
  })
  expect(t.tg.sent()).toEqual([{ chat_id: String(OWNER), text: "来了" }])

  t.tg.push({ chat: dm, from: owner, text: "/stop" })
  await t.settle()
  expect(t.signals()).toHaveLength(1)
})

it("群聊规范化：显示名冒充不算主人、贴纸、图片、回复与 @ 的 notes", async () => {
  const t = await boot()
  t.faux.setResponses([fauxAssistantMessage("[[NO_REPLY]]"), fauxAssistantMessage("[[NO_REPLY]]"), fauxAssistantMessage("[[NO_REPLY]]")])
  t.tg.push({ chat: group, from: { id: 222, first_name: "阿洋" }, text: "@sofia_bot 你怎么看", reply_to_message: { from: { id: 333, first_name: "小王" }, text: "今天吃什么" } })
  await t.settle()
  t.tg.push({ chat: group, from: { id: 333, first_name: "小王" }, sticker: { emoji: "😂" } })
  await t.settle()
  t.tg.push({ chat: group, from: { id: 333, first_name: "小王" }, caption: "看这个", photo: [{ file_id: "small" }, { file_id: "big" }] })
  await t.settle()

  const [a, b, c] = t.signals()
  expect(a).toMatchObject({ priority: "normal", source: { room: { id: "telegram:group:-100123", label: "群聊·摸鱼小队", kind: "group" }, sender: { isOwner: false } } })
  expect(a!.notes!.slice(0, 2)).toEqual(['回复了 小王："今天吃什么"', "@了你"])
  expect(b!.content).toEqual([{ type: "text", text: "[贴纸 😂]" }])
  expect(c!.content).toEqual([{ type: "text", text: "看这个" }, { type: "image", data: Buffer.from("PNGDATA").toString("base64"), mimeType: "image/png" }])
  expect(t.tg.calls.find((x) => x.method === "getFile")!.body).toEqual({ file_id: "big" })
  expect(t.tg.sent()).toEqual([])
})

it("telegram_send 工具跨 Room 发言；Section 列出主人私聊与群；投递短暂失败会重试", async () => {
  const t = await boot()
  t.faux.setResponses([fauxAssistantMessage("嗯"), fauxAssistantMessage([fauxToolCall("telegram_send", { room: `telegram:direct:${OWNER}`, text: "群里有人找你", replyToMessageId: 7 })], { stopReason: "toolUse" }), fauxAssistantMessage("好的")])
  t.tg.push({ chat: dm, from: owner, text: "hi" })
  await t.settle()
  t.tg.failNextSends(1)
  t.tg.push({ chat: group, from: { id: 333, first_name: "小王" }, text: "帮我叫一下阿洋" })
  await t.settle()
  await tick(700)
  await t.kernel.whenIdle()

  expect(t.tg.sent().slice(1)).toEqual([
    { chat_id: String(OWNER), text: "群里有人找你", reply_parameters: { message_id: 7, allow_sending_without_reply: true } },
    { chat_id: "-100123", text: "好的" },
  ])
  const sections = t.kernel.timeline.query({ types: ["system"] }).map((e) => (e.data as any).sections?.["channel:telegram"]).filter(Boolean)
  expect(sections.at(-1)).toContain(`主人的私聊：telegram:direct:${OWNER}（私聊·阿洋）`)
  // 群是在第二个 Run 才认识的，下一个 Run 开始时才进 Section
  t.faux.setResponses([fauxAssistantMessage("[[NO_REPLY]]")])
  t.tg.push({ chat: group, from: { id: 333, first_name: "小王" }, text: "谢谢" })
  await t.settle()
  const latest = t.kernel.timeline.query({ types: ["system"] }).map((e) => (e.data as any).sections?.["channel:telegram"]).filter(Boolean).at(-1)
  expect(latest).toContain("- telegram:group:-100123（群聊·摸鱼小队）")
})

it("缺少 token：扩展不加载，记 ext_error", async () => {
  const faux = fauxProvider()
  const models = createModels()
  models.setProvider(faux.provider)
  const kernel = createKernel({ home: mkdtempSync(join(tmpdir(), "sofia-tg-")), dbPath: ":memory:", models: createModelRuntime(models, { main: { model: faux.getModel() } }), extensions: [{ def: telegram, config: { ownerUserId: 1 } }] })
  await kernel.start()
  expect(kernel.extensionInfos()[0]).toMatchObject({ status: "error", error: expect.stringContaining("TELEGRAM_BOT_TOKEN") })
  await kernel.stop()
})
