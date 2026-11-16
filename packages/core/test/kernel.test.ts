import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai"
import { afterEach, describe, expect, it, vi } from "vitest"
import { defineExtension, type SofiaAPI } from "../src/index.ts"
import { deferred, fakeChannel, room, say, setup, tick, userText } from "./harness.ts"

const main = room("main")
const group = room("摸鱼小队", "group")

const echoTool = (execute: () => unknown = () => {}) => ({
  name: "echo",
  label: "echo",
  description: "echo",
  parameters: { type: "object", properties: { deny: { type: "boolean" } } },
  execute: async () => {
    await execute()
    return { content: [{ type: "text" as const, text: "ok" }], details: undefined }
  },
})

afterEach(() => vi.useRealTimers())

describe("基本流程", () => {
  it("Signal → Run → 自动投递到 Focus Room，并落盘到 Timeline", async () => {
    const ch = fakeChannel()
    const t = setup({ extensions: [ch.ext] })
    await t.kernel.start()
    t.reply("你好呀")
    ch.api.signal(say(main, "在吗"))
    await t.kernel.whenIdle()

    expect(ch.delivered).toEqual([{ room: main.id, text: "你好呀" }])
    expect(t.entries().map((e) => e.type)).toEqual(["system", "signal", "assistant"])
    expect(userText(t.requests[0]!)).toMatch(/^\[main · .+\] 阿洋（主人）：在吗$/)
    const system = t.requests[0]![0] as any
    expect(Object.keys(system.sections)).toEqual(["kernel"])
    const [run] = t.of("run_end")
    expect(run!.status).toBe("ok")
    expect(t.kernel.timeline.getRun(run!.run.id)).toMatchObject({ status: "ok", focusRoom: main.id })
  })

  it("Silence Token 各写法不投递；无 Focus Room 不投递", async () => {
    const ch = fakeChannel()
    const t = setup({ extensions: [ch.ext] })
    await t.kernel.start()
    for (const silent of ["[[NO_REPLY]]", "[NO_REPLY]", " no_reply \n"]) {
      t.reply(silent)
      ch.api.signal(say(main, "嗯"))
      await t.kernel.whenIdle()
    }
    t.reply("没人听得到")
    ch.api.signal({ source: { kind: "internal", from: "heartbeat" }, priority: "low", content: [{ type: "text", text: "想想" }] })
    await t.kernel.whenIdle()
    expect(ch.delivered).toEqual([])
    expect(t.of("run_end")).toHaveLength(4)

    t.reply("主人好")
    ch.api.signal({ source: { kind: "internal", from: "heartbeat", room: main }, priority: "low", content: [{ type: "text", text: "问候" }] })
    await t.kernel.whenIdle()
    expect(ch.delivered).toEqual([{ room: main.id, text: "主人好" }])
  })

  it("每个 Run 从 Timeline 重建上下文；Section 不变时不产生补丁", async () => {
    const ch = fakeChannel()
    let persona = "你是 Sofia"
    const ext = defineExtension({ name: "persona", setup: (s) => void s.registerSection("persona", () => persona) })
    const t = setup({ extensions: [ext, ch.ext] })
    await t.kernel.start()
    t.reply("一", "二", "三")
    ch.api.signal(say(main, "1"))
    await t.kernel.whenIdle()
    ch.api.signal(say(main, "2"))
    await t.kernel.whenIdle()
    expect(t.entries(["system"])).toHaveLength(1)
    expect(t.requests[1]!.map((m) => m.role)).toEqual(["system", "user", "assistant", "user"])

    persona = "你是 Sofia，今天很开心"
    ch.api.signal(say(main, "3"))
    await t.kernel.whenIdle()
    const systems = t.entries(["system"])
    expect(systems).toHaveLength(2)
    expect((systems[1]!.data as any).sections).toEqual({ persona: "你是 Sofia，今天很开心" })
    expect(t.requests[2]!.map((m) => m.role)).toEqual(["system", "user", "assistant", "user", "assistant", "system", "user"])
  })

  it("run_start 的 recall 写在 Signal 之前并合并为一条 user 消息", async () => {
    const ch = fakeChannel()
    const mem = defineExtension({ name: "mem", setup: (s) => void s.on("run_start", () => ({ recall: ["他喜欢猫"] })) })
    const t = setup({ extensions: [mem, ch.ext] })
    await t.kernel.start()
    t.reply("喵")
    ch.api.signal(say(main, "猜我喜欢什么"))
    await t.kernel.whenIdle()
    expect(t.entries().map((e) => e.type)).toEqual(["system", "recall", "signal", "assistant"])
    expect(t.requests[0]!.map((m) => m.role)).toEqual(["system", "user"])
    expect(userText(t.requests[0]!)).toContain("<recall>\n你想起了这些：\n- 他喜欢猫\n</recall>\n\n[main")
  })
})

describe("调度", () => {
  it("同 Room 防抖合并为一个 Run", async () => {
    vi.useFakeTimers()
    const ch = fakeChannel({ debounceMs: 1500 })
    const t = setup({ extensions: [ch.ext] })
    await t.kernel.start()
    t.reply("收到两条")
    ch.api.signal(say(main, "第一条"))
    await vi.advanceTimersByTimeAsync(1000)
    ch.api.signal(say(main, "第二条"))
    await vi.advanceTimersByTimeAsync(1400)
    expect(t.of("run_start")).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(200)
    await t.kernel.whenIdle()
    expect(t.of("run_start")).toHaveLength(1)
    expect(userText(t.requests[0]!)).toMatch(/第一条[\s\S]+第二条/)
  })

  it("防抖最长等待：连续刷屏也会就绪", async () => {
    vi.useFakeTimers()
    const ch = fakeChannel({ debounceMs: 1500, maxWaitMs: 5000 })
    const t = setup({ extensions: [ch.ext] })
    await t.kernel.start()
    t.reply("好吵")
    for (let i = 0; i < 6; i++) {
      ch.api.signal(say(group, `刷屏${i}`, { owner: false }))
      await vi.advanceTimersByTimeAsync(1000)
    }
    await t.kernel.whenIdle()
    expect(t.of("run_start")).toHaveLength(1)
    expect(userText(t.requests[0]!)).toContain("刷屏4")
  })

  it("跨 Room 排队：不抢占，按优先级、同级先到先得", async () => {
    const ch = fakeChannel()
    const t = setup({ extensions: [ch.ext] })
    await t.kernel.start()
    const gate = deferred()
    t.reply(async () => (await gate.promise, fauxAssistantMessage("A 完成")), "回 D", "回 C", "回 B")
    const [a, b, c, d] = [room("a", "group"), room("b", "group"), room("c", "group"), room("d")]
    ch.api.signal(say(a, "a", { owner: false }))
    await tick()
    ch.api.signal(say(b, "b", { owner: false, at: 2000 }))
    ch.api.signal(say(c, "c", { owner: false, at: 1000 }))
    ch.api.signal(say(d, "d", { owner: true }))
    await tick()
    expect(t.of("run_start")).toHaveLength(1)
    gate.resolve()
    await t.kernel.whenIdle()
    expect(ch.delivered.map((x) => x.text)).toEqual(["A 完成", "回 D", "回 C", "回 B"])
    expect(t.of("run_scheduled")[1]).toMatchObject({ chosen: d.id, reason: "highest priority (high)" })
  })

  it("同 Room 的 Signal 在 Turn 结束后 steer 注入，不另开 Run", async () => {
    const ch = fakeChannel()
    let api!: SofiaAPI
    const tools = defineExtension({
      name: "t",
      setup(s) {
        api = s
        s.registerTool(echoTool(async () => {
          ch.api.signal(say(main, "等等，还有一句"))
          await tick()
        }))
      },
    })
    const t = setup({ extensions: [ch.ext, tools] })
    await t.kernel.start()
    t.reply(fauxAssistantMessage([fauxToolCall("t_echo", {})], { stopReason: "toolUse" }), "都看到了")
    ch.api.signal(say(main, "帮我查一下"))
    await t.kernel.whenIdle()
    expect(api.name).toBe("t")
    expect(t.of("run_start")).toHaveLength(1)
    expect(t.of("steered")).toHaveLength(1)
    // pi 原始事件原样进入事件流，带上 runId 与 turn
    const runId = t.of("run_start")[0]!.run.id
    expect(t.of("turn_end").map((e) => [e.runId, e.turn, e.toolResults.length])).toEqual([[runId, 1, 1], [runId, 2, 0]])
    expect(t.of("tool_execution_end")[0]).toMatchObject({ runId, turn: 1, toolName: "t_echo", isError: false })
    expect(t.entries().map((e) => e.type)).toEqual(["system", "signal", "assistant", "toolResult", "signal", "assistant"])
    expect(userText(t.requests[1]!)).toContain("等等，还有一句")
  })

  it("Run 结束时残留的 steer 回到桶里，立即开启下一个 Run", async () => {
    const ch = fakeChannel()
    const t = setup({ extensions: [ch.ext] })
    await t.kernel.start()
    let sent = false
    t.kernel.events.subscribe((e) => {
      if (e.type === "agent_end" && !sent) {
        sent = true
        ch.api.signal(say(main, "追加一句"))
      }
    })
    t.reply("第一次", "第二次")
    ch.api.signal(say(main, "你好"))
    await t.kernel.whenIdle()
    expect(ch.delivered.map((x) => x.text)).toEqual(["第一次", "第二次"])
    expect(t.of("run_start")).toHaveLength(2)
    expect(t.entries(["signal"])).toHaveLength(2)
  })
})

describe("Delivery", () => {
  it("不阻塞 Loop，且同 Room 投递保序", async () => {
    const gate = deferred()
    const order: string[] = []
    const ch = fakeChannel({
      deliver: async (_r, text) => {
        if (text === "慢") await gate.promise
        order.push(text)
      },
    })
    const t = setup({ extensions: [ch.ext] })
    await t.kernel.start()
    t.reply("慢", "快")
    ch.api.signal(say(main, "1"))
    await tick(20)
    ch.api.signal(say(main, "2"))
    await tick(20)
    expect(t.of("run_end")).toHaveLength(2) // 两个 Run 都已结束，投递还卡着
    expect(order).toEqual([])
    gate.resolve()
    await t.kernel.whenIdle()
    expect(order).toEqual(["慢", "快"])
  })

  it("流式：扣留 Silence Token 前缀", async () => {
    const ch = fakeChannel()
    const t = setup({ extensions: [ch.ext], faux: { tokenSize: { min: 1, max: 1 } } })
    await t.kernel.start()
    t.reply("[[NO_REPLY]]")
    ch.api.signal(say(main, "嗯"))
    await t.kernel.whenIdle()
    expect(ch.deltas).toEqual([])

    t.reply("[[NO_REPLY 才怪，我要说话")
    ch.api.signal(say(main, "嗯？"))
    await t.kernel.whenIdle()
    expect(ch.deltas.length).toBeGreaterThan(1)
    expect(ch.deltas[0]!.startsWith("[[NO_REPLY ")).toBe(true)
    expect(ch.deltas.join("")).toBe("[[NO_REPLY 才怪，我要说话")
    expect(ch.delivered).toEqual([{ room: main.id, text: "[[NO_REPLY 才怪，我要说话" }])
  })

  it("deliver hook 可改写或取消", async () => {
    const ch = fakeChannel()
    const filter = defineExtension({
      name: "filter",
      setup: (s) => void s.on("deliver", ({ text }) => (text.includes("秘密") ? { cancel: true } : { text: `${text}~` })),
    })
    const t = setup({ extensions: [ch.ext, filter] })
    await t.kernel.start()
    t.reply("这是秘密", "你好")
    ch.api.signal(say(main, "1"))
    await t.kernel.whenIdle()
    ch.api.signal(say(main, "2"))
    await t.kernel.whenIdle()
    expect(ch.delivered.map((x) => x.text)).toEqual(["你好~"])
  })

  it("持续失败：写 notice，不唤醒新 Run", async () => {
    const ch = fakeChannel({ deliver: async () => Promise.reject(new Error("network down")) })
    const t = setup({ extensions: [ch.ext] })
    await t.kernel.start()
    t.reply("发不出去")
    ch.api.signal(say(main, "在吗"))
    await t.kernel.whenIdle()
    expect(t.of("delivery")[0]).toMatchObject({ ok: false, error: "network down" })
    expect(t.entries(["notice"]).map((e) => (e.data as any).text)).toEqual(["（你刚才发往 [main] 的消息没有发出去）"])
    expect(t.of("run_start")).toHaveLength(1)
    expect(t.faux.state.callCount).toBe(1)
  })

  it("Run 仍在继续时，投递失败的 notice 在下个 Turn 前可见", async () => {
    const ch = fakeChannel({ deliver: async () => Promise.reject(new Error("network down")) })
    const tools = defineExtension({ name: "t", setup: (s) => void s.registerTool(echoTool(() => tick())) })
    const t = setup({ extensions: [ch.ext, tools] })
    await t.kernel.start()
    t.reply(fauxAssistantMessage([{ type: "text", text: "我查一下" }, fauxToolCall("t_echo", {})], { stopReason: "toolUse" }), "[[NO_REPLY]]")
    ch.api.signal(say(main, "帮我查"))
    await t.kernel.whenIdle()
    expect(t.entries().map((e) => e.type)).toEqual(["system", "signal", "assistant", "toolResult", "notice", "assistant"])
    expect(userText(t.requests[1]!)).toContain("<notice>（你刚才发往 [main] 的消息没有发出去）</notice>")
  })
})

describe("失败与中止", () => {
  it("Run 失败：notice、onRunError、Signal 不重放；error assistant 不进下一次上下文", async () => {
    const ch = fakeChannel()
    const t = setup({ extensions: [ch.ext] })
    await t.kernel.start()
    t.reply(fauxAssistantMessage([], { stopReason: "error", errorMessage: "invalid api key" }), "现在好了")
    ch.api.signal(say(main, "在吗"))
    await t.kernel.whenIdle()
    expect(t.faux.state.callCount).toBe(1)
    expect(t.of("run_end")[0]).toMatchObject({ status: "error", error: "invalid api key" })
    expect(ch.errors.map((e) => e.message)).toEqual(["invalid api key"])
    expect(ch.delivered).toEqual([])
    expect(t.entries().map((e) => e.type)).toEqual(["system", "signal", "assistant", "notice"])

    ch.api.signal(say(main, "还在吗"))
    await t.kernel.whenIdle()
    expect(t.requests[1]!.map((m) => m.role)).toEqual(["system", "user"])
    expect(userText(t.requests[1]!)).toMatch(/在吗[\s\S]+<notice>（你刚才因为 invalid api key 没能回应 \[main\] 的消息）<\/notice>[\s\S]+还在吗/)
  })

  it("重试只发生在首个内容事件之前", async () => {
    const ch = fakeChannel()
    const t = setup({ extensions: [ch.ext] })
    await t.kernel.start()
    t.reply(fauxAssistantMessage([], { stopReason: "error", errorMessage: "529 overloaded" }), "重试成功")
    ch.api.signal(say(main, "1"))
    await t.kernel.whenIdle()
    expect(t.faux.state.callCount).toBe(2)
    expect(t.of("llm_retry")).toHaveLength(1)
    expect(ch.delivered.map((x) => x.text)).toEqual(["重试成功"])
    expect(t.entries(["assistant"])).toHaveLength(1)

    t.reply(fauxAssistantMessage("说到一半", { stopReason: "error", errorMessage: "529 overloaded" }), "不该用到")
    ch.api.signal(say(main, "2"))
    await t.kernel.whenIdle()
    expect(t.faux.state.callCount).toBe(3)
    expect(t.of("run_end")[1]!.status).toBe("error")
    t.faux.setResponses([])
  })

  it("Turn 上限触顶：强制停下、notice、onRunError", async () => {
    const ch = fakeChannel()
    const tools = defineExtension({ name: "t", setup: (s) => void s.registerTool(echoTool()) })
    const t = setup({ extensions: [ch.ext, tools], config: { maxTurnsPerRun: 2 } })
    await t.kernel.start()
    const call = () => fauxAssistantMessage([fauxToolCall("t_echo", {})], { stopReason: "toolUse" })
    t.reply(call(), call(), "到不了这里")
    ch.api.signal(say(main, "循环吧"))
    await t.kernel.whenIdle()
    expect(t.faux.state.callCount).toBe(2)
    expect(t.of("run_end")[0]!.status).toBe("error")
    expect(t.entries(["notice"]).map((e) => (e.data as any).text)).toEqual(["（你在 [main] 的这次处理步骤太多，被强制停下了）"])
    expect(ch.errors).toHaveLength(1)
    t.faux.setResponses([])
  })

  it("hook 超时与抛异常都不影响 Run", async () => {
    const ch = fakeChannel()
    const stuck = defineExtension({
      name: "stuck",
      setup(s) {
        s.on("run_start", () => new Promise(() => {}))
        s.on("turn_end", () => {
          throw new Error("boom")
        })
      },
    })
    const t = setup({ extensions: [stuck, ch.ext], config: { hookTimeoutMs: 20 } })
    await t.kernel.start()
    t.reply("照常回复")
    ch.api.signal(say(main, "在吗"))
    await t.kernel.whenIdle()
    expect(ch.delivered.map((x) => x.text)).toEqual(["照常回复"])
    expect(t.of("hook").filter((h) => h.error).map((h) => [h.event, h.error])).toEqual([["run_start", "timeout"], ["turn_end", "boom"]])
    const runId = t.of("run_start")[0]!.run.id
    expect(t.of("hook").filter((h) => h.error).map((h) => [h.runId, h.turn])).toEqual([[runId, undefined], [runId, 1]])
  })

  it("abortRun：aborted 状态、notice、残留 steer 丢弃", async () => {
    const ch = fakeChannel()
    const t = setup({ extensions: [ch.ext], faux: { tokensPerSecond: 20 } })
    await t.kernel.start()
    t.reply("这是一段很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长的话".repeat(4), "下一次")
    ch.api.signal(say(main, "讲个故事"))
    await tick(30)
    expect(ch.api.currentRun()?.focusRoom?.id).toBe(main.id)
    ch.api.signal(say(main, "算了"))
    await tick(10)
    ch.api.abortRun()
    await t.kernel.whenIdle()
    expect(t.of("run_end")).toHaveLength(1)
    expect(t.of("run_end")[0]!.status).toBe("aborted")
    expect(ch.delivered).toEqual([])
    expect(t.entries().map((e) => e.type)).toEqual(["system", "signal", "assistant", "notice"])
    expect((t.entries(["notice"])[0]!.data as any).text).toBe("（主人打断了你）")

    ch.api.signal(say(main, "换个话题"))
    await t.kernel.whenIdle()
    expect(t.requests[1]!.map((m) => m.role)).toEqual(["system", "user"])
    expect(userText(t.requests[1]!)).not.toContain("算了")
  })
})

describe("工具", () => {
  it("加前缀；变更只在 Run 边界生效并声明为 system 补丁", async () => {
    const ch = fakeChannel()
    let api!: SofiaAPI
    const ext = defineExtension({ name: "desk", setup: (s) => void (api = s) })
    const t = setup({ extensions: [ch.ext, ext] })
    await t.kernel.start()
    t.reply("一", "二", "三")
    ch.api.signal(say(main, "1"))
    await t.kernel.whenIdle()

    const reg = api.registerTool(echoTool())
    expect(reg.name).toBe("desk_echo")
    expect(api.registerTool({ ...echoTool(), name: "bad name" }).name).toBe("desk_bad name")
    expect(t.of("ext_error")).toHaveLength(1)
    ch.api.signal(say(main, "2"))
    await t.kernel.whenIdle()
    expect(t.of("tools_patch").at(-1)).toMatchObject({ added: ["desk_echo"], removed: [] })

    reg.unregister()
    ch.api.signal(say(main, "3"))
    await t.kernel.whenIdle()
    expect(t.of("tools_patch").at(-1)).toMatchObject({ added: [], removed: ["desk_echo"] })
    expect(t.entries(["system"])).toHaveLength(3)
  })

  it("tool_call 可拦截，tool_result 可改写", async () => {
    const ch = fakeChannel()
    let ran = 0
    const ext = defineExtension({
      name: "t",
      setup(s) {
        s.registerTool(echoTool(() => void ran++))
        s.on("tool_call", ({ args }) => ((args as any).deny ? { block: true, reason: "不许" } : undefined))
        s.on("tool_result", () => ({ content: [{ type: "text", text: "改写后的结果" }] }))
      },
    })
    const t = setup({ extensions: [ch.ext, ext] })
    await t.kernel.start()
    const call = (args: Record<string, boolean>) => fauxAssistantMessage([fauxToolCall("t_echo", args)], { stopReason: "toolUse" })
    t.reply(call({}), call({ deny: true }), "好")
    ch.api.signal(say(main, "1"))
    await t.kernel.whenIdle()
    expect(ran).toBe(1)
    const results = t.entries(["toolResult"]).map((e) => e.data as any)
    expect(results[0].content[0].text).toBe("改写后的结果")
    expect(results[1]).toMatchObject({ isError: true, content: [{ text: "不许" }] })
  })
})

describe("Extension 加载", () => {
  it("configSchema 校验失败、重名、非法名字：不加载并记 ext_error，其余照常", async () => {
    const seen: unknown[] = []
    const schema = { type: "object", properties: { port: { type: "number" } }, required: ["port"] }
    const mk = (name: string, configSchema?: object) => defineExtension({ name, configSchema, setup: (s) => void seen.push([s.name, s.config]) })
    const t = setup()
    const kernel = (await import("../src/index.ts")).createKernel({
      home: t.home,
      dbPath: ":memory:",
      models: { resolve: () => ({ model: t.faux.getModel() }), stream: () => { throw new Error("unused") }, complete: () => { throw new Error("unused") } },
      extensions: [
        { def: mk("good", schema), config: { port: 1 } },
        { def: mk("bad", schema), config: { port: "x" } },
        { def: mk("good") },
        { def: mk("Bad_Name") },
      ],
    })
    await kernel.start()
    expect(seen).toEqual([["good", { port: 1 }]])
    expect(kernel.extensionInfos().map((e) => [e.name, e.status])).toEqual([["good", "loaded"], ["bad", "error"], ["good", "error"], ["Bad_Name", "error"]])
    expect(kernel.extensionInfos()[1]!.error).toMatch(/^invalid config: /)
    await kernel.stop()
  })
})
