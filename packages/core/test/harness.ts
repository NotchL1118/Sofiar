import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  createModels,
  type FauxResponseStep,
  fauxAssistantMessage,
  fauxProvider,
  type Message,
  type RegisterFauxProviderOptions,
} from "@earendil-works/pi-ai"
import {
  type ChannelDef,
  createKernel,
  createModelRuntime,
  defineExtension,
  type ExtensionDef,
  type KernelOptions,
  type RoomRef,
  type SignalInput,
  type SofiaAPI,
  type SofiaEvent,
} from "../src/index.ts"

export const room = (id: string, kind: RoomRef["kind"] = "direct", channel = "fake"): RoomRef => ({
  channel,
  id: `${channel}:${kind}:${id}`,
  label: id,
  kind,
})

export function say(
  r: RoomRef,
  text: string,
  o: { owner?: boolean; priority?: SignalInput["priority"]; name?: string; at?: number } = {},
): SignalInput {
  const owner = o.owner ?? true
  return {
    source: { kind: "room", room: r, sender: { id: owner ? "owner" : "u2", name: o.name ?? (owner ? "阿洋" : "小王"), isOwner: owner } },
    priority: o.priority ?? (owner ? "high" : "normal"),
    content: [{ type: "text", text }],
    ...(o.at === undefined ? {} : { at: o.at }),
  }
}

export interface FakeChannel {
  ext: ExtensionDef
  api: SofiaAPI
  delivered: { room: string; text: string }[]
  deltas: string[]
  errors: Error[]
}

/** 测试用假 Channel：记录投递、增量与 Run 错误。 */
export function fakeChannel(def: Partial<ChannelDef> = {}, name = "fake"): FakeChannel {
  const ch = { delivered: [], deltas: [], errors: [] } as unknown as FakeChannel
  ch.ext = defineExtension({
    name,
    setup(sofia) {
      ch.api = sofia
      sofia.registerChannel({
        debounceMs: 0,
        deliver: async (r, text) => {
          ch.delivered.push({ room: r.id, text })
        },
        onDelta: (_r, delta) => {
          ch.deltas.push(delta)
        },
        onRunError: (_r, error) => {
          ch.errors.push(error)
        },
        ...def,
      })
    },
  })
  return ch
}

export function setup(
  o: {
    extensions?: (ExtensionDef<any> | { def: ExtensionDef<any>; config?: unknown })[]
    config?: KernelOptions["config"]
    faux?: RegisterFauxProviderOptions
    home?: string
    dbPath?: string
  } = {},
) {
  const faux = fauxProvider(o.faux)
  const models = createModels()
  models.setProvider(faux.provider)
  const home = o.home ?? mkdtempSync(join(tmpdir(), "sofia-test-"))
  const kernel = createKernel({
    home,
    dbPath: o.dbPath ?? ":memory:",
    models: createModelRuntime(models, { main: { model: faux.getModel() } }),
    config: { retry: { maxRetries: 3, baseDelayMs: 1 }, ...o.config },
    extensions: (o.extensions ?? []).map((e) => ("setup" in e ? { def: e } : e)),
  })
  const events: SofiaEvent[] = []
  kernel.events.subscribe((e) => events.push(e))
  /** 每次 LLM 请求看到的消息 */
  const requests: Message[][] = []
  const reply = (...steps: (string | FauxResponseStep)[]) =>
    faux.appendResponses(
      steps.map((step): FauxResponseStep => {
        const inner = typeof step === "string" ? fauxAssistantMessage(step) : step
        return async (context, options, state, model) => {
          requests.push(structuredClone(context.messages))
          return typeof inner === "function" ? inner(context, options, state, model) : inner
        }
      }),
    )
  const of = <T extends SofiaEvent["type"]>(type: T) => events.filter((e): e is Extract<SofiaEvent, { type: T }> => e.type === type)
  return { kernel, faux, home, events, of, requests, reply, entries: (types?: string[]) => kernel.timeline.query(types ? { types } : {}) }
}

/** 一次请求里全部 user 文本 */
export function userText(messages: Message[]): string {
  return messages
    .flatMap((m) => (m.role === "user" ? (typeof m.content === "string" ? [m.content] : m.content.flatMap((b) => (b.type === "text" ? [b.text] : []))) : []))
    .join("\n---\n")
}

export function deferred<T = void>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}

export const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms))
