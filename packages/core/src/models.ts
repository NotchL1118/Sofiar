/**
 * Model Role → 具体模型（docs/architecture.md §9.1）。
 * daemon 依据 config.json 构建 pi-ai 的 `Models` 与角色表，再包成内核使用的 ModelRuntime。
 */
import type { Models } from "@earendil-works/pi-ai"
import type { ModelRuntime, ResolvedModel } from "./types.ts"

export function createModelRuntime(
  models: Pick<Models, "streamSimple" | "completeSimple">,
  roles: { main: ResolvedModel } & Record<string, ResolvedModel>,
): ModelRuntime {
  return {
    resolve: (role) => roles[role] ?? roles.main,
    stream: (model, context, options) => models.streamSimple(model, context, options),
    complete: (model, context, options) => models.completeSimple(model, context, options),
  }
}
