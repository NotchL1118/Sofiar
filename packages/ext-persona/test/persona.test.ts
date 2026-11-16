import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai"
import { createKernel, createModelRuntime, defineExtension, type SofiaAPI } from "@sofia/core"
import { expect, it } from "vitest"
import persona from "../src/index.ts"

function boot(home: string, config?: { file?: string }) {
  const faux = fauxProvider()
  const models = createModels()
  models.setProvider(faux.provider)
  let api!: SofiaAPI
  const probe = defineExtension({ name: "probe", setup: (s) => void (api = s) })
  const kernel = createKernel({
    home,
    dbPath: ":memory:",
    models: createModelRuntime(models, { main: { model: faux.getModel() } }),
    extensions: [{ def: persona, config }, { def: probe }],
  })
  const warnings: string[] = []
  kernel.events.subscribe((e) => e.type === "log" && e.level === "warn" && warnings.push(e.message))
  const talk = async () => {
    faux.appendResponses([fauxAssistantMessage("[[NO_REPLY]]")])
    api.signal({ source: { kind: "internal", from: "probe" }, priority: "low", content: [{ type: "text", text: "." }] })
    await kernel.whenIdle()
  }
  const personaPatches = () =>
    kernel.timeline.query({ types: ["system"] }).flatMap((e) => {
      const sections = (e.data as { sections?: Record<string, string | null> }).sections ?? {}
      return "persona" in sections ? [sections.persona] : []
    })
  return { kernel, talk, personaPatches, warnings }
}

it("persona.md 成为 persona Section；改文件在下一个 Run 生效，不变则无补丁；缺失时移除并告警一次", async () => {
  const home = mkdtempSync(join(tmpdir(), "sofia-persona-"))
  writeFileSync(join(home, "persona.md"), "你是 Sofia。\n")
  const t = boot(home)
  await t.kernel.start()
  await t.talk()
  await t.talk()
  expect(t.personaPatches()).toEqual(["你是 Sofia。"])

  writeFileSync(join(home, "persona.md"), "你是 Sofia，话很少。")
  await t.talk()
  expect(t.personaPatches()).toEqual(["你是 Sofia。", "你是 Sofia，话很少。"])

  writeFileSync(join(home, "persona.md"), "  \n")
  await t.talk()
  await t.talk()
  expect(t.personaPatches().at(-1)).toBeNull()
  expect(t.warnings).toHaveLength(1)
  await t.kernel.stop()
})

it("config.file 切换人设文件", async () => {
  const home = mkdtempSync(join(tmpdir(), "sofia-persona-"))
  mkdirSync(join(home, "personas"))
  writeFileSync(join(home, "persona.md"), "默认人设")
  writeFileSync(join(home, "personas", "b.md"), "另一份人设")
  const t = boot(home, { file: "personas/b.md" })
  await t.kernel.start()
  expect(t.personaPatches()).toEqual(["另一份人设"])
  await t.kernel.stop()
})
