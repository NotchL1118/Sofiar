/**
 * 扩展加载（docs/architecture.md §9.1）：`use` 为包名或本地路径，jiti 加载，TS 免编译。
 * 加载失败：记录、跳过，daemon 继续。
 */
import { isAbsolute, resolve } from "node:path"
import { createRequire } from "node:module"
import type { ExtensionDef, ExtensionInfo, SofiaConfig } from "@sofia/core"
import { createJiti } from "jiti"

export interface LoadedExtensions {
  /** 交给内核的有序列表 */
  loaded: { def: ExtensionDef<any>; config?: unknown; use: string }[]
  /** 未进入内核的条目：禁用的与加载失败的 */
  skipped: ExtensionInfo[]
}

const isLocal = (use: string) => use.startsWith(".") || isAbsolute(use)

export async function loadExtensions(config: SofiaConfig, home: string): Promise<LoadedExtensions> {
  // 本地扩展可能在仓库之外（如 ~/.sofia/my-ext.ts），那里解析不到 @sofia/core；
  // 用别名指向 daemon 自己加载的那一份，也保证扩展与内核共用同一个模块实例。
  const jiti = createJiti(import.meta.url, {
    moduleCache: false,
    alias: { "@sofia/core": createRequire(import.meta.url).resolve("@sofia/core") },
  })
  const result: LoadedExtensions = { loaded: [], skipped: [] }
  for (const entry of config.extensions ?? []) {
    const { use } = entry
    if (entry.enabled === false) {
      result.skipped.push({ name: use, use, status: "disabled", config: entry.config })
      continue
    }
    try {
      const def = await jiti.import<ExtensionDef>(isLocal(use) ? resolve(home, use) : use, { default: true })
      if (!def || typeof def.name !== "string" || typeof def.setup !== "function") {
        throw new Error("default export is not an extension (use defineExtension)")
      }
      result.loaded.push({ def, use, ...(entry.config === undefined ? {} : { config: entry.config }) })
    } catch (e) {
      result.skipped.push({ name: use, use, status: "error", error: e instanceof Error ? e.message : String(e), config: entry.config })
    }
  }
  return result
}
