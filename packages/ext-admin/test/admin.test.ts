import { mkdtempSync, writeFileSync } from "node:fs"
import { request } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai"
import { createKernel, createModelRuntime, type HostAPI, type SofiaConfig } from "@sofia/core"
import { afterEach, expect, it } from "vitest"
import { WebSocket } from "ws"
import trace from "../../ext-trace/src/index.ts"
import admin from "../src/index.ts"

const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms))
let port = 48500 + Math.floor(Math.random() * 400)
let cleanup: (() => Promise<void>) | undefined
afterEach(async () => {
  await cleanup?.()
  cleanup = undefined
})

async function boot() {
  port++
  const home = mkdtempSync(join(tmpdir(), "sofia-admin-"))
  const staticDir = mkdtempSync(join(tmpdir(), "sofia-admin-static-"))
  writeFileSync(join(staticDir, "index.html"), "<h1>admin</h1>")
  const faux = fauxProvider()
  const models = createModels()
  models.setProvider(faux.provider)
  let stored: SofiaConfig = { models: { main: { provider: "faux", id: "faux-1" } } }
  const calls: string[] = []
  const host: HostAPI = {
    extensions: () => kernel.extensionInfos(),
    readConfig: () => stored,
    writeConfig: (c) => {
      if (!c.models?.main) throw new Error("models.main is required")
      stored = c
    },
    restart: () => void calls.push("restart"),
  }
  const kernel = createKernel({
    home,
    dbPath: ":memory:",
    models: createModelRuntime(models, { main: { model: faux.getModel() } }),
    host,
    extensions: [{ def: trace }, { def: admin, config: { port, staticDir } }],
  })
  await kernel.start()
  cleanup = () => kernel.stop()
  const base = `http://127.0.0.1:${port}`
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(base + path, { method, headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    const text = await res.text()
    return { status: res.status, body: res.headers.get("content-type")?.includes("json") ? JSON.parse(text) : text }
  }
  return { kernel, faux, call, calls, base, get config() { return stored } }
}

it("托管静态文件；读写配置（校验失败 400）；扩展列表；停止 / 压缩 / 重启", async () => {
  const t = await boot()
  expect((await t.call("GET", "/progress-50%.html")).status).toBe(400)
  expect(await t.call("GET", "/")).toEqual({ status: 200, body: "<h1>admin</h1>" })
  expect((await t.call("GET", "/../../etc/passwd")).status).toBe(404)
  expect((await t.call("GET", "/api/extensions")).body.map((e: any) => [e.name, e.status])).toEqual([["trace", "loaded"], ["admin", "loaded"]])
  expect((await t.call("GET", "/api/extensions")).body[1].configSchema.properties.port.type).toBe("number")
  expect((await t.call("GET", "/api/status")).body).toMatchObject({ run: null })

  expect((await t.call("GET", "/api/config")).body).toEqual({ models: { main: { provider: "faux", id: "faux-1" } } })
  expect(await t.call("PUT", "/api/config", { models: {} })).toEqual({ status: 400, body: { error: "models.main is required" } })
  const next = { models: { main: { provider: "faux", id: "faux-1" } }, kernel: { maxTurnsPerRun: 9 } }
  expect((await t.call("PUT", "/api/config", next)).status).toBe(200)
  expect(t.config).toEqual(next)

  expect((await t.call("POST", "/api/stop")).body).toEqual({ ok: true })
  expect((await t.call("POST", "/api/compact")).status).toBe(200)
  expect((await t.call("POST", "/api/restart")).status).toBe(200)
  await tick(100)
  expect(t.calls).toEqual(["restart"])
  expect((await t.call("GET", "/api/nope")).status).toBe(404)
})

it("事件流 WebSocket、Timeline 浏览（不带图片数据）、Trace 查询", async () => {
  const t = await boot()
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/events`)
  const events: any[] = []
  ws.on("message", (d) => events.push(JSON.parse(d.toString())))
  await new Promise((r) => ws.once("open", r))

  t.faux.setResponses([fauxAssistantMessage("[[NO_REPLY]]")])
  t.kernel.signal({ source: { kind: "internal", from: "test" }, priority: "low", content: [{ type: "text", text: "看图" }, { type: "image", data: "QUJDREVGRw==", mimeType: "image/png" }] })
  await tick()
  await t.kernel.whenIdle()
  await tick()
  ws.close()

  const types = events.map((e) => e.type)
  for (const type of ["signal_received", "run_start", "message_end", "run_end"]) expect(types).toContain(type)
  expect(types).not.toContain("message_update")
  expect(JSON.stringify(events)).not.toContain("QUJDREVGRw==")

  const timeline = (await t.call("GET", "/api/timeline?types=signal,assistant&limit=10")).body
  expect(timeline.map((e: any) => e.type)).toEqual(["signal", "assistant"])
  expect(timeline[0].data.content[1]).toEqual({ type: "image", mimeType: "image/png", data: "", omitted: 12 })

  const runs = (await t.call("GET", "/api/trace?kinds=run_start,run_end")).body
  expect(runs.map((r: any) => r.kind)).toEqual(["run_start", "run_end"])
  expect((await t.call("GET", `/api/trace?runId=${runs[0].run_id}&limit=5`)).body).toHaveLength(5)
  expect((await t.call("GET", "/api/trace?since=99999999999999")).body).toEqual([])
})

it("拒绝跨站请求与非本机 Host", async () => {
  const t = await boot()
  expect((await t.call("POST", "/api/stop", undefined, { origin: "https://evil.example" })).status).toBe(403)
  expect((await t.call("GET", "/api/config", undefined, { origin: `http://127.0.0.1:${port}` })).status).toBe(200)
  const status = await new Promise<number>((resolve) => {
    request({ host: "127.0.0.1", port, path: "/api/config", headers: { host: "evil.example" } }, (res) => resolve(res.statusCode!)).end()
  })
  expect(status).toBe(403)
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/events`, { origin: "https://evil.example" })
  await expect(new Promise((resolve, reject) => (ws.once("open", resolve), ws.once("error", reject)))).rejects.toThrow()
})
