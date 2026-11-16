/**
 * 终端 Channel：开发用的假 Channel，在终端里跑通单人格多 Room（docs/architecture.md §13 第 1 步）。
 * 不属于官方扩展清单；`sofia start --terminal` 时追加。
 *
 *   /room <名字> [group]   切换（或新建）Room；默认是私聊
 *   /as <名字>             以某个 Contact 的身份发言      /me   变回主人
 *   /stop                  打断当前 Run                    /compact  立即压缩
 *   /rooms                 列出 Room                       /quit     退出
 */
import { createInterface } from "node:readline"
import { defineExtension, type ExtensionDef, type RoomRef } from "@sofia/core"

export interface TerminalOptions {
  input?: NodeJS.ReadableStream
  output?: NodeJS.WritableStream
  onQuit?: () => void
}

export function createTerminalExtension(options: TerminalOptions = {}): ExtensionDef<{ debounceMs?: number }> {
  const input = options.input ?? process.stdin
  const output = options.output ?? process.stdout
  const print = (line: string) => void output.write(`${line}\n`)

  return defineExtension<{ debounceMs?: number }>({
    name: "terminal",
    configSchema: { type: "object", properties: { debounceMs: { type: "number" } } },
    setup(sofia) {
      const makeRoom = (name: string, kind: RoomRef["kind"]): RoomRef => ({
        channel: "terminal",
        id: `terminal:${kind}:${name}`,
        label: kind === "group" ? `群聊·${name}` : `私聊·${name}`,
        kind,
      })
      const rooms = new Map<string, RoomRef>()
      let room = makeRoom("main", "direct")
      rooms.set(room.id, room)
      let contact: string | undefined

      sofia.registerChannel({
        debounceMs: sofia.config?.debounceMs ?? 0,
        deliver: async (r, text) => print(`\n[${r.label}] Sofia：${text}`),
        onRunError: (r, error) => print(`\n[${r.label}] （出错了：${error.message}）`),
      })

      const send = sofia.registerTool({
        name: "send",
        label: "发送到终端 Room",
        description: "在指定的终端 Room 里说话。只在想对当前关注的 Room 之外的地方说话时使用。",
        parameters: {
          type: "object",
          properties: { room: { type: "string", description: "Room id，如 terminal:direct:main" }, text: { type: "string" } },
          required: ["room", "text"],
        },
        execute: async (_id, params: { room: string; text: string }) => {
          const target = rooms.get(params.room)
          if (!target) throw new Error(`未知的 Room：${params.room}`)
          print(`\n[${target.label}] Sofia：${params.text}`)
          return { content: [{ type: "text", text: "已发送" }], details: undefined }
        },
      })
      sofia.registerSection("channel:terminal", () =>
        [
          "# 终端（terminal）",
          `你可以用 ${send.name} 工具在下列 Room 里说话：`,
          ...[...rooms.values()].map((r) => `- ${r.id}（${r.label}${r.kind === "direct" ? "，主人的私聊" : ""}）`),
        ].join("\n"),
      )

      const command = (line: string): boolean => {
        const [cmd, ...args] = line.slice(1).trim().split(/\s+/)
        switch (cmd) {
          case "room": {
            const name = args[0]
            if (!name) return print(`当前 Room：${room.id}`), true
            const next = makeRoom(name, args[1] === "group" ? "group" : "direct")
            room = rooms.get(next.id) ?? next
            rooms.set(room.id, room)
            return print(`→ ${room.label}`), true
          }
          case "rooms":
            return print([...rooms.values()].map((r) => `${r === room ? "*" : " "} ${r.id}`).join("\n")), true
          case "as":
            contact = args[0]
            return print(contact ? `→ 以「${contact}」的身份发言` : "用法：/as <名字>"), true
          case "me":
            contact = undefined
            return print("→ 以主人的身份发言"), true
          case "stop":
            return sofia.abortRun(), true
          case "compact":
            return sofia.compact(), true
          case "quit":
          case "exit":
            return options.onQuit?.(), true
          default:
            return false
        }
      }

      sofia.on("start", () => {
        const rl = createInterface({ input, terminal: false })
        rl.on("line", (raw) => {
          const line = raw.trim()
          if (line === "") return
          if (line.startsWith("/") && command(line)) return
          const isOwner = contact === undefined
          sofia.signal({
            source: {
              kind: "room",
              room,
              // 身份只取决于 /as 状态，相当于平台账号 ID；显示名不参与判定
              sender: { id: isOwner ? "owner" : `contact:${contact}`, name: contact ?? "主人", isOwner },
            },
            priority: isOwner && room.kind === "direct" ? "high" : "normal",
            content: [{ type: "text", text: line }],
          })
        })
        rl.on("close", () => options.onQuit?.())
        sofia.on("shutdown", () => rl.close())
        print("Sofia 已启动。直接输入就是对她说话；/room /as /me /stop /compact /rooms /quit")
      })
    },
  })
}
