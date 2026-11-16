/**
 * daemon：读取配置 → 构建模型 → 加载扩展 → 启动内核（docs/architecture.md §2.1、§9）。
 */
import { mkdirSync } from "node:fs"
import { createKernel, type ExtensionDef, type ExtensionInfo, type HostAPI, type Kernel, type ModelRuntime, type SofiaEvent } from "@sofia/core"
import { checkConfig, readConfig, readSecrets, sofiaHome, writeConfig } from "./config.ts"
import { loadExtensions } from "./extensions.ts"
import { acquireLock } from "./lock.ts"
import { buildModelRuntime } from "./models.ts"

/** 约定退出码：监督进程见到它就重新拉起子进程。 */
export const RESTART_EXIT_CODE = 75

export interface DaemonOptions {
  home?: string
  /** 追加在 config.json 的扩展之后（如 `--terminal` 的终端 Channel） */
  extraExtensions?: { def: ExtensionDef<any>; config?: unknown }[]
  /** 测试用：替换依据配置构建的模型 */
  models?: ModelRuntime
  /** 事件流订阅者；在内核启动之前挂上，能收到启动阶段的事件 */
  onEvent?: (e: SofiaEvent) => void
  /** `host.restart()` 被调用、daemon 已停止之后 */
  onRestart?: () => void
}

export interface Daemon {
  home: string
  kernel: Kernel
  host: HostAPI
  stop(reason?: string): Promise<void>
}

export async function startDaemon(options: DaemonOptions = {}): Promise<Daemon> {
  const home = options.home ?? sofiaHome()
  mkdirSync(home, { recursive: true })
  const release = acquireLock(home)
  try {
    const config = readConfig(home)
    const problems = checkConfig(config)
    if (problems.length > 0) throw new Error(`invalid config.json:\n  - ${problems.join("\n  - ")}`)
    const secrets = readSecrets(home)
    const models = options.models ?? buildModelRuntime(config, secrets)
    const { loaded, skipped } = await loadExtensions(config, home)

    // 幂等：并发的多次 stop 共享同一个 Promise（如 shutdown hook 里关闭输入又触发了退出）
    let stopping: Promise<void> | undefined
    const stop = (reason = "stop") => (stopping ??= kernel.stop(reason).finally(release))
    const host: HostAPI = {
      extensions: (): ExtensionInfo[] => [...kernel.extensionInfos(), ...skipped],
      readConfig: () => readConfig(home),
      writeConfig: (c) => writeConfig(home, c),
      restart: () => {
        void stop("restart").then(() => options.onRestart?.())
      },
    }
    const kernel = createKernel({
      home,
      models,
      config: config.kernel ?? {},
      extensions: [...loaded, ...(options.extraExtensions ?? [])],
      host,
      secrets: (name) => secrets[name] || process.env[name],
    })
    if (options.onEvent) kernel.events.subscribe(options.onEvent)
    await kernel.start()
    return { home, kernel, host, stop }
  } catch (e) {
    release()
    throw e
  }
}
