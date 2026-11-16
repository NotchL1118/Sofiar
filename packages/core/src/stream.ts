/**
 * 给 streamFn 包一层退避重试（docs/architecture.md §5.4）。
 * 重试只发生在尚未产生任何内容事件之前；一旦有增量推出就原样透传，避免同一段话被重复推送。
 */
import type { StreamFn } from "@earendil-works/pi-agent-core"
import {
  type AssistantMessageEvent,
  createAssistantMessageEventStream,
  isContextOverflow,
  isRetryableAssistantError,
  retryDelayMs,
} from "@earendil-works/pi-ai"

const CONTENT_EVENTS = new Set<AssistantMessageEvent["type"]>([
  "text_delta",
  "text_end",
  "thinking_delta",
  "thinking_end",
  "toolcall_start",
  "toolcall_delta",
  "toolcall_end",
])

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve()
    const done = () => {
      clearTimeout(timer)
      signal?.removeEventListener("abort", done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal?.addEventListener("abort", done, { once: true })
  })
}

export function withRetry(
  base: StreamFn,
  policy: { maxRetries: number; baseDelayMs: number },
  onRetry?: (info: { attempt: number; delayMs: number; error: string }) => void,
): StreamFn {
  return (model, context, options) => {
    const out = createAssistantMessageEventStream()
    const signal = options?.signal
    void (async () => {
      for (let attempt = 0; ; attempt++) {
        const held: AssistantMessageEvent[] = []
        let flowing = false
        let retry = false
        try {
          const inner = await base(model, context, options)
          for await (const event of inner) {
            if (flowing) {
              out.push(event)
              continue
            }
            if (event.type === "error") {
              const failed = event.error
              retry =
                event.reason === "error" &&
                attempt < policy.maxRetries &&
                !signal?.aborted &&
                !isContextOverflow(failed, model.contextWindow) &&
                isRetryableAssistantError(failed)
              if (retry) {
                const delayMs = retryDelayMs({ baseDelayMs: policy.baseDelayMs }, attempt + 1)
                onRetry?.({ attempt: attempt + 1, delayMs, error: failed.errorMessage ?? "unknown error" })
                await sleep(delayMs, signal)
                break
              }
            }
            held.push(event)
            if (CONTENT_EVENTS.has(event.type) || event.type === "done" || event.type === "error") {
              flowing = true
              for (const e of held) out.push(e)
            }
          }
        } catch (e) {
          // StreamFn 契约上不应抛异常；兜底为一条 error 消息
          out.push({
            type: "error",
            reason: "error",
            error: {
              role: "assistant",
              content: [],
              api: model.api,
              provider: model.provider,
              model: model.id,
              usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
              stopReason: "error",
              errorMessage: e instanceof Error ? e.message : String(e),
              timestamp: Date.now(),
            },
          })
          return
        }
        if (!retry) return
      }
    })()
    return out
  }
}
