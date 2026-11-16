import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai"
import { defineExtension } from "@sofia/core"
import { expect, it } from "vitest"
import { fakeChannel, room, say, setup } from "../../core/test/harness.ts"
import trace from "../src/index.ts"

const main = room("main")
const tools = defineExtension({
  name: "t",
  setup: (s) => {
    s.on("turn_end", () => {})
    s.registerTool({
      name: "echo", label: "echo", description: "echo", parameters: { type: "object", properties: {} },
      execute: async () => ({ content: [{ type: "text", text: "工具的秘密结果" }], details: undefined }),
    })
  },
})

async function run(config: object) {
  const home = mkdtempSync(join(tmpdir(), "sofia-trace-"))
  const ch = fakeChannel()
  const t = setup({ home, extensions: [{ def: trace, config }, tools, ch.ext] })
  await t.kernel.start()
  t.reply(fauxAssistantMessage([fauxToolCall("t_echo", {})], { stopReason: "toolUse" }), "回复里的秘密")
  ch.api.signal(say(main, "消息里的秘密"))
  await t.kernel.whenIdle()
  const runId = t.of("run_start")[0]!.run.id
  await t.kernel.stop()
  const db = new DatabaseSync(join(home, "trace.db"))
  const rows = db.prepare("SELECT * FROM events ORDER BY seq").all() as any[]
  db.close()
  return { rows, runId }
}

it("把事件流写入 trace.db：kind / run_id / turn / room / ext / ms；默认不含消息内容", async () => {
  const { rows, runId } = await run({})
  const kinds = rows.map((r) => r.kind)
  for (const kind of ["signal_received", "bucket_ready", "run_scheduled", "run_start", "turn_start", "message_end", "llm_request",
    "tool_execution_start", "tool_execution_end", "turn_end", "delivery", "agent_end", "run_end", "hook", "tools_patch"]) {
    expect(kinds).toContain(kind)
  }
  expect(kinds).not.toContain("message_update")

  const inRun = rows.filter((r) => r.run_id === runId)
  expect(inRun.every((r) => r.room === main.id)).toBe(true)
  expect(rows.filter((r) => r.kind === "turn_end").map((r) => r.turn)).toEqual([1, 2])
  const tool = rows.find((r) => r.kind === "tool_execution_end")
  expect(tool).toMatchObject({ turn: 1, run_id: runId })
  expect(typeof tool.ms).toBe("number")
  expect(JSON.parse(tool.data)).toEqual({ toolCallId: expect.any(String), toolName: "t_echo", isError: false })
  expect(rows.find((r) => r.kind === "hook")).toMatchObject({ ext: "t", run_id: runId })
  expect(JSON.parse(rows.find((r) => r.kind === "signal_received").data)).toMatchObject({ sender: "阿洋", isOwner: true, chars: 6 })
  expect(JSON.parse(rows.find((r) => r.kind === "run_end").data)).toEqual({ status: "ok" })

  expect(JSON.stringify(rows)).not.toContain("秘密")
})

it("recordPayloads：记录完整消息与工具内容", async () => {
  const { rows } = await run({ recordPayloads: true })
  const all = JSON.stringify(rows)
  for (const secret of ["消息里的秘密", "回复里的秘密", "工具的秘密结果"]) expect(all).toContain(secret)
})
