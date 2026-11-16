/**
 * ext-admin：本地管理接口（docs/architecture.md §10.8）。
 * 监听 127.0.0.1，提供 HTTP API + 事件流 WebSocket，并托管 apps/admin-web 的静态文件。
 * 接口清单见 apps/admin-web/README.md。
 */
import { existsSync, readFileSync, statSync } from "node:fs"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { createRequire } from "node:module"
import { dirname, extname, join, normalize, resolve, sep } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { defineExtension, type SofiaConfig } from "@sofia/core"
import { type WebSocket, WebSocketServer } from "ws"

export interface AdminConfig {
  /** 默认 47820 */
  port?: number
  /** 静态文件目录，默认 @sofia/admin-web 包所在目录 */
  staticDir?: string
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
}
const STREAM_SKIPPED = new Set(["message_update", "tool_execution_update"])

/** 图片的 base64 不发给页面。 */
const withoutImages = (_key: string, value: any) =>
  value && value.type === "image" && typeof value.data === "string" ? { type: "image", mimeType: value.mimeType, data: "", omitted: value.data.length } : value

class HttpError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export default defineExtension<AdminConfig>({
  name: "admin",
  configSchema: {
    type: "object",
    properties: {
      port: { type: "number", description: "管理页端口，默认 47820" },
      staticDir: { type: "string", description: "静态文件目录（默认使用内置的 admin-web）" },
    },
  },
  setup(sofia) {
    const config = sofia.config ?? {}
    const port = config.port ?? 47820
    const staticDir = resolve(config.staticDir ?? dirname(createRequire(import.meta.url).resolve("@sofia/admin-web/package.json")))
    const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`])
    const sockets = new Set<WebSocket>()

    /** 只接受发往本机地址、且（若带 Origin）来自管理页自身的请求：挡住别的网页的跨站请求与 DNS 重绑定。 */
    const trusted = (req: IncomingMessage) => {
      const host = req.headers.host ?? ""
      const origin = req.headers.origin
      return hosts.has(host) && (!origin || origin === `http://${host}`)
    }

    const num = (v: string | null) => (v !== null && v !== "" && Number.isFinite(Number(v)) ? Number(v) : undefined)
    const list = (v: string | null) => (v ? v.split(",").filter(Boolean) : undefined)

    function queryTrace(q: URLSearchParams): unknown[] {
      const path = join(sofia.home, "trace.db")
      if (!existsSync(path)) return []
      const db = new DatabaseSync(path, { readOnly: true })
      try {
        const where: string[] = []
        const params: (string | number)[] = []
        const since = num(q.get("since"))
        const until = num(q.get("until"))
        const kinds = list(q.get("kinds"))
        if (since !== undefined) (where.push("at >= ?"), params.push(since))
        if (until !== undefined) (where.push("at <= ?"), params.push(until))
        if (q.get("runId")) (where.push("run_id = ?"), params.push(q.get("runId")!))
        if (kinds) (where.push(`kind IN (${kinds.map(() => "?").join(",")})`), params.push(...kinds))
        const limit = Math.min(Math.max(num(q.get("limit")) ?? 2000, 1), 20000)
        const rows = db
          .prepare(`SELECT * FROM events ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY seq DESC LIMIT ?`)
          .all(...params, limit) as any[]
        return rows.reverse().map((r) => ({ ...r, data: r.data ? JSON.parse(r.data) : null }))
      } finally {
        db.close()
      }
    }

    async function readBody(req: IncomingMessage): Promise<unknown> {
      const chunks: Buffer[] = []
      let size = 0
      for await (const chunk of req) {
        size += (chunk as Buffer).length
        if (size > 2_000_000) throw new HttpError(413, "body too large")
        chunks.push(chunk as Buffer)
      }
      try {
        return JSON.parse(Buffer.concat(chunks).toString("utf8"))
      } catch {
        throw new HttpError(400, "invalid JSON body")
      }
    }

    async function api(req: IncomingMessage, url: URL): Promise<unknown> {
      const route = `${req.method} ${url.pathname}`
      const q = url.searchParams
      switch (route) {
        case "GET /api/status":
          return { run: sofia.currentRun() ?? null, extensions: sofia.host.extensions().map((e) => ({ name: e.name, status: e.status })) }
        case "GET /api/extensions":
          return sofia.host.extensions()
        case "GET /api/config":
          return sofia.host.readConfig()
        case "PUT /api/config": {
          try {
            sofia.host.writeConfig((await readBody(req)) as SofiaConfig)
          } catch (e) {
            if (e instanceof HttpError) throw e
            throw new HttpError(400, e instanceof Error ? e.message : String(e))
          }
          return { ok: true }
        }
        case "POST /api/restart":
          setTimeout(() => sofia.host.restart(), 50) // 先把响应发出去
          return { ok: true }
        case "POST /api/stop":
          sofia.abortRun("admin")
          return { ok: true }
        case "POST /api/compact":
          sofia.compact("admin")
          return { ok: true }
        case "GET /api/timeline": {
          const types = list(q.get("types"))
          const since = num(q.get("since"))
          const until = num(q.get("until"))
          return sofia.timeline.query({
            limit: Math.min(Math.max(num(q.get("limit")) ?? 100, 1), 1000),
            ...(q.get("room") ? { room: q.get("room")! } : {}),
            ...(q.get("runId") ? { runId: q.get("runId")! } : {}),
            ...(types ? { types } : {}),
            ...(since !== undefined ? { since } : {}),
            ...(until !== undefined ? { until } : {}),
          })
        }
        case "GET /api/trace":
          return queryTrace(q)
        default:
          throw new HttpError(404, `no route: ${route}`)
      }
    }

    function serveStatic(res: ServerResponse, pathname: string): void {
      const rel = normalize(decodeURIComponent(pathname === "/" ? "/index.html" : pathname))
      const file = join(staticDir, rel)
      if (!file.startsWith(staticDir + sep) || !existsSync(file) || !statSync(file).isFile() || !(extname(file) in MIME) || rel.endsWith("package.json")) {
        res.writeHead(404, { "content-type": "text/plain" }).end("not found")
        return
      }
      res.writeHead(200, { "content-type": MIME[extname(file)]!, "cache-control": "no-cache" }).end(readFileSync(file))
    }

    const server = createServer((req, res) => {
      void (async () => {
        if (!trusted(req)) return void res.writeHead(403, { "content-type": "text/plain" }).end("forbidden")
        const url = new URL(req.url ?? "/", `http://${req.headers.host}`)
        if (!url.pathname.startsWith("/api/")) {
          if (req.method !== "GET" && req.method !== "HEAD") return void res.writeHead(405).end()
          return serveStatic(res, url.pathname)
        }
        try {
          const body = JSON.stringify(await api(req, url), withoutImages)
          res.writeHead(200, { "content-type": MIME[".json"]!, "cache-control": "no-store" }).end(body)
        } catch (e) {
          const status = e instanceof HttpError ? e.status : 500
          res.writeHead(status, { "content-type": MIME[".json"]! }).end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }))
        }
      })()
    })

    const wss = new WebSocketServer({ noServer: true })
    server.on("upgrade", (req, socket, head) => {
      if (!trusted(req) || new URL(req.url ?? "/", "http://x").pathname !== "/api/events") return socket.destroy()
      wss.handleUpgrade(req, socket, head, (ws) => {
        sockets.add(ws)
        ws.on("close", () => sockets.delete(ws))
        ws.on("error", () => {})
      })
    })
    const unsubscribe = sofia.events.subscribe((e) => {
      if (sockets.size === 0 || STREAM_SKIPPED.has(e.type)) return
      let data: string
      try {
        data = JSON.stringify(e, withoutImages)
      } catch {
        return
      }
      for (const ws of sockets) if (ws.readyState === ws.OPEN) ws.send(data)
    })

    sofia.on("start", async () => {
      await new Promise<void>((done) => {
        server.once("error", (e) => {
          sofia.log.error(`cannot listen on 127.0.0.1:${port}: ${e.message}`)
          done()
        })
        server.listen(port, "127.0.0.1", () => {
          sofia.log.info(`admin page: http://127.0.0.1:${port}/`)
          done()
        })
      })
    })
    sofia.on("shutdown", async () => {
      unsubscribe()
      for (const ws of sockets) ws.terminate()
      server.closeAllConnections()
      await new Promise<void>((done) => (server.listening ? server.close(() => done()) : done()))
    })
  },
})
