import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createAssistantMessageEventStream, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai"
import { describe, expect, it, vi } from "vitest"
import { defineExtension, estimateContextTokens, type HookMap, type SofiaAPI } from "../src/index.ts"
import { deferred, fakeChannel, room, say, setup, tick, userText } from "./harness.ts"

const main = room("main")
const long = (tag: string) => tag + "a".repeat(800) // ≈ 200 token
/** 窗口 2000、预留 1000 → 上下文估算超过 1000 token 即触发；保留最近约 500 token（一问一答约 400） */
const small = { faux: { models: [{ id: "faux-1", contextWindow: 2000 }] }, config: { compaction: { reserveTokens: 1000, keepRecentTokens: 500 } } }

function summarizer(onCompact?: (p: HookMap["before_compact"]["payload"]) => void) {
  const calls: HookMap["before_compact"]["payload"][] = []
  const ext = defineExtension({
    name: "compaction",
    setup: (s) =>
      void s.on("before_compact", (p) => {
        calls.push(p)
        onCompact?.(p)
        return { summary: `摘要#${calls.length}` }
      }),
  })
  return { ext, calls }
}

function stalledSummarizer() {
  const started = deferred<AbortSignal>()
  const ext = defineExtension({
    name: "slow",
    setup: (s) => void s.on("before_compact", ({ signal }) => {
      started.resolve(signal)
      return new Promise<never>(() => {})
    }),
  })
  return { ext, started: started.promise }
}

async function chat(t: ReturnType<typeof setup>, ch: ReturnType<typeof fakeChannel>, n: number, from = 1) {
  for (let i = from; i < from + n; i++) {
    t.reply(long(`答${i}`))
    ch.api.signal(say(main, long(`问${i}`)))
    await t.kernel.whenIdle()
  }
}

describe("Compaction", () => {
  it("Run 开始前超阈值：切点落在 Run 边界，compacted 在 rebuild 前完成，上下文按规则重建", async () => {
    const ch = fakeChannel()
    const sum = summarizer()
    let memory = "记忆 v1"
    let cached = memory
    const mem = defineExtension({
      name: "memory",
      setup(s) {
        s.registerSection("memory", ({ reason }) => (reason === "rebuild" ? (cached = memory) : cached))
        s.on("compacted", async ({ entries }) => {
          await tick()
          memory = `记忆 v2（看过 ${entries.length} 条）`
        })
      },
    })
    const t = setup({ extensions: [mem, sum.ext, ch.ext], ...small })
    await t.kernel.start()
    await chat(t, ch, 4)

    expect(sum.calls.length).toBeGreaterThanOrEqual(1)
    const first = sum.calls[0]!
    expect(first.reason).toBe("threshold")
    expect(first.previousSummary).toBeUndefined()
    const all = t.entries()
    const compactionIndex = all.findIndex((e) => e.type === "compaction")
    const compaction = all[compactionIndex]!
    const checkpoint = all[compactionIndex + 1]!
    expect(checkpoint.type).toBe("system")
    expect((checkpoint.data as any).sections.memory).toBe(`记忆 v2（看过 ${first.entries.length} 条）`)
    expect(Object.keys((checkpoint.data as any).sections)).toEqual(["kernel", "memory"])

    // 切点在 Run 边界：被压缩的最后一条与保留的第一条属于不同的 Run，且保留部分以 signal 开头
    const firstKept = all.find((e) => e.seq === (compaction.data as any).firstKeptSeq)!
    expect(firstKept.type).toBe("signal")
    expect(first.entries.at(-1)!.runId).not.toBe(firstKept.runId)
    expect(first.entries.every((e) => e.type !== "system")).toBe(true)

    // 压缩后的第一次请求：检查点 system → <summary> + 保留的条目 → 新 Signal
    const request = t.requests.find((r) => userText(r).includes("<summary>"))!
    expect(request[0]).toMatchObject({ role: "system", sections: { memory: expect.stringContaining("记忆 v2") } })
    expect(request.filter((m) => m.role === "system")).toHaveLength(1)
    expect(userText(request)).toMatch(/^<summary>\n摘要#1\n<\/summary>/)
    expect(userText(request)).not.toContain("问1")
    expect(request.at(-1)!.role).toBe("user")
    expect(t.of("compaction")[0]).toMatchObject({ ok: true, by: "compaction", reason: "threshold" })
    expect(ch.delivered).toHaveLength(4)
  })

  it.each([
    { when: "下一个 Run", restart: false },
    { when: "重启后的第一个 Run", restart: true },
  ])("手动压缩后，$when 按重建上下文和新消息判断阈值", async ({ restart }) => {
    const home = mkdtempSync(join(tmpdir(), "sofia-compaction-"))
    const dbPath = join(home, "timeline.db")
    const ch = fakeChannel()
    const sum = summarizer()
    const boot = () => setup({
      home, dbPath, extensions: [sum.ext, ch.ext], faux: small.faux,
      config: { compaction: { reserveTokens: 750, keepRecentTokens: 350 } },
    })
    let t = boot()
    const exchange = async (question: string, answer: string) => {
      t.reply(answer)
      ch.api.signal(say(main, question))
      await t.kernel.whenIdle()
    }
    await t.kernel.start()
    const shortQuestion = "q".repeat(176) // 含来源、时间和发言人，共 58 token
    await exchange("q".repeat(800), "a".repeat(2072))
    await exchange(shortQuestion, "a".repeat(1228))
    ch.api.compact()
    await t.kernel.whenIdle()
    expect(t.of("compaction")).toMatchObject([{ reason: "manual", ok: true, tokensBefore: 1209, tokensAfter: 720 }])

    if (restart) {
      await t.kernel.stop()
      t = boot()
      await t.kernel.start()
    }
    const previousEvents = t.of("compaction").length
    await exchange(shortQuestion, "好")
    const ctx = t.kernel.timeline.loadContext()
    expect(estimateContextTokens(ctx.messages.slice(0, -1), ctx.usageStartIndex)).toBe(778)
    expect(t.of("compaction")).toHaveLength(previousEvents)
    expect(ch.delivered.at(-1)?.text).toBe("好")

    const freshUsage = t.of("llm_request").at(-1)!.tokens
    await exchange("q".repeat(5000), "收到")
    expect(t.of("compaction").at(-1)).toMatchObject({ reason: "threshold", ok: true, tokensBefore: freshUsage })
    expect(t.entries(["compaction"])).toHaveLength(2)
    await t.kernel.stop()
  })

  it("previousSummary 迭代传入；无压缩扩展时沿用旧摘要兜底", async () => {
    const ch = fakeChannel()
    const sum = summarizer()
    const t = setup({ extensions: [sum.ext, ch.ext], ...small })
    await t.kernel.start()
    await chat(t, ch, 8)
    expect(sum.calls.length).toBeGreaterThanOrEqual(2)
    expect(sum.calls[1]!.previousSummary).toBe("摘要#1")

    const bare = fakeChannel()
    const t2 = setup({ extensions: [bare.ext], ...small })
    await t2.kernel.start()
    await chat(t2, bare, 6)
    const compactions = t2.entries(["compaction"])
    expect(compactions.length).toBeGreaterThanOrEqual(1)
    expect((compactions[0]!.data as any).summary).toBe("")
    expect(t2.of("compaction")[0]).toMatchObject({ ok: true })
    expect(t2.of("compaction")[0]!.by).toBeUndefined()
    expect(userText(t2.requests.at(-1)!)).not.toContain("问1")
    expect(bare.delivered).toHaveLength(6)
  })

  it("before_compact 首个返回者生效，可取消；摘要失败时上下文不变", async () => {
    const ch = fakeChannel()
    let mode: "throw" | "cancel" | "ok" = "throw"
    const a = defineExtension({
      name: "a",
      setup: (s) =>
        void s.on("before_compact", () => {
          if (mode === "throw") throw new Error("llm down")
          if (mode === "cancel") return { cancel: true }
          return { summary: "来自 a" }
        }),
    })
    const b = defineExtension({ name: "b", setup: (s) => void s.on("before_compact", () => (mode === "ok" ? { summary: "来自 b" } : undefined)) })
    const t = setup({ extensions: [a, b, ch.ext], ...small })
    await t.kernel.start()
    await chat(t, ch, 4)
    expect(t.entries(["compaction"])).toHaveLength(0)
    expect(t.of("compaction").every((e) => !e.ok && e.error === "a: llm down")).toBe(true)
    expect(userText(t.requests.at(-1)!)).toContain("问1")
    expect(ch.delivered).toHaveLength(4)

    mode = "cancel"
    await chat(t, ch, 1, 5)
    expect(t.entries(["compaction"])).toHaveLength(0)
    expect(t.of("compaction").at(-1)).toMatchObject({ ok: false, error: "cancelled", by: "a" })

    mode = "ok"
    await chat(t, ch, 1, 6)
    expect(t.entries(["compaction"]).map((e) => (e.data as any).summary)).toEqual(["来自 a"])
  })

  it("摘要超时只中止该扩展的请求，后续扩展仍可提供摘要", async () => {
    const ch = fakeChannel()
    const slow = stalledSummarizer()
    const fallback = summarizer(({ signal }) => signal.throwIfAborted())
    const t = setup({
      extensions: [slow.ext, fallback.ext, ch.ext],
      config: { compaction: { keepRecentTokens: 200 }, compactHookTimeoutMs: 20 },
    })
    await t.kernel.start()
    await chat(t, ch, 2)
    ch.api.compact()
    await t.kernel.whenIdle()
    expect((await slow.started).aborted).toBe(true)
    expect(t.of("hook")).toContainEqual(expect.objectContaining({ event: "before_compact", ext: "slow", error: "timeout" }))
    expect(t.of("compaction")).toMatchObject([{ ok: true, by: "compaction" }])
    await t.kernel.stop()
  })

  it.each(["owner", "shutdown"] as const)("%s 中止压缩，跳过后续摘要扩展", async (reason) => {
    const ch = fakeChannel()
    const slow = stalledSummarizer()
    const fallback = summarizer()
    const t = setup({ ...small, extensions: [slow.ext, fallback.ext, ch.ext] })
    await t.kernel.start()
    for (const runId of ["one", "two", "three"]) {
      t.kernel.timeline.append({ type: "user", runId, data: { role: "user", content: long(runId).repeat(3), timestamp: 0 } })
    }
    if (reason === "owner") ch.api.signal(say(main, "继续"))
    else ch.api.compact()
    const signal = await slow.started
    if (reason === "owner") {
      ch.api.abortRun()
      await t.kernel.whenIdle()
      expect(t.of("run_end")).toMatchObject([{ status: "aborted" }])
      expect(t.entries(["compaction"])).toHaveLength(0)
    }
    await t.kernel.stop()
    expect(signal.aborted).toBe(true)
    expect(fallback.calls).toHaveLength(0)
    expect(t.of("compaction")).toMatchObject([{ ok: false, error: "aborted" }])
  })

  it("Turn 之间压缩：在 Turn 边界切，工具调用与结果不被拆开", async () => {
    const ch = fakeChannel()
    const sum = summarizer()
    const tools = defineExtension({
      name: "t",
      setup: (s) =>
        void s.registerTool({
          name: "echo", label: "echo", description: "echo", parameters: { type: "object", properties: {} },
          execute: async () => ({ content: [{ type: "text", text: "ok" }], details: undefined }),
        }),
    })
    const t = setup({ extensions: [sum.ext, tools, ch.ext], ...small })
    await t.kernel.start()
    t.reply(
      fauxAssistantMessage([{ type: "text", text: long("思考").repeat(4) }, fauxToolCall("t_echo", {})], { stopReason: "toolUse" }),
      "查完了",
    )
    ch.api.signal(say(main, long("帮我查")))
    await t.kernel.whenIdle()

    expect(sum.calls).toHaveLength(1)
    expect(sum.calls[0]!.entries.map((e) => e.type)).toEqual(["signal"])
    expect(t.entries().map((e) => e.type)).toEqual(["system", "signal", "assistant", "toolResult", "compaction", "system", "assistant"])
    expect(t.requests[1]!.map((m) => m.role)).toEqual(["system", "user", "assistant", "toolResult"])
    expect((t.requests[1]![0] as any).toolsAdded.map((x: any) => x.name)).toEqual(["t_echo"])
    expect(t.of("run_end")).toHaveLength(1)
    expect(ch.delivered.at(-1)!.text).toBe("查完了")

    // 下一个 Run 从 Timeline 重建，结果一致
    t.reply("嗯")
    ch.api.signal(say(main, "谢谢"))
    await t.kernel.whenIdle()
    expect(t.requests[2]!.map((m) => m.role)).toEqual(["system", "user", "assistant", "toolResult", "assistant", "user"])
    expect(t.entries(["system"])).toHaveLength(2)
  })

  it.each(["threshold", "overflow"] as const)("%s 压缩后在同一 Run 再次调用工具，零 usage 不会触发重复压缩", async (reason) => {
    const ch = fakeChannel()
    const sum = summarizer()
    const reader = defineExtension({
      name: "reader",
      setup(s) {
        s.registerTool({
          name: "read", label: "读", description: "读", parameters: { type: "object", properties: {} },
          execute: async () => ({ content: [{ type: "text", text: "x".repeat(600) }], details: undefined }),
        })
      },
    })
    const t = setup({
      extensions: [sum.ext, reader, ch.ext], faux: small.faux,
      config: { compaction: { reserveTokens: 750, keepRecentTokens: 350 } },
    })
    await t.kernel.start()
    await chat(t, ch, 2)

    // 每个工具结果 150 token。第一条 usage 加上结果，按场景决定是否在此时跨过 1250。
    const toolCall = () => fauxAssistantMessage([fauxToolCall("reader_read", {})], { stopReason: "toolUse" })
    const first = toolCall()
    const used = reason === "threshold" ? 1200 : 1000
    first.usage = { ...first.usage, input: used, totalTokens: used }
    const replies = [first]
    if (reason === "overflow") {
      replies.push(fauxAssistantMessage([], { stopReason: "error", errorMessage: "prompt is too long: 2100 tokens > 2000 maximum" }))
    }
    replies.push(toolCall()) // 模拟压缩后的模型回复带工具调用，但没有回报用量
    const stream = vi.spyOn(t.runtime, "stream")
    for (const message of replies) {
      stream.mockImplementationOnce(() => {
        const result = createAssistantMessageEventStream()
        if (message.stopReason === "error") result.push({ type: "error", reason: "error", error: message })
        else result.push({ type: "done", reason: "toolUse", message })
        return result
      })
    }
    t.reply("查完了")
    ch.api.signal(say(main, "查一下"))
    await t.kernel.whenIdle()
    expect(t.of("compaction")).toMatchObject([{ reason, ok: true, tokensBefore: used + 150 }])
    expect(ch.delivered.at(-1)?.text).toBe("查完了")
    await t.kernel.stop()
  })

  it("溢出 → 强制压缩 → continue 重试；run_end 只触发一次", async () => {
    const ch = fakeChannel()
    const sum = summarizer()
    const t = setup({ extensions: [sum.ext, ch.ext], config: { compaction: { keepRecentTokens: 200 } } })
    await t.kernel.start()
    await chat(t, ch, 2)
    t.reply(fauxAssistantMessage([], { stopReason: "error", errorMessage: "prompt is too long: 300000 tokens > 200000 maximum" }), "挤进来了")
    ch.api.signal(say(main, long("问3")))
    await t.kernel.whenIdle()

    expect(sum.calls).toHaveLength(1)
    expect(sum.calls[0]!.reason).toBe("overflow")
    expect(t.of("llm_retry")).toHaveLength(0)
    expect(t.of("run_end")).toHaveLength(3)
    expect(t.of("run_end").at(-1)!.status).toBe("ok")
    expect(ch.delivered.at(-1)!.text).toBe("挤进来了")
    const retry = t.requests.at(-1)!
    expect(retry.at(-1)!.role).toBe("user")
    expect(retry.some((m) => m.role === "assistant" && m.stopReason === "error")).toBe(false)
    expect(userText(retry)).toContain("<summary>")
    expect(t.entries(["notice"])).toHaveLength(0)
  })

  it("溢出压缩完成时 Run 已被中止，保留检查点并跳过重试与投递", async () => {
    const ch = fakeChannel()
    const cancel = defineExtension({ name: "cancel", setup: (s) => void s.on("compacted", () => s.abortRun()) })
    const t = setup({ extensions: [cancel, ch.ext], config: { compaction: { keepRecentTokens: 1 } } })
    await t.kernel.start()
    t.kernel.timeline.append({ type: "user", runId: "past", data: { role: "user", content: "较早的提问", timestamp: 0 } })
    t.reply(fauxAssistantMessage([], { stopReason: "error", errorMessage: "prompt is too long: 300000 tokens > 200000 maximum" }), "重试的回答")
    ch.api.signal(say(main, "本次提问"))
    await t.kernel.whenIdle()

    expect(t.of("compaction")).toMatchObject([{ ok: true, reason: "overflow" }])
    expect(t.kernel.timeline.loadContext().missingCheckpoint).toBe(false)
    expect(t.of("run_end")).toMatchObject([{ status: "aborted" }])
    expect(t.requests).toHaveLength(1)
    expect(ch.delivered).toHaveLength(0)
    await t.kernel.stop()
  })

  it.each([0, 200])("单条未回答的请求超过保留量 %i 时，溢出不会把它丢掉再重试", async (keepRecentTokens) => {
    const ch = fakeChannel()
    const sum = summarizer()
    const t = setup({ extensions: [sum.ext, ch.ext], config: { compaction: { keepRecentTokens } } })
    await t.kernel.start()
    t.reply(fauxAssistantMessage([], { stopReason: "error", errorMessage: "prompt is too long: 300000 tokens > 200000 maximum" }))
    ch.api.signal(say(main, "问".repeat(300)))
    await t.kernel.whenIdle()

    expect(t.of("compaction")).toMatchObject([{ ok: false, reason: "overflow" }])
    expect(sum.calls).toHaveLength(0)
    expect(t.kernel.timeline.loadContext().entries.filter((e) => e.type === "signal")).toHaveLength(1)
    expect(t.of("run_end")).toMatchObject([{ status: "error" }])
    expect(t.of("llm_request")).toHaveLength(1)
    expect(ch.delivered).toHaveLength(0)
    await t.kernel.stop()
  })

  it.each([false, true])("工具结果超过保留量，只有旧 Run 可供兜底压缩时才重试（有历史：%s）", async (hasHistory) => {
    const ch = fakeChannel()
    const t = setup({ extensions: [ch.ext], config: { compaction: { keepRecentTokens: 200 } } })
    await t.kernel.start()
    if (hasHistory) t.kernel.timeline.append({ type: "user", runId: "past", data: { role: "user", content: "旧问题", timestamp: 0 } })
    ch.api.registerTool({
      name: "read", label: "读", description: "读", parameters: { type: "object", properties: {} },
      execute: async () => ({ content: [{ type: "text", text: "文".repeat(300) }], details: undefined }),
    })
    t.reply(
      fauxAssistantMessage([fauxToolCall("fake_read", {})], { stopReason: "toolUse" }),
      fauxAssistantMessage([], { stopReason: "error", errorMessage: "prompt is too long: 300000 tokens > 200000 maximum" }),
      "查完了",
    )
    ch.api.signal(say(main, "本次提问"))
    await t.kernel.whenIdle()

    expect(t.of("compaction")).toMatchObject([{ ok: hasHistory, reason: "overflow" }])
    expect(t.of("run_end")).toMatchObject([{ status: hasHistory ? "ok" : "error" }])
    expect(t.requests).toHaveLength(hasHistory ? 3 : 2)
    expect(ch.delivered).toHaveLength(hasHistory ? 1 : 0)
    const lastRequest = t.requests.at(-1)!
    expect(userText(lastRequest)).toContain("本次提问")
    expect(userText(lastRequest)).not.toContain("旧问题")
    expect(lastRequest.slice(-2)).toMatchObject([{ role: "assistant" }, { role: "toolResult", content: [{ text: "文".repeat(300) }] }])
    await t.kernel.stop()
  })

  it("溢出后压缩不了：Run 以 error 结束", async () => {
    const ch = fakeChannel()
    const t = setup({ extensions: [ch.ext] })
    await t.kernel.start()
    t.reply(fauxAssistantMessage([], { stopReason: "error", errorMessage: "prompt is too long: 300000 tokens > 200000 maximum" }))
    ch.api.signal(say(main, "在吗"))
    await t.kernel.whenIdle()
    expect(t.of("run_end")).toHaveLength(1)
    expect(t.of("run_end")[0]!.status).toBe("error")
    expect(ch.errors).toHaveLength(1)
  })

  it("sofia.compact()：空闲时立即执行；有 Run 时在其结束后、下一个 Run 开始前执行", async () => {
    const ch = fakeChannel()
    const sum = summarizer()
    const t = setup({ extensions: [sum.ext, ch.ext], config: { compaction: { keepRecentTokens: 200 } } })
    await t.kernel.start()
    await chat(t, ch, 3)
    ch.api.compact()
    await t.kernel.whenIdle()
    expect(sum.calls.map((c) => c.reason)).toEqual(["manual"])
    expect(t.entries(["compaction"])).toHaveLength(1)

    await chat(t, ch, 2, 4)
    const gate = deferred()
    t.reply(async () => (await gate.promise, fauxAssistantMessage(long("答6"))), "答7")
    ch.api.signal(say(main, long("问6")))
    await tick()
    ch.api.compact()
    ch.api.signal(say(room("other"), "问7"))
    await tick()
    expect(sum.calls).toHaveLength(1)
    gate.resolve()
    await t.kernel.whenIdle()
    expect(sum.calls).toHaveLength(2)
    const order = t.events.filter((e) => e.type === "run_end" || e.type === "run_start" || (e.type === "compaction" && e.ok)).map((e) => e.type).slice(-4)
    expect(order).toEqual(["run_end", "compaction", "run_start", "run_end"])
  })
})

describe("重启恢复", () => {
  it("interrupted notice；Section / 工具 diff 只在有变化时追加补丁", async () => {
    const home = mkdtempSync(join(tmpdir(), "sofia-restart-"))
    const dbPath = join(home, "timeline.db")
    const boot = (persona: string, withTool: boolean) => {
      const ch = fakeChannel()
      const ext = defineExtension({
        name: "persona",
        setup(s: SofiaAPI) {
          s.registerSection("persona", () => persona)
          if (withTool) {
            s.registerTool({
              name: "wave", label: "wave", description: "wave", parameters: { type: "object", properties: {} },
              execute: async () => ({ content: [], details: undefined }),
            })
          }
        },
      })
      return { ch, t: setup({ extensions: [ext, ch.ext], home, dbPath }) }
    }

    const first = boot("v1", false)
    await first.t.kernel.start()
    first.t.reply("你好")
    first.ch.api.signal(say(main, "在吗"))
    await first.t.kernel.whenIdle()
    // 模拟崩溃：留下一个未结束的 Run
    first.t.kernel.timeline.startRun({ id: "crashed", startedAt: Date.now() })
    first.t.kernel.timeline.close()

    const second = boot("v1", false)
    await second.t.kernel.start()
    expect(second.t.kernel.timeline.getRun("crashed")).toMatchObject({ status: "interrupted" })
    expect(second.t.entries().map((e) => e.type)).toEqual(["system", "signal", "assistant", "notice"])
    expect((second.t.entries(["notice"])[0]!.data as any).text).toBe("（你刚才被中断了）")
    second.t.reply("我回来了")
    second.ch.api.signal(say(main, "怎么了"))
    await second.t.kernel.whenIdle()
    expect(second.t.requests[0]!.map((m) => m.role)).toEqual(["system", "user", "assistant", "user"])
    expect(userText(second.t.requests[0]!)).toContain("<notice>（你刚才被中断了）</notice>")
    await second.t.kernel.stop()

    const third = boot("v2", true)
    await third.t.kernel.start()
    const systems = third.t.entries(["system"])
    expect(systems).toHaveLength(2)
    expect(systems[1]!.data).toMatchObject({ sections: { persona: "v2" }, toolsAdded: [{ name: "persona_wave" }] })
    expect(third.t.entries(["notice"])).toHaveLength(1)
    await third.t.kernel.stop()
  })

  it("stop：中止当前 Run 并触发 shutdown", async () => {
    const ch = fakeChannel()
    let reason: string | undefined
    const ext = defineExtension({ name: "x", setup: (s) => void s.on("shutdown", (p) => void (reason = p.reason)) })
    const t = setup({ extensions: [ch.ext, ext], faux: { tokensPerSecond: 20 } })
    await t.kernel.start()
    t.reply("很长的一段话".repeat(50))
    ch.api.signal(say(main, "讲"))
    await tick(30)
    const runId = ch.api.currentRun()!.id
    const notices: unknown[] = []
    t.kernel.events.subscribe((e) => e.type === "run_end" && notices.push(...t.entries(["notice"]).map((n) => (n.data as any).text)))
    await t.kernel.stop("restart")
    expect(reason).toBe("restart")
    expect(notices).toEqual(["（你刚才被中断了）"])
    expect(t.of("run_end")[0]).toMatchObject({ status: "aborted", run: { id: runId } })
  })
})
