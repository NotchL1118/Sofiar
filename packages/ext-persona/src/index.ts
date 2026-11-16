/**
 * ext-persona：把人设文件作为 `persona` Section（docs/architecture.md §10.1）。
 * 每次调用都读文件；内容不变则内核不产生补丁。
 */
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { defineExtension } from "@sofia/core"

export interface PersonaConfig {
  /** 人设文件，相对数据目录；默认 persona.md */
  file?: string
}

export default defineExtension<PersonaConfig>({
  name: "persona",
  configSchema: {
    type: "object",
    properties: { file: { type: "string", description: "人设文件（相对数据目录），默认 persona.md" } },
  },
  setup(sofia) {
    const path = resolve(sofia.home, sofia.config?.file ?? "persona.md")
    let warned = false
    sofia.registerSection("persona", () => {
      let text = ""
      try {
        text = readFileSync(path, "utf8").trim()
      } catch {
        // 文件不存在：按空处理
      }
      if (text !== "") {
        warned = false
        return text
      }
      if (!warned) sofia.log.warn(`persona file is missing or empty: ${path}`)
      warned = true
      return null
    })
  },
})
