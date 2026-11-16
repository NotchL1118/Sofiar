# 写一个 Extension

Sofia 的一切功能都是 Extension；内核只提供 `SofiaAPI`。本文是上手路径，接口的权威定义在 `packages/core/src/types.ts`，设计与取舍在 [`architecture.md`](./architecture.md) §8。

## 最小骨架

```ts
import { defineExtension } from "@sofia/core"

export default defineExtension<{ greeting?: string }>({
  name: "hello",                                   // /^[a-z][a-z0-9-]{0,23}$/，全局唯一；也是工具前缀和 dataDir 目录名
  configSchema: { type: "object", properties: { greeting: { type: "string" } } },  // 内核据此校验，admin 据此生成表单
  setup(sofia) {
    // 这里只做注册。联网、开端口、起定时器放进 start；清理放进 shutdown。
    sofia.on("start", () => {})
    sofia.on("shutdown", () => {})
  },
})
```

在 `config.json` 的 `extensions` 里加 `{ "use": "<包名或相对数据目录的路径>", "config": {…} }`。数组顺序就是 hook 执行顺序和 Section 顺序。本地 `.ts` 文件免编译。官方扩展要同时加进 `packages/daemon/package.json` 的 dependencies，否则 daemon 解析不到包名。

## 照着哪个抄

| 想做的事 | 参考 | 用到的 API |
|---|---|---|
| 往系统提示词里放一段少变的内容 | `ext-persona` | `registerSection` |
| 接一个聊天平台 | `ext-telegram`（轮询）、`ext-desktop`（开端口） | `registerChannel`、`signal`、`registerTool`、`secret` |
| 给她一个工具 | `ext-desktop` 的 expression | `registerTool` |
| 让她主动想起一件事 | `ext-heartbeat` | `signal`（`source.kind: "internal"`） |
| 在压缩时做事 | `ext-compaction`、`ext-memory-md` | `on("before_compact")`、`on("compacted")`、`complete` |
| 旁观她的行为 | `ext-trace`、`ext-admin` | `events.subscribe` |
| 检索式记忆 | 尚无；用 `on("run_start")` 返回 `{ recall }` | `timeline.query` |

## 容易踩的地方

- **Section 要字节稳定。** provider 每个 Run 都会被调用，返回值一变就产生补丁、打掉 prompt cache。每次都变的东西（时间、检索结果）用 Recall 或 Signal，不要放 Section。
- **工具名只写动作。** `registerTool({ name: "send" })` 得到 `telegram_send`；在 Section 里提到工具时用返回值里的 `name`。工具增删只在下一个 Run 生效。
- **hook 会超时。** 被 await 的 hook 默认 10 秒（`before_compact` / `compacted` 120 秒），超时或抛异常只是被跳过并记一条 `hook{error}`。耗时的事在 `run_end` 里要自己异步去做。
- **需要返回值用 hook，只想知道发生了什么用事件流。** 事件流订阅者不能影响主流程。
- **`isOwner` 只能依据平台账号 ID**，绝不依据显示名。
- **`deliver` 里自己重试。** 它最终 reject 才算投递失败（她会收到一条 notice）；没连上客户端这类"没人听"的情况应当 resolve。
- **`dataDir` 是扩展私有的**（`<home>/ext/<name>/`）；`home` 下的共享文件（persona.md、memory.md）只读自己负责的那个。

## 测试

用 `packages/core/test/harness.ts`：`setup()` 给一个带 faux 模型的内核，`t.reply(...)` 脚本化模型回复，`fakeChannel()` 记录投递。任一 `packages/ext-*/test/` 都是现成的例子。手动试用一律 `SOFIA_HOME=~/.sofia-dev`（见 AGENTS.md）。
