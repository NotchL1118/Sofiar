/**
 * ext-telegram：Telegram Channel（docs/architecture.md §10.4）。
 * 长轮询接收 update，规范化为 Signal；投递、`send` 工具、`channel:telegram` Section。
 * 直接用 Bot API（fetch），没有第三方依赖。
 */
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { defineExtension, type RoomRef, type Signal } from "@sofia/core"

export interface TelegramConfig {
  /** 主人的 Telegram 用户 ID（数字）。只依据它判定主人，绝不依据显示名 */
  ownerUserId: number
  /** bot token 的密钥名，默认 TELEGRAM_BOT_TOKEN */
  tokenSecret?: string
  debounceMs?: number
  /** Bot API 地址，默认 https://api.telegram.org（测试或自建服务器时覆盖） */
  apiBase?: string
  /** 长轮询超时（秒），默认 30 */
  pollTimeoutSec?: number
  /** 是否下载图片成 image block，默认 true */
  images?: boolean
}

type Content = Signal["content"]
const MAX_TEXT = 4096
const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve()
    const t = setTimeout(resolve, ms)
    signal?.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true })
  })

class ApiError extends Error {
  code: number
  retryAfter: number | undefined
  constructor(method: string, code: number, description: string, retryAfter?: number) {
    super(`telegram ${method}: ${code} ${description}`)
    this.code = code
    this.retryAfter = retryAfter
  }
}

const userName = (u: any): string => [u?.first_name, u?.last_name].filter(Boolean).join(" ") || u?.username || String(u?.id ?? "?")
const clip = (text: string, max = 60) => (text.length > max ? `${text.slice(0, max)}…` : text)

/** 非文本内容的文字说明。 */
function describe(m: any): string | undefined {
  if (m.sticker) return `[贴纸${m.sticker.emoji ? ` ${m.sticker.emoji}` : ""}]`
  if (m.photo) return undefined
  if (m.voice) return "[语音]"
  if (m.video || m.video_note) return "[视频]"
  if (m.animation) return "[动图]"
  if (m.audio) return "[音频]"
  if (m.document) return `[文件 ${m.document.file_name ?? ""}]`.replace(" ]", "]")
  if (m.location) return "[位置]"
  if (m.contact) return "[联系人]"
  if (m.poll) return `[投票 ${m.poll.question ?? ""}]`
  return undefined
}

function summarize(m: any): string {
  return clip(m.text ?? m.caption ?? describe(m) ?? (m.photo ? "[图片]" : "…"))
}

export function roomOf(chat: any): RoomRef {
  const direct = chat.type === "private"
  return {
    channel: "telegram",
    id: `telegram:${direct ? "direct" : "group"}:${chat.id}`,
    label: direct ? `私聊·${userName(chat)}` : `群聊·${chat.title ?? chat.id}`,
    kind: direct ? "direct" : "group",
  }
}

export default defineExtension<TelegramConfig>({
  name: "telegram",
  configSchema: {
    type: "object",
    properties: {
      ownerUserId: { type: "number", description: "主人的 Telegram 用户 ID" },
      tokenSecret: { type: "string", description: "bot token 的密钥名，默认 TELEGRAM_BOT_TOKEN" },
      debounceMs: { type: "number" },
      apiBase: { type: "string" },
      pollTimeoutSec: { type: "number" },
      images: { type: "boolean", description: "下载图片交给模型看，默认开启" },
    },
    required: ["ownerUserId"],
  },
  setup(sofia) {
    const config = sofia.config
    const tokenName = config.tokenSecret ?? "TELEGRAM_BOT_TOKEN"
    const token = sofia.secret(tokenName)
    if (!token) throw new Error(`missing secret ${tokenName} (add it to secrets.json)`)
    const base = (config.apiBase ?? "https://api.telegram.org").replace(/\/+$/, "")
    const pollTimeout = config.pollTimeoutSec ?? 30
    const stop = new AbortController()

    async function api<T = any>(method: string, params: Record<string, unknown> = {}, timeoutMs = 20_000): Promise<T> {
      const res = await fetch(`${base}/bot${token}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(params),
        signal: AbortSignal.any([stop.signal, AbortSignal.timeout(timeoutMs)]),
      })
      const body = (await res.json().catch(() => undefined)) as any
      if (!body?.ok) throw new ApiError(method, body?.error_code ?? res.status, body?.description ?? res.statusText, body?.parameters?.retry_after)
      return body.result as T
    }

    /** 短暂失败（网络、429、5xx）退避重试；其余直接抛出。 */
    async function withRetry<T>(fn: () => Promise<T>, attempts = 4): Promise<T> {
      for (let i = 1; ; i++) {
        try {
          return await fn()
        } catch (e) {
          const transient = !(e instanceof ApiError) || e.code === 429 || e.code >= 500
          if (!transient || i >= attempts || stop.signal.aborted) throw e
          await sleep(e instanceof ApiError && e.retryAfter ? e.retryAfter * 1000 : 500 * 2 ** (i - 1), stop.signal)
        }
      }
    }

    // ───────────── 已知 Room（用于 Section 与 send 工具） ─────────────
    const roomsFile = () => join(sofia.dataDir, "rooms.json")
    const rooms = new Map<string, RoomRef & { owner?: boolean }>()
    try {
      for (const r of JSON.parse(readFileSync(roomsFile(), "utf8"))) rooms.set(r.id, r)
    } catch {
      // 首次运行
    }
    const remember = (room: RoomRef, owner: boolean) => {
      const known = rooms.get(room.id)
      const next = { ...room, ...(room.kind === "direct" && owner ? { owner: true } : known?.owner ? { owner: true } : {}) }
      if (known && JSON.stringify(known) === JSON.stringify(next)) return
      rooms.set(room.id, next)
      writeFileSync(roomsFile(), JSON.stringify([...rooms.values()], null, 2))
    }
    const chatId = (roomId: string) => roomId.split(":").slice(2).join(":")

    async function sendText(roomId: string, text: string, replyTo?: number): Promise<void> {
      for (let i = 0; i < text.length; i += MAX_TEXT) {
        const chunk = text.slice(i, i + MAX_TEXT)
        await withRetry(() =>
          api("sendMessage", {
            chat_id: chatId(roomId),
            text: chunk,
            ...(replyTo && i === 0 ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {}),
          }),
        )
      }
    }

    sofia.registerChannel({
      debounceMs: config.debounceMs ?? 1500,
      deliver: (room, text) => sendText(room.id, text),
      onRunError: (room) => void sendText(room.id, "（我这边出了点问题，这条没能回上，等会儿再试试）").catch(() => {}),
    })

    const send = sofia.registerTool({
      name: "send",
      label: "发送 Telegram 消息",
      description: "在指定的 Telegram Room 里发一条消息。只在想对当前关注的 Room 之外的地方说话、或需要引用某条消息回复时使用。",
      parameters: {
        type: "object",
        properties: {
          room: { type: "string", description: "Room id，如 telegram:direct:123456" },
          text: { type: "string" },
          replyToMessageId: { type: "number", description: "可选：要引用回复的消息 ID" },
        },
        required: ["room", "text"],
      },
      execute: async (_id, p: { room: string; text: string; replyToMessageId?: number }) => {
        if (!/^telegram:(direct|group):-?\d+$/.test(p.room)) throw new Error(`不是合法的 Telegram Room：${p.room}`)
        if (!p.text.trim()) throw new Error("text 不能为空")
        await sendText(p.room, p.text, p.replyToMessageId)
        return { content: [{ type: "text", text: "已发送" }], details: undefined }
      },
    })

    sofia.registerSection("channel:telegram", () => {
      const all = [...rooms.values()]
      const owner = all.filter((r) => r.owner)
      const groups = all.filter((r) => r.kind === "group")
      return [
        "# Telegram",
        `用 ${send.name} 工具可以在 Telegram 的任意 Room 里说话（你直接写出的回复只会发到当前关注的 Room）。`,
        owner.length > 0 ? `主人的私聊：${owner.map((r) => `${r.id}（${r.label}）`).join("、")}` : "还不知道主人的私聊 Room（主人还没在 Telegram 上找过你）。",
        ...(groups.length > 0 ? ["你所在的群：", ...groups.map((r) => `- ${r.id}（${r.label}）`)] : []),
      ].join("\n")
    })

    // ───────────── 接收 ─────────────
    let me: { id: number; username?: string } | undefined

    async function downloadPhoto(photo: any[]): Promise<Content[number] | undefined> {
      try {
        const largest = photo[photo.length - 1]
        const file = await withRetry(() => api<{ file_path: string }>("getFile", { file_id: largest.file_id }))
        const res = await fetch(`${base}/file/bot${token}/${file.file_path}`, { signal: AbortSignal.any([stop.signal, AbortSignal.timeout(30_000)]) })
        if (!res.ok) throw new Error(`download failed: ${res.status}`)
        const ext = file.file_path.split(".").pop()?.toLowerCase()
        const mimeType = ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : ext === "gif" ? "image/gif" : "image/jpeg"
        return { type: "image", data: Buffer.from(await res.arrayBuffer()).toString("base64"), mimeType }
      } catch (e) {
        sofia.log.warn(`photo download failed: ${e instanceof Error ? e.message : String(e)}`)
        return undefined
      }
    }

    async function onMessage(m: any): Promise<void> {
      const from = m.from
      if (!from || !m.chat || from.id === me?.id) return
      const isOwner = from.id === config.ownerUserId
      const text: string = m.text ?? m.caption ?? ""

      if (isOwner && /^\/stop(@\w+)?\s*$/.test(text)) return sofia.abortRun("owner /stop") // 不产生 Signal

      const room = roomOf(m.chat)
      remember(room, isOwner)

      const content: Content = []
      const parts = [text, describe(m)].filter(Boolean) as string[]
      let image: Content[number] | undefined
      if (m.photo?.length) {
        image = config.images === false ? undefined : await downloadPhoto(m.photo)
        if (!image) parts.push("[图片]")
      }
      if (parts.length > 0) content.push({ type: "text", text: parts.join(" ") })
      if (image) content.push(image)
      if (content.length === 0) return // 入群、置顶等服务消息

      const notes: string[] = []
      const reply = m.reply_to_message
      if (reply) notes.push(`回复了 ${reply.from?.id === me?.id ? "你" : userName(reply.from)}："${summarize(reply)}"`)
      const mentioned =
        (me?.username && new RegExp(`@${me.username}\\b`, "i").test(text)) ||
        [...(m.entities ?? []), ...(m.caption_entities ?? [])].some((e: any) => e.type === "text_mention" && e.user?.id === me?.id)
      if (mentioned) notes.push("@了你")
      if (m.forward_origin) notes.push("这是一条转发的消息")
      notes.push(`消息 ID ${m.message_id}`)

      sofia.signal({
        at: typeof m.date === "number" ? m.date * 1000 : Date.now(),
        source: { kind: "room", room, sender: { id: String(from.id), name: userName(from), isOwner } },
        priority: isOwner && room.kind === "direct" ? "high" : "normal",
        content,
        notes,
      })
    }

    async function poll(): Promise<void> {
      let offset = 0
      let failures = 0
      while (!stop.signal.aborted) {
        try {
          me ??= await api("getMe")
          const updates = await api<any[]>("getUpdates", { offset, timeout: pollTimeout, allowed_updates: ["message"] }, (pollTimeout + 10) * 1000)
          failures = 0
          for (const update of updates) {
            offset = Math.max(offset, update.update_id + 1)
            if (!update.message) continue
            try {
              await onMessage(update.message)
            } catch (e) {
              sofia.log.error(`failed to handle update ${update.update_id}: ${e instanceof Error ? e.message : String(e)}`)
            }
          }
        } catch (e) {
          if (stop.signal.aborted) return
          failures++
          if (failures === 1 || failures % 20 === 0) sofia.log.warn(`polling failed (${failures}): ${e instanceof Error ? e.message : String(e)}`)
          if (e instanceof ApiError && (e.code === 401 || e.code === 404)) {
            sofia.log.error("bot token rejected by Telegram; polling stopped")
            return
          }
          await sleep(Math.min(30_000, 1000 * 2 ** Math.min(failures - 1, 5)), stop.signal)
        }
      }
    }

    sofia.on("start", () => void poll())
    sofia.on("shutdown", () => stop.abort())
  },
})
