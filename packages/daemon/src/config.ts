/**
 * config.json / secrets.json 的读写与校验（docs/architecture.md §9）。
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { getBuiltinProviders } from "@earendil-works/pi-ai/providers/all"
import type { SofiaConfig } from "@sofia/core"

export interface CustomModelDef {
  id: string
  contextWindow: number
  maxTokens: number
  [key: string]: unknown
}

export interface ProviderConfig {
  /** secrets.json 键名或同名环境变量 */
  secret?: string
  /** 以下三项只用于自定义 provider */
  api?: string
  baseUrl?: string
  models?: CustomModelDef[]
}

export type Secrets = Record<string, string>

export const SUPPORTED_APIS = [
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
  "google-generative-ai",
  "mistral-conversations",
] as const

export function sofiaHome(): string {
  return process.env.SOFIA_HOME || join(homedir(), ".sofia")
}

function readJson(path: string): unknown {
  const contents = readFileSync(path, "utf8")
  try {
    return JSON.parse(contents)
  } catch {
    // JSON.parse 的错误可能带有文件原文，尤其不能把 secrets.json 的片段写入日志。
    throw new Error(`${path}: invalid JSON`)
  }
}

export function readConfig(home: string): SofiaConfig {
  const path = join(home, "config.json")
  if (!existsSync(path)) {
    throw new Error(`config.json not found at ${path}. Create it first (see docs/architecture.md §9.1).`)
  }
  return readJson(path) as SofiaConfig
}

export function readSecrets(home: string): Secrets {
  const path = join(home, "secrets.json")
  return existsSync(path) ? (readJson(path) as Secrets) : {}
}

/** 校验后原子写入 config.json。 */
export function writeConfig(home: string, config: SofiaConfig): void {
  const problems = checkConfig(config)
  if (problems.length > 0) throw new Error(`invalid config: ${problems.join("; ")}`)
  const path = join(home, "config.json")
  writeFileSync(`${path}.tmp`, `${JSON.stringify(config, null, 2)}\n`)
  renameSync(`${path}.tmp`, path)
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)

function checkCompaction(config: unknown): string[] {
  const path = "kernel.compaction"
  if (!isObject(config)) return [`${path} must be an object`]
  const problems: string[] = []
  const checkBudget = (budget: Record<string, unknown>, at: string) => {
    for (const key of ["reserveTokens", "keepRecentTokens"]) {
      const value = budget[key]
      if (value !== undefined && (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)) {
        problems.push(`${at}.${key} must be a non-negative safe integer`)
      }
    }
  }
  checkBudget(config, path)
  const overrides = config.modelOverrides
  if (overrides === undefined) return problems
  if (!isObject(overrides)) return [...problems, `${path}.modelOverrides must be an object`]
  for (const [model, budget] of Object.entries(overrides)) {
    const at = `${path}.modelOverrides[${JSON.stringify(model)}]`
    const slash = model.indexOf("/")
    if (slash < 1 || !model.slice(0, slash).trim() || !model.slice(slash + 1).trim()) {
      problems.push(`${at} key must be provider/modelId`)
    }
    if (isObject(budget)) checkBudget(budget, at)
    else problems.push(`${at} must be an object`)
  }
  return problems
}

export function isBuiltinProvider(name: string): boolean {
  return (getBuiltinProviders() as string[]).includes(name)
}

/** 结构性校验：provider 定义、自定义模型、Model Role 引用、扩展条目。返回问题列表。 */
export function checkConfig(config: unknown): string[] {
  const problems: string[] = []
  if (!isObject(config)) return ["config must be a JSON object"]

  const providers = isObject(config.providers) ? (config.providers as Record<string, ProviderConfig>) : {}
  if (config.providers !== undefined && !isObject(config.providers)) problems.push("providers must be an object")
  for (const [name, p] of Object.entries(providers)) {
    if (!isObject(p)) {
      problems.push(`providers.${name} must be an object`)
      continue
    }
    const custom = p.api !== undefined || p.baseUrl !== undefined || p.models !== undefined
    if (!custom) {
      if (!isBuiltinProvider(name)) problems.push(`providers.${name}: not a built-in provider; custom providers need api, baseUrl and models`)
      continue
    }
    if (isBuiltinProvider(name)) problems.push(`providers.${name}: built-in provider name cannot be redefined as a custom provider`)
    if (typeof p.api !== "string" || !(SUPPORTED_APIS as readonly string[]).includes(p.api)) {
      problems.push(`providers.${name}.api must be one of ${SUPPORTED_APIS.join(", ")}`)
    }
    if (typeof p.baseUrl !== "string" || p.baseUrl === "") problems.push(`providers.${name}.baseUrl is required`)
    if (!Array.isArray(p.models) || p.models.length === 0) {
      problems.push(`providers.${name}.models is required for custom providers`)
      continue
    }
    for (const [i, m] of p.models.entries()) {
      const at = `providers.${name}.models[${i}]`
      if (!isObject(m) || typeof m.id !== "string" || m.id === "") problems.push(`${at}.id is required`)
      for (const key of ["contextWindow", "maxTokens"] as const) {
        if (!isObject(m) || typeof m[key] !== "number" || !(m[key] > 0)) problems.push(`${at}.${key} must be a positive number`)
      }
    }
  }

  const models = isObject(config.models) ? config.models : {}
  if (!isObject(models.main)) problems.push("models.main is required")
  for (const [role, ref] of Object.entries(models)) {
    if (!isObject(ref) || typeof ref.provider !== "string" || typeof ref.id !== "string") {
      problems.push(`models.${role} must have provider and id`)
      continue
    }
    const provider = providers[ref.provider]
    if (!provider && !isBuiltinProvider(ref.provider)) {
      problems.push(`models.${role}: unknown provider "${ref.provider}"`)
    } else if (Array.isArray(provider?.models) && !provider.models.some((m) => m?.id === ref.id)) {
      problems.push(`models.${role}: provider "${ref.provider}" has no model "${ref.id}"`)
    }
  }

  if (isObject(config.kernel) && config.kernel.compaction !== undefined) {
    problems.push(...checkCompaction(config.kernel.compaction))
  }
  if (config.extensions !== undefined && !Array.isArray(config.extensions)) problems.push("extensions must be an array")
  for (const [i, ext] of (Array.isArray(config.extensions) ? config.extensions : []).entries()) {
    if (!isObject(ext) || typeof ext.use !== "string" || ext.use === "") problems.push(`extensions[${i}].use is required`)
  }
  return problems
}
