/**
 * 依据 config.json 的 providers / models 构建内核使用的 ModelRuntime（docs/architecture.md §9.1）。
 * 内置 provider 沿用 pi-ai 的定义；自定义 provider 用 createProvider 注册。
 */
import { type Api, createModels, createProvider, envApiKeyAuth, type Model, type ProviderStreams } from "@earendil-works/pi-ai"
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy"
import { googleGenerativeAIApi } from "@earendil-works/pi-ai/api/google-generative-ai.lazy"
import { mistralConversationsApi } from "@earendil-works/pi-ai/api/mistral-conversations.lazy"
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy"
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy"
import { builtinProviders } from "@earendil-works/pi-ai/providers/all"
import type { ModelRuntime, ResolvedModel, SofiaConfig } from "@sofia/core"
import { isBuiltinProvider, type ProviderConfig, type Secrets, SUPPORTED_APIS } from "./config.ts"

const APIS: Record<(typeof SUPPORTED_APIS)[number], () => ProviderStreams> = {
  "openai-completions": openAICompletionsApi,
  "openai-responses": openAIResponsesApi,
  "anthropic-messages": anthropicMessagesApi,
  "google-generative-ai": googleGenerativeAIApi,
  "mistral-conversations": mistralConversationsApi,
}

/** 假定 config 已通过 checkConfig；Model Role 引用了不存在的模型时抛异常。 */
export function buildModelRuntime(config: SofiaConfig, secrets: Secrets, env: Record<string, string | undefined> = process.env): ModelRuntime {
  const providers = (config.providers ?? {}) as Record<string, ProviderConfig>
  const models = createModels()
  const builtin = new Map(builtinProviders().map((p) => [p.id, p]))
  const used = new Set([...Object.keys(providers), ...Object.values(config.models ?? {}).map((m) => m.provider)])

  for (const name of used) {
    const def = providers[name]
    if (isBuiltinProvider(name)) {
      const provider = builtin.get(name)
      if (provider) models.setProvider(provider)
      continue
    }
    if (!def?.api || !def.baseUrl || !def.models) throw new Error(`provider "${name}" is not defined`)
    const api = def.api as (typeof SUPPORTED_APIS)[number]
    models.setProvider(
      createProvider({
        id: name,
        name,
        baseUrl: def.baseUrl,
        auth: { apiKey: envApiKeyAuth(`${name} API key`, def.secret ? [def.secret] : []) },
        models: def.models.map(
          (m): Model<Api> => ({
            name: m.id,
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            ...m,
            api,
            provider: name,
            baseUrl: def.baseUrl!,
          }),
        ),
        api: APIS[api](),
      }),
    )
  }

  const roles: Record<string, ResolvedModel> = {}
  for (const [role, ref] of Object.entries(config.models ?? {})) {
    const model = models.getModel(ref.provider, ref.id)
    if (!model) throw new Error(`models.${role}: provider "${ref.provider}" has no model "${ref.id}"`)
    roles[role] = { model, ...(ref.thinking ? { thinking: ref.thinking } : {}) }
  }
  const main = roles.main
  if (!main) throw new Error("models.main is required")

  /** secret 指向 secrets.json 键名或同名环境变量；未配置时交给 pi-ai 的默认解析。 */
  const apiKeyFor = (provider: string): string | undefined => {
    const secret = providers[provider]?.secret
    return secret ? secrets[secret] || env[secret] || undefined : undefined
  }
  const withKey = <O extends { apiKey?: string }>(provider: string, options: O | undefined): O => {
    const apiKey = options?.apiKey ?? apiKeyFor(provider)
    return { ...(options as O), ...(apiKey ? { apiKey } : {}) }
  }

  return {
    resolve: (role) => roles[role] ?? main,
    stream: (model, context, options) => models.streamSimple(model, context, withKey(model.provider, options)),
    complete: (model, context, options) => models.completeSimple(model, context, withKey(model.provider, options)),
  }
}
