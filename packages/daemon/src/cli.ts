#!/usr/bin/env node
/**
 * sofia CLI（docs/architecture.md §11）
 *   sofia start [--terminal] [--no-supervise]   前台运行 daemon（含监督重启）
 *   sofia export [--since <date>]               Timeline 导出 JSONL
 *   sofia check                                 校验配置与各扩展 schema
 */
import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { type SofiaEvent, Timeline, validateExtensionConfig } from "@sofia/core"
import { checkConfig, readConfig, readSecrets, sofiaHome } from "./config.ts"
import { RESTART_EXIT_CODE, startDaemon } from "./daemon.ts"
import { loadExtensions } from "./extensions.ts"
import { buildModelRuntime } from "./models.ts"
import { createTerminalExtension } from "./terminal.ts"

const [command, ...args] = process.argv.slice(2)
const has = (flag: string) => args.includes(flag)
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** 监督进程：子进程以约定退出码退出时重新拉起。 */
function supervise(): void {
  const launch = () => {
    const child = spawn(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), "start", ...args], {
      stdio: "inherit",
      env: { ...process.env, SOFIA_SUPERVISED: "1" },
    })
    child.on("exit", (code, signal) => {
      if (code === RESTART_EXIT_CODE) return launch()
      process.exit(code ?? (signal ? 1 : 0))
    })
    for (const sig of ["SIGINT", "SIGTERM"] as const) {
      process.removeAllListeners(sig)
      process.on(sig, () => child.kill(sig))
    }
  }
  launch()
}

function logEvent(e: SofiaEvent): void {
  if (e.type === "ext_error") console.error(`[${e.ext}] error: ${e.error}`)
  else if (e.type === "log" && e.level !== "debug") console.error(`[${e.ext}] ${e.level}: ${e.message}`)
  else if (e.type === "hook" && e.error) console.error(`[${e.ext}] hook ${e.event}: ${e.error}`)
  else if (e.type === "run_end" && e.status === "error") console.error(`[run] ${e.error}`)
  else if (e.type === "compaction" && !e.ok && e.error !== "nothing to compact") console.error(`[compaction] ${e.error}`)
}

async function start(): Promise<void> {
  if (!has("--no-supervise") && !process.env.SOFIA_SUPERVISED) return supervise()
  let exitCode = 0
  const daemon = await startDaemon({
    extraExtensions: has("--terminal") ? [{ def: createTerminalExtension({ onQuit: () => void shutdown("quit") }) }] : [],
    onRestart: () => process.exit(RESTART_EXIT_CODE),
    onEvent: logEvent,
  })
  const keepAlive = setInterval(() => {}, 1 << 30) // 没有任何 Channel 持有句柄时也保持常驻
  for (const info of daemon.host.extensions()) {
    if (info.status === "error") console.error(`[${info.name}] not loaded: ${info.error}`)
  }
  async function shutdown(reason: string): Promise<void> {
    try {
      await daemon.stop(reason)
    } catch (e) {
      console.error(errorText(e))
      exitCode = 1
    }
    clearInterval(keepAlive)
    process.exit(exitCode)
  }
  process.on("SIGINT", () => void shutdown("SIGINT"))
  process.on("SIGTERM", () => void shutdown("SIGTERM"))
}

function exportTimeline(): void {
  const dbPath = join(sofiaHome(), "timeline.db")
  if (!existsSync(dbPath)) throw new Error(`no timeline at ${dbPath}`)
  const sinceArg = args[args.indexOf("--since") + 1]
  const since = has("--since") ? Date.parse(sinceArg ?? "") : undefined
  if (since !== undefined && Number.isNaN(since)) throw new Error(`invalid --since date: ${sinceArg}`)
  const timeline = new Timeline(dbPath)
  try {
    for (const entry of timeline.query(since === undefined ? {} : { since })) process.stdout.write(`${JSON.stringify(entry)}\n`)
  } finally {
    timeline.close()
  }
}

async function check(): Promise<void> {
  const home = sofiaHome()
  const config = readConfig(home)
  const problems = checkConfig(config)
  if (problems.length === 0) {
    try {
      buildModelRuntime(config, readSecrets(home))
    } catch (e) {
      problems.push(errorText(e))
    }
    const { loaded, skipped } = await loadExtensions(config, home)
    for (const info of skipped) if (info.status === "error") problems.push(`extension ${info.use}: ${info.error}`)
    for (const ext of loaded) {
      for (const p of validateExtensionConfig(ext.def.configSchema, ext.config)) problems.push(`extension ${ext.use}: config ${p}`)
    }
  }
  if (problems.length === 0) return console.log(`OK: ${join(home, "config.json")}`)
  for (const p of problems) console.error(`- ${p}`)
  process.exit(1)
}

const commands: Record<string, () => void | Promise<void>> = { start, export: exportTimeline, check }
const run = command ? commands[command] : undefined
if (!run) {
  console.error("usage: sofia <start [--terminal] [--no-supervise] | export [--since <date>] | check>")
  process.exit(command ? 1 : 0)
} else {
  try {
    await run()
  } catch (e) {
    console.error(errorText(e))
    process.exit(1)
  }
}
