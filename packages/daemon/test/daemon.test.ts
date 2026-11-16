import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PassThrough } from "node:stream"
import { fileURLToPath } from "node:url"
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai"
import { createModelRuntime } from "@sofia/core"
import { describe, expect, it } from "vitest"
import { acquireLock, buildModelRuntime, checkConfig, createTerminalExtension, startDaemon } from "../src/index.ts"

const tmp = () => mkdtempSync(join(tmpdir(), "sofia-daemon-"))
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms))

const baseConfig = {
  providers: {
    anthropic: { secret: "ANTHROPIC_API_KEY" },
    "my-proxy": {
      api: "openai-completions",
      baseUrl: "https://example.com/v1",
      secret: "PROXY_KEY",
      models: [{ id: "deepseek-chat", contextWindow: 128000, maxTokens: 8192 }],
    },
  },
  models: { main: { provider: "my-proxy", id: "deepseek-chat", thinking: "low" as const } },
}

function fauxModels() {
  const faux = fauxProvider()
  const models = createModels()
  models.setProvider(faux.provider)
  return { faux, runtime: createModelRuntime(models, { main: { model: faux.getModel() } }) }
}

describe("单实例锁", () => {
  it("被存活进程占用时拒绝；残留锁被接管；释放后可再次获取", () => {
    const home = tmp()
    const release = acquireLock(home)
    expect(() => acquireLock(home)).toThrow(/already running/)
    release()
    expect(existsSync(join(home, "daemon.lock"))).toBe(false)

    const dead = spawnSync(process.execPath, ["-e", ""]).pid!
    writeFileSync(join(home, "daemon.lock"), String(dead))
    const again = acquireLock(home)
    expect(readFileSync(join(home, "daemon.lock"), "utf8")).toBe(String(process.pid))
    again()
  })
})

describe("配置", () => {
  it("checkConfig 报出各类问题", () => {
    expect(checkConfig(baseConfig)).toEqual([])
    expect(checkConfig({})).toEqual(["models.main is required"])
    const problems = checkConfig({
      providers: { nope: {}, proxy: { api: "soap", baseUrl: "x", models: [{ id: "m" }] }, anthropic: { baseUrl: "x" } },
      models: { main: { provider: "ghost", id: "x" }, cheap: { provider: "my", id: "y" } },
      extensions: [{ enabled: false }],
    })
    expect(problems).toEqual(
      expect.arrayContaining([
        expect.stringContaining("providers.nope: not a built-in provider"),
        expect.stringContaining("providers.proxy.api must be one of"),
        "providers.proxy.models[0].contextWindow must be a positive number",
        "providers.proxy.models[0].maxTokens must be a positive number",
        expect.stringContaining("providers.anthropic: built-in provider name cannot be redefined"),
        'models.main: unknown provider "ghost"',
        "extensions[0].use is required",
      ]),
    )
    expect(checkConfig({ ...baseConfig, models: { main: { provider: "my-proxy", id: "missing" } } })).toEqual([
      'models.main: provider "my-proxy" has no model "missing"',
    ])
  })

  it("buildModelRuntime：自定义 provider 的模型元数据、未配置的角色回退 main、内置模型不存在时报错", () => {
    const runtime = buildModelRuntime(baseConfig, {})
    const main = runtime.resolve("main")
    expect(main).toMatchObject({ thinking: "low", model: { id: "deepseek-chat", provider: "my-proxy", api: "openai-completions", contextWindow: 128000, maxTokens: 8192, baseUrl: "https://example.com/v1" } })
    expect(runtime.resolve("cheap")).toBe(main)
    expect(() => buildModelRuntime({ models: { main: { provider: "anthropic", id: "no-such-model" } } }, {})).toThrow(/has no model "no-such-model"/)
  })
})

describe("daemon", () => {
  it("加载本地 TS 扩展、跑通一次对话；禁用与失败的扩展被跳过；单实例；host 读写配置", async () => {
    const home = tmp()
    writeFileSync(
      join(home, "echo.ts"),
      `import { defineExtension } from "@sofia/core"
       export default defineExtension({
         name: "echo",
         configSchema: { type: "object", properties: { tag: { type: "string" } }, required: ["tag"] },
         setup(sofia) {
           const g = globalThis as any
           g.__echo = { sofia, delivered: [] }
           sofia.registerChannel({ debounceMs: 0, deliver: async (_r, text) => void g.__echo.delivered.push(sofia.config.tag + text) })
         },
       })`,
    )
    const config = {
      ...baseConfig,
      extensions: [
        { use: "./echo.ts", config: { tag: "> " } },
        { use: "./missing.ts" },
        { use: "./echo.ts", enabled: false },
      ],
    }
    writeFileSync(join(home, "config.json"), JSON.stringify(config))
    const { faux, runtime } = fauxModels()
    const daemon = await startDaemon({ home, models: runtime })
    try {
      await expect(startDaemon({ home, models: runtime })).rejects.toThrow(/already running/)
      expect(daemon.host.extensions().map((e) => [e.name, e.status])).toEqual([["echo", "loaded"], ["./missing.ts", "error"], ["./echo.ts", "disabled"]])

      const echo = (globalThis as any).__echo
      faux.setResponses([fauxAssistantMessage("你好")])
      const room = { channel: "echo", id: "echo:direct:main", label: "main", kind: "direct" as const }
      echo.sofia.signal({ source: { kind: "room", room, sender: { id: "o", name: "主人", isOwner: true } }, priority: "high", content: [{ type: "text", text: "在吗" }] })
      await daemon.kernel.whenIdle()
      expect(echo.delivered).toEqual(["> 你好"])
      expect(existsSync(join(home, "timeline.db"))).toBe(true)

      expect(echo.sofia.host.readConfig()).toEqual(config)
      expect(() => echo.sofia.host.writeConfig({ models: {} })).toThrow(/models.main is required/)
      echo.sofia.host.writeConfig({ ...config, kernel: { maxTurnsPerRun: 5 } })
      expect(JSON.parse(readFileSync(join(home, "config.json"), "utf8")).kernel).toEqual({ maxTurnsPerRun: 5 })
    } finally {
      await daemon.stop()
    }
    expect(existsSync(join(home, "daemon.lock"))).toBe(false)
  })

  it("host.restart：停止后回调", async () => {
    const home = tmp()
    writeFileSync(join(home, "config.json"), JSON.stringify(baseConfig))
    let restarted = false
    const daemon = await startDaemon({ home, models: fauxModels().runtime, onRestart: () => void (restarted = true) })
    daemon.host.restart()
    await tick()
    expect(restarted).toBe(true)
    expect(existsSync(join(home, "daemon.lock"))).toBe(false)
  })

  it("配置有误时拒绝启动并释放锁", async () => {
    const home = tmp()
    writeFileSync(join(home, "config.json"), "{}")
    await expect(startDaemon({ home })).rejects.toThrow(/models.main is required/)
    expect(existsSync(join(home, "daemon.lock"))).toBe(false)
  })
})

describe("终端 Channel", () => {
  it("多 Room、主人与 Contact 身份、/stop 不产生 Signal", async () => {
    const home = tmp()
    writeFileSync(join(home, "config.json"), JSON.stringify(baseConfig))
    const { faux, runtime } = fauxModels()
    const input = new PassThrough()
    const output = new PassThrough()
    let out = ""
    output.on("data", (chunk) => (out += chunk))
    const seen: string[] = []
    faux.setResponses(
      ["私聊回复", "群里回复"].map((text) => (context: any) => {
        seen.push(JSON.stringify(context.messages.at(-1).content))
        return fauxAssistantMessage(text)
      }),
    )
    const daemon = await startDaemon({ home, models: runtime, extraExtensions: [{ def: createTerminalExtension({ input, output }) }] })
    try {
      input.write("在吗\n")
      await tick()
      await daemon.kernel.whenIdle()
      input.write("/room 摸鱼小队 group\n/as 小王\n/stop\n大家好\n")
      await tick()
      await daemon.kernel.whenIdle()

      expect(seen[0]).toMatch(/\[私聊·main · [^\]]+\] 主人（主人）：在吗/)
      expect(seen[1]).toMatch(/\[群聊·摸鱼小队 · [^\]]+\] 小王：大家好/)
      expect(seen[1]).not.toContain("小王（主人）")
      expect(out).toContain("[私聊·main] Sofia：私聊回复")
      expect(out).toContain("[群聊·摸鱼小队] Sofia：群里回复")
      const signals = daemon.kernel.timeline.query({ types: ["signal"] })
      expect(signals.map((s) => s.room)).toEqual(["terminal:direct:main", "terminal:group:摸鱼小队"])
      const system = daemon.kernel.timeline.query({ types: ["system"] })
      expect(JSON.stringify(system.map((s) => s.data))).toContain("terminal_send")
    } finally {
      // shutdown hook 关闭输入会再次触发 onQuit → stop；两次 stop 必须等到同一次收尾
      await Promise.all([daemon.stop(), daemon.stop()])
    }
    expect(existsSync(join(home, "daemon.lock"))).toBe(false)
  })
})

describe("CLI", () => {
  const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url))
  const run = (home: string, ...args: string[]) => spawnSync(process.execPath, [cli, ...args], { env: { ...process.env, SOFIA_HOME: home }, encoding: "utf8" })

  it("check 与 export", async () => {
    const home = tmp()
    writeFileSync(join(home, "config.json"), JSON.stringify({ ...baseConfig, extensions: [{ use: "./nope.ts" }] }))
    const bad = run(home, "check")
    expect(bad.status).toBe(1)
    expect(bad.stderr).toContain("extension ./nope.ts")

    writeFileSync(join(home, "config.json"), JSON.stringify(baseConfig))
    const ok = run(home, "check")
    expect(ok.stderr).toBe("")
    expect(ok.stdout).toContain("OK")

    const daemon = await startDaemon({ home, models: fauxModels().runtime })
    daemon.kernel.timeline.append({ type: "notice", data: { text: "测试" }, at: Date.parse("2026-11-01") })
    await daemon.stop()
    const lines = run(home, "export").stdout.trim().split("\n").map((l) => JSON.parse(l))
    expect(lines.map((l) => l.type)).toEqual(["system", "notice"])
    expect(run(home, "export", "--since", "2026-11-05").stdout.trim().split("\n")).toHaveLength(1)
    expect(run(home, "bogus").status).toBe(1)
  })
})
