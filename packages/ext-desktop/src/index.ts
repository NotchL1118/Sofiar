/**
 * ext-desktop：Desktop Channel（docs/architecture.md §10.5）。
 * 本扩展就是适配层：对桌面客户端而言，它相当于 Telegram 服务器之于 ext-telegram。
 * 协议见 apps/desktop/README.md。
 */
import type { IncomingMessage } from "node:http"
import { defineExtension, type RoomRef, type Signal } from "@sofia/core"
import { type WebSocket, WebSocketServer } from "ws"

export interface DesktopConfig {
  /** 默认 47822 */
  port?: number
  /** 额外允许的网页来源（如开发服务器 http://localhost:5173）。非网页客户端（Electron file://、本地脚本）始终允许 */
  allowedOrigins?: string[]
  /** 单张图片 base64 的上限（字符数），默认约 8MB */
  maxImageChars?: number
}

export const ROOM: RoomRef = { channel: "desktop", id: "desktop:direct:main", label: "桌面", kind: "direct" }

type ClientMessage =
  | { type: "hello"; expressions?: unknown; motions?: unknown }
  | { type: "say"; text?: unknown; images?: unknown }
  | { type: "stop" }

const names = (value: unknown): string[] =>
  Array.isArray(value) ? [...new Set(value.filter((v): v is string => typeof v === "string" && v.length > 0 && v.length <= 64))].slice(0, 100) : []

export default defineExtension<DesktopConfig>({
  name: "desktop",
  configSchema: {
    type: "object",
    properties: {
      port: { type: "number", description: "WebSocket 端口，默认 47822" },
      allowedOrigins: { type: "array", items: { type: "string" }, description: "额外允许连接的网页来源" },
      maxImageChars: { type: "number" },
    },
  },
  setup(sofia) {
    const config = sofia.config ?? {}
    const port = config.port ?? 47822
    const maxImage = config.maxImageChars ?? 11_000_000
    const clients = new Set<WebSocket>()
    let server: WebSocketServer | undefined

    /** 能力来自最近一次 hello；全部断开后清空。变化在下一个 Run 开始生效。 */
    let registered: { unregister(): void }[] = []
    const clearCapabilities = () => {
      for (const r of registered.splice(0)) r.unregister()
    }
    const broadcast = (message: object) => {
      const data = JSON.stringify(message)
      for (const ws of clients) if (ws.readyState === ws.OPEN) ws.send(data)
    }

    function setCapabilities(expressions: string[], motions: string[]): void {
      clearCapabilities()
      const lines = ["# 桌面", "主人的电脑桌面上有你的形象，主人正通过它和你说话；这个 Room 是 desktop:direct:main。"]
      const tool = (kind: "expression" | "motion", options: string[], what: string) => {
        if (options.length === 0) return
        const reg = sofia.registerTool({
          name: kind,
          label: what,
          description: `让桌面上的形象${what}。可用：${options.join("、")}`,
          parameters: { type: "object", properties: { name: { type: "string", enum: options } }, required: ["name"] },
          execute: async (_id, p: { name: string }) => {
            if (!options.includes(p.name)) throw new Error(`没有这个${kind === "expression" ? "表情" : "动作"}：${p.name}`)
            if (clients.size === 0) throw new Error("桌面客户端没有连接")
            broadcast({ type: kind, name: p.name })
            return { content: [{ type: "text", text: "好了" }], details: undefined }
          },
        })
        registered.push(reg)
        lines.push(`用 ${reg.name} 可以${what}：${options.join("、")}`)
      }
      tool("expression", expressions, "做表情")
      tool("motion", motions, "做动作")
      if (registered.length > 0) lines.push("表情和动作是说话时的点缀，想用再用，不必每次都用。")
      const text = lines.join("\n")
      const unregister = sofia.registerSection("channel:desktop", () => text)
      registered.push({ unregister })
    }

    sofia.registerChannel({
      debounceMs: 0,
      deliver: async (_room, text) => {
        if (clients.size === 0) return sofia.log.info("desktop client not connected; reply dropped")
        broadcast({ type: "reply_end", text })
      },
      onDelta: (_room, delta) => broadcast({ type: "reply_delta", text: delta }),
      onRunError: (_room, error) => broadcast({ type: "error", message: error.message }),
    })

    function onMessage(ws: WebSocket, raw: string): void {
      let message: ClientMessage
      try {
        message = JSON.parse(raw)
      } catch {
        return ws.send(JSON.stringify({ type: "error", message: "invalid JSON" }))
      }
      switch (message?.type) {
        case "hello":
          setCapabilities(names(message.expressions), names(message.motions))
          return
        case "say": {
          const content: Signal["content"] = []
          const text = typeof message.text === "string" ? message.text.trim() : ""
          if (text) content.push({ type: "text", text })
          for (const image of Array.isArray(message.images) ? message.images.slice(0, 8) : []) {
            const { data, mimeType } = (image ?? {}) as { data?: unknown; mimeType?: unknown }
            if (typeof data === "string" && typeof mimeType === "string" && /^image\//.test(mimeType) && data.length <= maxImage) {
              content.push({ type: "image", data, mimeType })
            }
          }
          if (content.length === 0) return
          // sender 恒为主人：能连上本机这个端口的就是主人（见 verifyClient）
          sofia.signal({ source: { kind: "room", room: ROOM, sender: { id: "owner", name: "主人", isOwner: true } }, priority: "high", content })
          return
        }
        case "stop":
          return sofia.abortRun("desktop stop")
        default:
          ws.send(JSON.stringify({ type: "error", message: `unknown message type: ${String((message as any)?.type)}` }))
      }
    }

    /** 浏览器里的任意网页都能连 localhost；它们无法伪造 Origin，所以拒绝未列入的 http(s) 来源。 */
    const originAllowed = (req: IncomingMessage) => {
      const origin = req.headers.origin
      if (!origin || !/^https?:\/\//i.test(origin)) return true
      return (config.allowedOrigins ?? []).includes(origin)
    }

    sofia.on("start", async () => {
      const wss = new WebSocketServer({ host: "127.0.0.1", port, maxPayload: 64 * 1024 * 1024, verifyClient: ({ req }: { req: IncomingMessage }) => originAllowed(req) })
      await new Promise<void>((resolve) => {
        wss.once("listening", () => {
          server = wss
          resolve()
        })
        wss.once("error", (e) => {
          sofia.log.error(`cannot listen on 127.0.0.1:${port}: ${e.message}`)
          resolve()
        })
      })
      wss.on("connection", (ws) => {
        clients.add(ws)
        ws.on("message", (data, isBinary) => {
          if (isBinary) return
          try {
            onMessage(ws, data.toString())
          } catch (e) {
            sofia.log.error(`desktop message failed: ${e instanceof Error ? e.message : String(e)}`)
          }
        })
        ws.on("close", () => {
          clients.delete(ws)
          if (clients.size === 0) clearCapabilities()
        })
        ws.on("error", () => {})
      })
    })

    sofia.on("shutdown", async () => {
      for (const ws of clients) ws.terminate()
      await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()))
    })
  },
})
