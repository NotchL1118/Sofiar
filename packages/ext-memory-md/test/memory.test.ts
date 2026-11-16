import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fauxAssistantMessage } from "@earendil-works/pi-ai"
import { describe, expect, it } from "vitest"
import { fakeChannel, room, say, setup, userText } from "../../core/test/harness.ts"
import memory, { applyOps, listEntries, parseOps } from "../src/index.ts"

const main = room("main")
const long = (tag: string) => tag + "a".repeat(800)

describe("编辑操作", () => {
  it("解析：容忍列表符号、全角冒号、代码围栏，忽略认不出的行", () => {
    expect(parseOps("```\n- ADD: 主人周五去上海\nUPDATE 2：主人喜欢猫，养了团子\n`REMOVE #1`\n好的，以上是操作\nNONE\n```")).toEqual([
      { op: "add", text: "主人周五去上海" },
      { op: "update", index: 2, text: "主人喜欢猫，养了团子" },
      { op: "remove", index: 1 },
    ])
  })
  it("应用：未涉及的行原样保留，编号指向应用前的条目，新增接在最后一条之后", () => {
    const file = "# 记忆\n\n- 甲\n- 乙\n\n## 备注\n手写的一段话\n- 丙\n"
    expect(listEntries(file)).toEqual(["甲", "乙", "丙"])
    const next = applyOps(file, [{ op: "remove", index: 1 }, { op: "update", index: 3, text: "丙改" }, { op: "add", text: "丁" }, { op: "remove", index: 9 }])
    expect(next).toBe("# 记忆\n\n- 乙\n\n## 备注\n手写的一段话\n- 丙改\n- 丁\n")
    expect(applyOps("", [{ op: "add", text: "第一条" }])).toBe("- 第一条\n")
  })
})

describe("ext-memory-md", () => {
  const boot = (file?: string, config: object = {}) => {
    const home = mkdtempSync(join(tmpdir(), "sofia-memory-"))
    if (file !== undefined) writeFileSync(join(home, "memory.md"), file)
    const ch = fakeChannel()
    const t = setup({ home, extensions: [{ def: memory, config }, ch.ext], config: { compaction: { keepRecentTokens: 500 } } })
    const chat = async (tags: string[]) => {
      for (const tag of tags) {
        t.reply(long(`答${tag}`))
        ch.api.signal(say(main, long(`问${tag}`)))
        await t.kernel.whenIdle()
      }
    }
    const memorySections = () =>
      t.entries(["system"]).flatMap((e) => {
        const sections = (e.data as any).sections ?? {}
        return "memory" in sections ? [sections.memory as string | null] : []
      })
    return { home, ch, t, chat, memorySections }
  }

  it("Section 只在 rebuild 时刷新；compacted 时按编辑操作更新文件、留历史，并在检查点里立即生效", async () => {
    const b = boot("- 主人叫阿洋\n- 主人喜欢猫\n")
    await b.t.kernel.start()
    expect(b.memorySections()).toHaveLength(1)
    expect(b.memorySections()[0]).toContain("- 主人叫阿洋\n- 主人喜欢猫")

    // 两次压缩之间手改文件：Section 字节不变
    writeFileSync(join(b.home, "memory.md"), "- 主人叫阿洋\n- 主人喜欢猫\n- 手动加的一条\n")
    await b.chat(["1", "2", "3"])
    expect(b.memorySections()).toHaveLength(1)

    b.t.reply("UPDATE 2: 主人喜欢猫，养了一只叫团子的橘猫\nADD: 主人 2026-11-13 要去上海出差（私聊）")
    b.ch.api.compact()
    await b.t.kernel.whenIdle()

    const request = b.t.requests.at(-1)!
    expect(userText(request)).toContain("1. 主人叫阿洋\n2. 主人喜欢猫\n3. 手动加的一条")
    expect(userText(request)).toMatch(/【即将被遗忘的对话记录】\n\[main · [^\]]+\] 阿洋（主人）：问1/)
    expect(userText(request)).toContain("预算 1500 token")
    expect(b.t.of("llm_request").at(-1)).toMatchObject({ role: "cheap" })

    const file = readFileSync(join(b.home, "memory.md"), "utf8")
    expect(file).toBe("- 主人叫阿洋\n- 主人喜欢猫，养了一只叫团子的橘猫\n- 手动加的一条\n- 主人 2026-11-13 要去上海出差（私聊）\n")
    const history = readdirSync(join(b.home, "ext", "memory-md", "history"))
    expect(history).toHaveLength(1)
    expect(readFileSync(join(b.home, "ext", "memory-md", "history", history[0]!), "utf8")).toContain("- 手动加的一条")

    // compaction 之后的全量检查点带着新记忆
    const all = b.t.entries()
    const checkpoint = all[all.findIndex((e) => e.type === "compaction") + 1]!
    expect((checkpoint.data as any).sections.memory).toContain("团子的橘猫")
    await b.chat(["4"])
    expect(JSON.stringify(b.t.requests.at(-1)![0])).toContain("团子的橘猫")
  })

  it("没有文件时 Section 不存在；NONE 不写文件；请求失败只记 hook 错误，压缩照常完成", async () => {
    const b = boot(undefined, { budgetTokens: 10, role: "main" })
    await b.t.kernel.start()
    expect(b.memorySections()).toEqual([])
    await b.chat(["1", "2", "3"])

    b.t.reply("NONE")
    b.ch.api.compact()
    await b.t.kernel.whenIdle()
    expect(existsSync(join(b.home, "memory.md"))).toBe(false)

    await b.chat(["4", "5"])
    b.t.reply(fauxAssistantMessage([], { stopReason: "error", errorMessage: "invalid api key" }))
    b.ch.api.compact()
    await b.t.kernel.whenIdle()
    expect(b.t.of("hook").filter((h) => h.error).map((h) => [h.event, h.error])).toEqual([["compacted", "invalid api key"]])
    expect(b.t.entries(["compaction"])).toHaveLength(2)

    await b.chat(["6", "7"])
    b.t.reply("ADD: 主人叫阿洋")
    b.ch.api.compact()
    await b.t.kernel.whenIdle()
    expect(readFileSync(join(b.home, "memory.md"), "utf8")).toBe("- 主人叫阿洋\n")
    expect(b.memorySections().at(-1)).toContain("- 主人叫阿洋")
    expect(existsSync(join(b.home, "ext", "memory-md", "history"))).toBe(false)
  })
})
