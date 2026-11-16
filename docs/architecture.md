# Sofia 架构设计（v1）

> 本文是实现依据。术语以根目录 [`GLOSSARY.md`](../GLOSSARY.md) 为准，关键取舍见 [`docs/adr/`](./adr/)。
> 依赖：`@earendil-works/pi-ai` 与 `@earendil-works/pi-agent-core` **1.5.x**（`@mariozechner/*` 已废弃，勿用）。

---

## 0. 目标与原则

Sofia 是一个**长期运行的个人陪伴 Agent**：一个人格、一条永不结束的 Timeline，同时活在多个 Channel（本地桌面 Live2D、Telegram……）里，像同一个人一样与 Owner 和其他 Contact 交流。

设计原则：

1. **如无必要，勿增实体。** 每个概念都必须有不可替代的职责。
2. **内核极简。** 内核只负责：Queue 与调度、Signal 渲染、Timeline 持久化、Agent Loop 封装、Compaction 的触发与记账、Hook 分发。**内核没有任何"功能"**——人设、记忆、压缩策略、Channel、观测、管理界面全部是 Extension。
3. **只有一种插件：Extension。** Channel 只是"注册了 Channel 的 Extension"。
4. **内核定义形状，Extension 适配形状**（依赖倒置）。
5. **稳定的放 Section，每次变的放 user 消息**（保护 prompt cache）。

---

## 1. 领域模型

```
                ┌──────────── Extension ────────────┐
                │  (Channel / persona / memory / …) │
                └──┬───────────┬───────────┬────────┘
       registerChannel   registerTool   registerSection
                   │           │            │
 平台消息 ─► Channel ─signal()─► Queue ─调度─► Run ─(Turn × N)─► Delivery ─► Channel ─► 平台
                                  ▲            │
                       internal Signal      写入
                      (heartbeat 等扩展)       ▼
                                         Timeline (timeline.db)
                                               │ 只读事件流
                                               ▼
                                         Trace (trace.db) ─► admin 泳道图
```

| 概念 | 一句话 | 归属 |
|---|---|---|
| Owner / Contact | 主人只有一个；其他人是 Contact，按 Channel 区分 | Channel 判定 |
| Channel / Room | 接入方式 / 其中一个具体对话场所 | Extension |
| Signal | 需要她注意的一件事：Room 里的发言，或扩展产生的内部念头 | 内核定义结构 |
| Queue | Signal 等待被处理的地方（仅内存） | 内核 |
| Run / Turn | 一次连续的思考行动 / 其中一次模型回复+工具 | 内核（pi-agent-core） |
| Focus Room | Run 所关注的 Room，回复默认投递到这里；可为空 | 内核 |
| Delivery | 把回复投递到 Focus Room | 内核调用 Channel |
| Timeline | 唯一、永久、只追加的经历记录 | 内核 |
| Section | 系统提示词中具名、少变的一段 | Extension 提供，内核拼装 |
| Recall | Run 开始时写入的"想起来的东西" | Extension 提供，内核写入 |
| Notice | 内核写入的旁白（Run 失败/中断） | 内核 |
| Compaction | 用摘要替换最旧的工作上下文 | 触发/记账在内核，摘要策略在 Extension |
| Trace | 可选的行为观测记录 | Extension |
| Model Role | `main`、`cheap` 等用途名 → 具体 provider+模型 | 配置 |

**关键约束（ADR-0001）**：同一时刻至多一个 Run；所有 Room 共享同一 Timeline。

---

## 2. 进程拓扑与仓库结构

### 2.1 进程

- **daemon**：单个常驻 Node 进程（≥ 24，使用内置 `node:sqlite`；22 上仍为 experimental），包含内核与全部 Extension。
- **单实例**：启动时在 `SOFIA_HOME` 获取 `daemon.lock`（记录 pid，残留锁检测进程是否存活）；已被占用则拒绝启动，避免两个 daemon 同写 timeline.db、抢 Telegram 长轮询。
- **Electron 客户端**：独立进程，瘦客户端，经本地 WebSocket 连接 `ext-desktop`。关掉客户端不影响 daemon。
- **admin 页面**：浏览器打开 `ext-admin` 托管的本地页面（Electron 也可内嵌）。

`ext-desktop` 对 Electron 而言，就如 Telegram 服务器对 `ext-telegram`——**Channel 扩展本身就是适配层**，不再加中间层。

### 2.2 monorepo（pnpm workspace，TypeScript）

```
packages/
  core/             内核：Queue、调度、渲染、Timeline、Agent 封装、Hook、SofiaAPI 类型（对外唯一类型来源）
  daemon/           入口：读取配置、加载扩展（jiti）、监督重启、CLI
  ext-persona/      人设 Section
  ext-compaction/   官方 LLM 摘要压缩
  ext-memory-md/    默认记忆（memory.md）
  ext-trace/        Trace 写入 trace.db
  ext-heartbeat/    定时/空闲产生 internal Signal
  ext-telegram/     Telegram Channel
  ext-desktop/      Desktop Channel（含 WebSocket 服务端）
  ext-admin/        管理 HTTP/WS 接口 + 托管 admin-web 静态文件
apps/
  desktop/          Electron + Live2D 客户端
  admin-web/        管理页前端（配置表单、扩展管理、泳道图）
```

v1 不拆独立 `sdk` 包；扩展作者从 `@sofia/core` 引类型。

### 2.3 数据目录（默认 `~/.sofia/`，可用 `SOFIA_HOME` 覆盖）

```
~/.sofia/
  config.json        配置（可由 admin 页面编辑）
  secrets.json       密钥（也可用同名环境变量）
  persona.md         人设（ext-persona）
  memory.md          记忆（ext-memory-md）
  timeline.db        Timeline（内核）
  trace.db           Trace（ext-trace，可随时删除）
  ext/<name>/        各扩展私有数据目录（sofia.dataDir）
```

配置与代码分离，升级应用不影响数据。

**生产与测试分开**：`~/.sofia/` 是主人的正式数据。Timeline 是她永久的经历，对她说过的每句话都会留在上下文里，并在 Compaction 时进入摘要与 memory.md——测试语句同样如此。因此手动测试、冒烟、实验一律使用独立的数据目录：

```
SOFIA_HOME=~/.sofia-dev pnpm sofia start --terminal
```

`~/.sofia-dev/` 拥有自己的配置、密钥、人设与 Timeline，与 `~/.sofia/` 互不影响。想让她"从零开始"：停掉 daemon，删除对应目录下的 `timeline.db`（及 `memory.md`）。自动化测试使用临时目录。

### 2.4 与 pi-agent-core 的关系

内核使用 pi-agent-core 的 **`Agent` 类**（不直接用底层 `agentLoop` / `runAgentLoop`），全部包在内核的一个模块里，其余代码不直接接触 `Agent`：

- 直接复用：`prompt` / `continue`（启动与溢出重试）、`steer` + `steeringMode: "all"`、`abort`、监听器按序 await（保证 `message_end` 落盘完成后才继续）、`isStreaming`。
- 构造参数：`streamFn`（内核包重试，§5.4）、`convertToLlm`（Signal 渲染，§3.2）、`transformContext`（`context` hook）、`beforeToolCall` / `afterToolCall`（`tool_call` / `tool_result` hook）、`finishTurn`（Turn 上限）、`prepareNextTurnWithContext`（Turn 间压缩；`Agent` 上的 `prepareNextTurn` 只收到 signal，拿不到上下文）。
- **`agent.state.messages` 只是当前 Run 的工作副本**；事实来源是 Timeline，每个 Run 开始时重建（§5.1）。
- 不使用 followUp 队列、`reset()`。调度器保证同一时刻只有一个 Run，因此不会触发 `prompt()` 在运行中被调用时抛出的异常。

---

## 3. Signal

### 3.1 结构（内核定义，ADR-0005）

```ts
interface RoomRef {
  channel: string          // "telegram"
  id: string               // 全局唯一，约定 "<channel>:<kind>:<platformId>"，如 "telegram:group:-100123"、"desktop:direct:main"
  label: string            // "群聊·摸鱼小队"
  kind: "direct" | "group"
}

interface Signal {
  id: string
  at: number               // epoch ms
  source:
    | { kind: "room"; room: RoomRef; sender: { id: string; name: string; isOwner: boolean } }
    | { kind: "internal"; from: string /* 扩展名 */; room?: RoomRef /* 可选目标 Room */ }
  priority: "high" | "normal" | "low"
  content: (TextContent | ImageContent)[]   // pi-ai 内容块，Channel 已把平台方言转换好
  notes?: string[]                          // 「回复了 小王："…"」「@了你」等附加说明
}
```

Channel 的职责：把平台消息**规范化**为 Signal——判定 `isOwner`（只能依据平台账号 ID，绝不依据显示名）、贴纸/表情/引用转成文字说明、图片下载成 image block、打优先级。

默认优先级约定（由 Channel 实现，非内核规则）：Owner 私聊 `high`，群聊 `normal`；internal Signal 固定 `low`。

### 3.2 渲染（内核唯一渲染器）

`convertToLlm` 时：

```
[{room.label} · {YYYY-MM-DD HH:mm}] {sender.name}{isOwner ? "（主人）" : ""}：{text}
  （{notes 逐条}）
```

internal Signal 渲染为：

```
<internal from="heartbeat" at="2026-11-10 21:00">…</internal>
```

sender.name 去除换行。图片块原样随附。

---

## 4. 调度

### 4.1 Queue 与防抖

内核为每个"桶"维护待处理 Signal：

- room Signal 的桶 = 其 `room.id`；
- 带目标 Room 的 internal Signal 进入该 Room 的桶；
- 无目标的 internal Signal 进入共享桶 `internal`。

收到 Signal（经 `signal` hook 后）：

1. **若当前 Run 的 Focus Room 就是该 Room** → 立即 `agent.steer(signal)`（`steeringMode: "all"`），pi-agent-core 会在当前 Turn 的工具批次全部完成、`turn_end` 后、下一次 LLM 请求前注入。**不走防抖**。
2. 否则放入桶，重置该桶的防抖计时器（时长 = Channel 的 `debounceMs`，默认 1500；internal 桶为 0）。计时器到期 → 桶变为**就绪**。另有最长等待（Channel 的 `maxWaitMs`，默认 5000）：从桶里第一条 Signal 到达起算，到时无论是否仍有新消息都变为就绪，防止群里连续刷屏导致永不就绪。

### 4.2 选择下一个 Run

内核空闲时，从就绪桶中选：优先级最高者（桶优先级 = 其中 Signal 的最高优先级）；同级取最早 Signal 的 `at` 最早者。**一次取走该桶全部 Signal** 开启一个 Run（合并处理）。

调度决策（候选、选择理由）作为事件发到事件流，供 Trace 记录。

### 4.3 不抢占与 Turn 上限

- 运行中的 Run 不会因更高优先级的 Signal 被打断；其余桶等待。
- 可选的单个 Run Turn 上限 `maxTurnsPerRun`（**默认不限制**；用于无人看管时防止工具循环挡住其他 Room，手动停止见 §5.5），通过 `finishTurn` 返回 `{action:"end"}` 实现。配置后触顶时按失败处理：写 notice「（你在 [{room.label}] 的这次处理步骤太多，被强制停下了）」，并调用 `channel.onRunError`，与 §5.4 对齐。

### 4.4 Run 结束时的残留

`agent_end` 后若 `agent.hasQueuedMessages()`（steer 在最后一次轮询之后才到达），内核先 `peekQueuedMessages()` 取得副本，再 `clearSteeringQueue()`（它只清空、不返回），其中的 Signal 放回该 Room 桶首并立即标记就绪，再进入调度。内核不使用 followUp 队列。

---

## 5. Run 生命周期

```
选中桶 ──► [compaction 检查] ──► Section/工具 diff ──► run_start hook(收集 recall)
   ──► 写入 Timeline: (system 补丁?) → recall? → signal × N
   ──► agent.prompt([...])
        └─ Turn: LLM 流式 → message_end(assistant) → Delivery
                 → 工具执行(tool_call/tool_result hook) → turn_end hook
                 → steer 注入? → prepareNextTurn(compaction 检查) → 下一 Turn …
   ──► agent_end ──► run_end hook ──► 残留处理 ──► 调度下一个
```

### 5.1 Run 开始

**Timeline 写入规则**：
- **Run 进行中**，消息只经 pi-agent-core 的 `message_end` 落盘（system 补丁 / signal / recall / notice / assistant / toolResult 全部如此）。原因：loop 会根据 `state.tools` 自动改写或插入工具增删的 system 消息，只有 `message_end` 看到的才是真实 transcript。唯一例外是 Turn 间压缩：`compaction` 条目与其后的全量 system 检查点由内核直接写入（§7.3）。
- **Run 之间**，内核可直接追加条目（`notice`、Run 开始前的 `compaction` 与检查点）——因为每个 Run 开始都会从 Timeline 重建上下文。Run 进行中产生的 notice 先由内核攒着：loop 本来就要进入下一个 Turn 时，经 `prepareNextTurnWithContext` 返回的 `messages` 注入（下个 Turn 前可见，随 `message_end` 落盘）；否则在 Run 结束时直接写入 Timeline。**不用 `agent.steer()`**——steer 会让本该结束的 Run 多跑一个 Turn。
- `runs` 表由内核直接维护。

步骤：

1. 在 `runs` 表记录 `{id, focusRoom, startedAt}`。
2. 若需压缩，先执行 Compaction（§7.3）。
3. **从 Timeline 重建** `agent.state.messages`（§7.3 重建规则）。每个 Run 都重建，保证 Turn 间压缩真正生效（`prepareNextTurnWithContext` 返回的 context 只在当次 loop 内有效，不会回写 `state.messages`）。
4. 设置 `agent.state.tools` = 工具注册表当前内容（工具差异由 loop 自动声明为 `toolsAdded/toolsRemoved`）；调用所有 Section provider（`reason: "run"`），与当前 system 状态 diff，有变化则构造一条只含 `sections` 的 system 补丁消息。
5. 触发 `run_start`，收集各扩展返回的 `recall`。
6. `agent.prompt([sections补丁?, recall?, ...signals])`，这些消息经 `message_end` 落盘。

Focus Room：room 桶 → 该 Room；带目标的 internal → 目标 Room；`internal` 桶 → 无。

### 5.2 Delivery（ADR-0004）

挂在 pi-agent-core 的 `message_end`（assistant）上：

1. 拼接该消息全部 `text` 块（`thinking` 永不投递）。
2. `trim()` 后若为 Silence Token → 不投递。判定：去掉首尾空白与方括号、忽略大小写后等于 `NO_REPLY`（即 `[[NO_REPLY]]`、`[NO_REPLY]`、`NO_REPLY` 均可）。只在**整条文本**等于时生效。
3. 空文本不投递；无 Focus Room 不投递；`stopReason` 为 `error` / `aborted` 的消息不投递（它们不进入重建的上下文，§7.3，投递了她就不记得自己说过）。已经 `onDelta` 出去的半截文字由 Channel 在 `onRunError` 或自己的停止逻辑里收尾。
4. 触发 `deliver` hook（可改文本或取消）。
5. **不 await** 地调用 `channel.deliver(room, text)`（pi-agent-core 会 await 监听器，阻塞会卡住 Loop）。同一 Room 的投递串成一条 Promise 链，保证先说的先到。短暂失败由 Channel 在 `deliver` 内自行退避重试；`deliver` 最终 reject 视为持续失败，按 §5.4 的错误上报原则处理。
6. 流式：若 Channel 实现 `onDelta`，内核在 `message_update` 上转发文本增量（仍以 `deliver` 的最终文本为准）。**扣留规则**：只要已累积文本去掉前导空白后仍可能是 Silence Token 的前缀（如 `[`、`[[NO`），就先扣住不发；一旦不可能是，再把扣住的部分一并推出。

显式 `{channel}_send` 工具与自动投递并存，内核不做去重——由模型自己决定是否还要说话。

### 5.3 Run 结束

- 更新 `runs` 表 `{endedAt, status: "ok" | "error" | "aborted"}`（第四种 `interrupted` 只在启动恢复时标记，§7.4）。
- 触发 `run_end({ run, entries, error? })`（通知；扩展如需耗时处理应异步执行，不阻塞调度）。

### 5.4 失败

- pi-agent-core 没有 Run 级重试（provider SDK 只有默认少量重试）。内核包一层 `streamFn` 做退避重试（默认 3 次），用 pi-ai `utils/retry` 的 `isRetryableAssistantError` 判断可重试、`retryDelayMs` 计算退避。不直接用 `retryAssistantCall`：它的入参是返回完整消息的 `() => Promise<AssistantMessage>`，套在流上会丢掉增量。
- **重试只发生在尚未产生任何内容事件之前**（首个 `text_delta` / `thinking_delta` / `toolcall_start` 之前出错，如连接失败、429、5xx）。一旦已有增量推出（可能已经 `onDelta` 到 Channel），就不重试，错误透传、Run 以 `error` 结束——避免同一段话被重复推送。
- 仍失败则 Run 以 `error` 结束。
- 已消费的 Signal **不重新入队**（避免重复回复）。
- Timeline 追加 `notice`：「（你刚才因为 {原因} 没能回应 [{room.label}] 的消息）」。
- 有 Focus Room 时调用 `channel.onRunError?.(room, error)`，由 Channel 决定如何告知（Telegram 回一句、desktop 显示错误态）。internal Run 失败只进 Trace。
- Extension hook 抛异常：记录事件、跳过该 handler，不影响 Run。
- **错误上报原则**：只把"她以为成功、实际失败"的事告诉她。工具失败由工具结果自带；扩展/hook 错误只进 Trace；自动投递持续失败时写 notice「（你刚才发往 [{room.label}] 的消息没有发出去）」——当前 Run 还要进入下一个 Turn 则随之注入（下个 Turn 前可见），否则在 Run 结束时写入 Timeline，没有 Run 时直接写入；**不为此唤醒新 Run，也不为此催生额外的 Turn**（避免对已故障的 Channel 反复重发）。
- **hook 超时**：所有被 await 的 hook 都有超时（默认 10s，`before_compact` / `compacted` 默认 120s，`kernel.hookTimeoutMs` 可配）；超时视为无返回值，记 `hook{error:"timeout"}`。防止一个卡住的扩展卡死唯一的 Run。

### 5.5 中止

- 任何扩展可调用 `sofia.abortRun()`：desktop 客户端的停止按钮、Telegram 主人发送 `/stop`、admin 页面的停止按钮。
- 内核调用 `agent.abort()`：未执行的工具得到中止结果，最后的 assistant 消息 `stopReason: "aborted"`（重建时被过滤，§7.3）。
- `runs.status = "aborted"`；Run 结束后写 notice：「（主人打断了你）」。已消费的 Signal 不重新入队；Run 期间 steer 残留同样丢弃（不走 §4.4 回队）。注意：已在 Turn 之间被 loop 取走注入的 steer Signal 已落盘在 Timeline 里，只是没得到回应——这是可接受的（主人喊了停），下个 Run 她能在上下文里看到它们。
- 在工具执行期间中止时，之前那条正常 assistant 消息里可能留下没有结果的工具调用；pi-ai 在发送前会自动补 `No result provided` 结果，内核不额外处理。

---

## 6. 系统提示词、Section 与工具

### 6.1 机制

pi-ai 1.5 把系统提示词存为 Timeline 中的 `SystemMessage`：第一条为全量，之后每次变更都在当前位置追加一条**差异补丁**（`sections: {name: string | null}`、`toolsAdded`、`toolsRemoved`）。支持中途 system 消息的模型原位保留补丁（前缀缓存不失效）；不支持的由 pi-ai 合并到开头。

### 6.2 规则

**很少变的放 Section；每个 Run 都变的放 user 消息。**

| 放 Section | 放 user 消息 |
|---|---|
| 内核规则、人设、memory.md、各 Channel 说明与主人 Room 列表、Live2D 可用动作 | Signal、Recall、当前时间、Notice |

### 6.3 Section provider

```ts
sofia.registerSection(name, (ctx: { reason: "run" | "rebuild" }) => string | null)
```

- `reason: "run"`：每个 Run 开始时调用；`"rebuild"`：启动与 Compaction 重建上下文时调用。
- 返回 `null` 表示移除该 Section。名字须匹配 `/^[a-z][a-z0-9_:-]*$/`。
- 顺序：内核 `kernel` Section 最前，其余按扩展在 `config.json` 中的顺序、同扩展内按注册顺序。
- 内核唯一内置 Section `kernel`：说明消息格式（Room/时间/主人标记）、自动投递语义与 Silence Token 用法。这是内核语义本身的一部分，不属于"功能"。

### 6.4 工具注册表

- **命名空间**：扩展注册时只写动作名（如 `send`），内核自动加前缀 `{扩展名}_`，模型看到的是全名（`telegram_send`）。全名须匹配 provider 限制 `^[a-zA-Z0-9_-]{1,64}$`，不合法则拒绝注册并记 `ext_error`。
- **冲突**：不同扩展的工具因前缀天然不重名；同一扩展重复注册同名工具 → 替换旧的。扩展名的唯一性在加载时保证（§8.1）。不支持跨扩展替换工具。
- `sofia.registerTool(tool)` 返回 `{ name: 全名, unregister() }`；扩展在 Section 中提及自己的工具时用这个全名。任何时候可注册/注销（如 ext-desktop 在客户端连上时注册 Live2D 工具，断开时注销）。
- **只在 Run 开始时生效**：内核在 Run 开始设置 `agent.state.tools`，loop 自动把差异声明为 `toolsAdded/toolsRemoved` system 消息并经 `message_end` 落盘；Run 进行中工具集不变。
- 工具**不随 Focus Room 变化**：她在群里也能 `telegram_send` 私聊主人。
- 工具类型即 pi-agent-core 的 `AgentTool`（参数为 JSON Schema，推荐 `@earendil-works/pi-schema` 构建）。
- 约定：每个 Channel 扩展注册 `send(room, text, …)` 工具（模型看到 `{扩展名}_send`），并在 `channel:{id}` Section 中列出主人所在的 Room 与常用 Room。

---

## 7. Timeline 与 Compaction

### 7.1 存储（ADR-0003）

`timeline.db`，SQLite WAL，`node:sqlite`：

```sql
CREATE TABLE entries (
  seq     INTEGER PRIMARY KEY AUTOINCREMENT,
  id      TEXT NOT NULL UNIQUE,
  at      INTEGER NOT NULL,
  type    TEXT NOT NULL,       -- 见 7.2
  run_id  TEXT,
  room    TEXT,                -- RoomRef.id
  data    TEXT NOT NULL        -- JSON：AgentMessage 或扩展数据
);
CREATE INDEX entries_run  ON entries(run_id);
CREATE INDEX entries_room ON entries(room, at);

CREATE TABLE runs (
  id TEXT PRIMARY KEY, focus_room TEXT, started_at INTEGER NOT NULL,
  ended_at INTEGER, status TEXT          -- ok | error | aborted | interrupted
);
```

只追加；从不原地改写 `entries`。备份用 SQLite 在线备份；`sofia export` 导出 JSONL。

### 7.2 条目类型

| type | 发给 LLM | 说明 |
|---|---|---|
| `system` | 是 | 全量提示词或补丁（sections / 工具增删） |
| `signal` | 是 → user | `data` 为 Signal |
| `recall` | 是 → user | `data: { from: string; items: string[] }` |
| `assistant` | 是 | pi 原生 |
| `toolResult` | 是 | pi 原生 |
| `notice` | 是 → user | 渲染为 `<notice>…</notice>` |
| `compaction` | 摘要发出 | `{ summary, firstKeptSeq, tokensBefore }` |

`signal` / `recall` / `notice` 通过 pi-agent-core 的 `CustomAgentMessages` 声明合并成为自定义消息；`convertToLlm` 把它们转为 user 消息，并**合并相邻的 user 消息**（故 recall 与本次 Signal 自然合为一条，失败 Notice 与下一 Run 的 Signal 也不会出现连续 user 消息）。

Recall 渲染：

```
<recall>
你想起了这些：
- …
</recall>
```

### 7.3 Compaction（触发与记账在内核，摘要在扩展）

- **检查点**：Run 开始前、`prepareNextTurn`（Turn 之间）、上下文溢出错误后。
- **Turn 间压缩**：`compaction` 条目与全量 system 检查点都由内核直接写入，`prepareNextTurnWithContext` 返回从 Timeline 重建后的 `context`。检查点不能放进返回的 `messages`：pi-ai 只把开头那条 system 当全量，之后的一律按补丁重放，追加在末尾的"全量"会被当成补丁。Run 进行中工具集不变，检查点沿用本 Run 的工具集，与 loop 会声明的一致。该 context 只在当次 loop 有效，下个 Run 开始从 Timeline 重建（§5.1）。
- **溢出恢复**：溢出在 pi-agent-core 中是硬退出，出错的 assistant 消息已落盘。内核用 `isContextOverflow(msg, contextWindow)` 判定（自定义代理识别不到时按普通错误处理）→ 强制压缩 → 重建 `state.messages` → `agent.continue()` 重试一次，仍属同一个 Run。重建结果不含那条出错的 assistant（见下文重建规则），因此末尾必为 user 或 toolResult——`continue()` 在末尾是 assistant 时会抛异常。第一次 `agent_end` 不算 Run 结束：内核在其中判定溢出并发起重试，只有重试的 `agent_end`（或判定不重试时）才进入 §5.3 的 Run 结束流程，`run_end` 只触发一次。
- **触发**：估算上下文 token（最近一次 assistant usage + 之后新增内容估算；文本估算按中日韩字符每字 1 token、其余每 4 字符 1 token）> `contextWindow − reserveTokens`（默认 16384）。`contextWindow` 取自 `main` 角色解析出的模型（§9.1）。
- **切点**：从末尾向前累加，直到达到 `keepRecentTokens`（默认 20000）；切点只落在 **Run 边界**。若最后一个 Run 自身就超出（无论它仍在进行还是已经结束），退化为在 Turn 边界切（保证 assistant 的工具调用与其结果不被拆开）。切点由内核计算，扩展只拿到切点之前的条目。
- **摘要**：触发 `before_compact({ entries, previousSummary, tokensBefore, signal })`，按扩展顺序，第一个返回 `{ summary }` 的生效；返回 `{ cancel: true }` 则本次不压缩。
- **无压缩扩展时的兜底**：没有任何扩展处理 `before_compact`（一个都没返回）时，沿用 `previousSummary`，丢弃切点之前的内容，保证不会超出窗口。
- **摘要失败**（扩展出错或超时）：与 pi-coding-agent 相同——本次不压缩、上下文不变，发出 `compaction{error}` 事件，下一个检查点自然会再次触发。溢出恢复只尝试一次压缩加重试，再失败则 Run 以 `error` 结束（走 §5.4）。
- **写入**：追加 `compaction` 条目 → 触发 `compacted({ entries（被压缩掉的条目）, summary })`，内核 await 全部 handler（与扩展顺序无关）→ 调用所有 Section provider（`reason: "rebuild"`）追加一条**全量** `system` 检查点。因此 `compacted` 中更新的内容（如 memory.md）在 rebuild 时立即生效。
- **主动触发**：`sofia.compact(reason?)` 设置一个"待压缩"标记。空闲时立即执行；有 Run 时在该 Run 结束后、下一个 Run 开始前执行。压缩执行期间视同占用"唯一思考流"，调度器等待其完成。主动触发不看阈值，但切点规则相同；`before_compact` 的 `reason` 为 `"manual"`（自动为 `"threshold"` / `"overflow"`）。用途：admin "立即压缩"按钮、夜间空闲时提前压缩等。
- **重建上下文** = 检查点 system → `<summary>` user → `firstKeptSeq` 之后、compaction 条目之前的非 system 条目 → compaction 之后的全部条目；其中 `stopReason` 为 `error` / `aborted` 的 assistant 条目一律剔除。
- **error / aborted 条目**：`stopReason` 为 `error` / `aborted` 的 assistant 条目保留在 Timeline 中，但**不进入重建结果**（工作副本里不存在，token 估算自然不计入）。Run 进行中刚产生、尚在工作副本里的那一条，发送时由 pi-ai 的 `transformMessages` 自动跳过。

### 7.4 启动恢复

1. 找到最近的 `compaction`（没有则从头），按 7.3 规则重建上下文；调用 Section provider（`"rebuild"`）与工具注册表 diff，有变化追加补丁。
2. `runs` 中 `ended_at IS NULL` 的记录标为 `interrupted`，并追加 `notice`：「（你刚才被中断了）」。已写入内容保留，不重放。
3. Queue 只在内存中，**崩溃或重启时排队中的 Signal 会丢失**，这是有意接受的风险（崩溃少见、积压通常很少）。Channel 不做补回。

---

## 8. Extension API

### 8.1 定义扩展

```ts
import { defineExtension } from "@sofia/core"

export default defineExtension({
  name: "telegram",
  configSchema: { /* JSON Schema，内核校验，admin 据此自动生成表单 */ },
  async setup(sofia) { /* 注册；连接等副作用放到 start 事件 */ },
})
```

`name` 是扩展的短名，用作工具前缀、`dataDir` 目录名和事件来源。要求：匹配 `/^[a-z][a-z0-9-]{0,23}$/`，全局唯一。加载时若与已加载扩展同名，视为配置错误：后者不加载，记 `ext_error` 并在 admin 中显示。

### 8.2 SofiaAPI

```ts
interface SofiaAPI<Config = unknown> {
  readonly name: string
  readonly config: Config                    // 已按 configSchema 校验
  readonly home: string                      // 数据目录（SOFIA_HOME），persona.md / memory.md 等共享文件所在
  readonly dataDir: string                   // ~/.sofia/ext/<name>/
  readonly log: Logger                       // 写入事件流
  secret(name: string): string | undefined   // secrets.json 的键或同名环境变量

  on<E extends HookName>(event: E, handler: HookHandler<E>): () => void
  readonly events: { subscribe(fn: (e: SofiaEvent) => void): () => void }  // 只读事件流

  registerChannel(def: ChannelDef): void
  registerTool(tool: AgentTool<any>): { name: string; unregister(): void }   // name 为加前缀后的全名
  registerSection(name: string, provider: SectionProvider): () => void

  signal(input: Omit<Signal, "id" | "at"> & Partial<Pick<Signal, "id" | "at">>): void
  complete(role: string, context: Context, opts?: SimpleStreamOptions): Promise<AssistantMessage>

  readonly timeline: { query(q: { since?: number; until?: number; room?: string; runId?: string;
                                  types?: string[]; limit?: number }): TimelineEntry[] }   // limit 取最近的 N 条，结果仍按时间正序
  currentRun(): { id: string; focusRoom?: RoomRef } | undefined
  abortRun(reason?: string): void           // 中止当前 Run；无 Run 时无操作
  compact(reason?: string): void            // 请求压缩：空闲时立即执行，否则在当前 Run 结束后执行

  readonly host: {                           // 供 admin 等使用的进程内管理接口
    extensions(): ExtensionInfo[]            // 名称、状态、schema、配置
    readConfig(): SofiaConfig
    writeConfig(c: SofiaConfig): void        // 校验后写 config.json
    restart(): void                          // 整体重启（v1 不做单扩展热重载）
  }
}

interface ChannelDef {                                  // Channel id = 扩展名；一个扩展至多注册一个 Channel
  debounceMs?: number                                   // 默认 1500
  maxWaitMs?: number                                    // 防抖最长等待，默认 5000
  deliver(room: RoomRef, text: string): Promise<void>
  onDelta?(room: RoomRef, delta: string): void
  onRunError?(room: RoomRef, error: Error): void
}
```

### 8.3 Hook 清单

按扩展加载顺序执行；"返回值"列为空者仅通知。

| 事件 | 时机 | payload | 返回值 |
|---|---|---|---|
| `start` | daemon 启动、首个 Run 前 | — | — |
| `shutdown` | daemon 退出前 | `{ reason }` | — |
| `signal` | Signal 入 Queue 前 | `Signal` | `Signal`（修改）或 `{ drop: true }`；链式 |
| `run_start` | Run 开始、写入 Signal 前 | `{ run, signals }` | `{ recall?: string[] }`；各扩展结果合并 |
| `context` | 每次 LLM 请求前 | `{ messages }`（副本） | `{ messages }`；链式，**不写入 Timeline** |
| `tool_call` | 工具执行前 | `{ toolName, args, run }` | `{ block?: true; reason? }` |
| `tool_result` | 工具执行后 | `{ toolName, args, result, isError }` | 部分替换 `{ content?, details?, isError? }` |
| `turn_end` | 每个 Turn 结束 | `{ run, message, toolResults }` | — |
| `run_end` | Run 结束 | `{ run, entries, error? }` | — |
| `before_compact` | 压缩触发 | `{ entries, previousSummary, tokensBefore, reason, signal }` | `{ summary }` 或 `{ cancel: true }`；首个生效 |
| `compacted` | compaction 条目写入后、rebuild 前 | `{ entries, summary }` | —（内核 await，全部扩展都收到） |
| `deliver` | 自动投递前 | `{ room, text }` | `{ text }` 或 `{ cancel: true }` |

hook 映射到 pi-agent-core：`context` → `transformContext`；`tool_call`/`tool_result` → `beforeToolCall`/`afterToolCall`；Turn 上限 → `finishTurn`；Turn 间压缩 → `prepareNextTurnWithContext`。

### 8.4 只读事件流

pi-agent-core 的原始事件（`agent_start` `turn_start` `turn_end` `message_start` `message_update` `message_end` `tool_execution_start` `tool_execution_end` …）**原样**进入事件流，内核只在上面补 `at`、`runId`、`turn`（Run 内第几个 Turn）；内核事件（含 `hook`）同样带 `runId` / `turn`；内核自己的事件只描述 pi 不知道的事，两者不重名。订阅者异常不影响主流程。

**hook 与事件的分工**：需要返回值、或内核必须等它完成才能继续的，做成 hook（如 `before_compact`、`compacted`）；只需知道"发生了什么"的，只放事件流（如压缩失败、投递结果、调度决策）。事件流订阅者也可以做异步副作用（如通知主人），只是不能影响主流程。内核事件：

`signal_received` `signal_dropped` `bucket_ready` `run_scheduled{candidates, chosen, reason}` `steered` `run_start` `run_end` `llm_request{model, role, tokens, cost, ms}` `llm_retry{attempt, delayMs, error}` `delivery{ok, error?}` `section_patch` `tools_patch` `compaction{reason, ok, tokensBefore, tokensAfter?, by?, error?}` `hook{ext, event, ms, error?}` `ext_error`

---

## 9. 配置

### 9.1 `config.json`

```json
{
  "providers": {
    "anthropic": { "secret": "ANTHROPIC_API_KEY" },
    "my-proxy":  {
      "api": "openai-completions", "baseUrl": "https://example.com/v1", "secret": "PROXY_KEY",
      "models": [ { "id": "deepseek-chat", "contextWindow": 128000, "maxTokens": 8192 } ]
    }
  },
  "models": {
    "main":  { "provider": "anthropic", "id": "claude-sonnet-4-6", "thinking": "low" },
    "cheap": { "provider": "my-proxy",  "id": "deepseek-chat" }
  },
  "kernel": { "maxTurnsPerRun": null, "compaction": { "reserveTokens": 16384, "keepRecentTokens": 20000 } },
  "extensions": [
    { "use": "@sofia/ext-persona" },
    { "use": "@sofia/ext-memory-md", "config": { "budgetTokens": 1500 } },
    { "use": "@sofia/ext-compaction" },
    { "use": "@sofia/ext-telegram", "config": { "ownerUserId": 123456 } },
    { "use": "@sofia/ext-desktop",  "config": { "port": 47822 } },
    { "use": "@sofia/ext-heartbeat", "config": { "idleHours": 6, "cron": ["0 9 * * *"] } },
    { "use": "@sofia/ext-trace" },
    { "use": "@sofia/ext-admin", "config": { "port": 47820 } },
    { "use": "./my-local-ext.ts", "enabled": false }
  ]
}
```

- **provider**：内置名直接沿用 pi-ai 的定义；自定义项（含 `api`、`baseUrl`）用 pi-ai `createProvider` 注册。`secret` 指向 `secrets.json` 键名或同名环境变量。
- **模型元数据跟模型走，不跟 Model Role 走**：内置 provider 不写 `models`，`contextWindow` / `maxTokens` 用 pi-ai 自带的值；自定义 provider **必须**写 `models`，每项必须有 `id`、`contextWindow`、`maxTokens`（原样传给 `createProvider`，示例中的数字仅为占位）。Model Role 引用了该 provider 下不存在的模型 id 视为配置错误，`sofia check` 报出。
- **models**：Model Role → provider + 模型。主循环用 `main`；扩展用 `sofia.complete(role, …)`；未配置的角色回退到 `main`。
- **extensions**：有序数组，顺序决定 hook 执行顺序与 Section 顺序。`use` 为包名或本地路径（jiti 加载，TS 免编译）。加载失败：记录、跳过，daemon 继续。

### 9.2 `secrets.json`

```json
{ "ANTHROPIC_API_KEY": "…", "TELEGRAM_BOT_TOKEN": "…" }
```

---

## 10. 官方扩展

### 10.1 ext-persona

读取 `~/.sofia/persona.md`，注册 `persona` Section（每次调用读文件，内容不变则无补丁）。隐私约束（"不要在群聊透露主人私聊内容"）写在 persona.md 中。

- 配置 `file`（默认 `persona.md`，相对数据目录）指定人设文件；准备多份人设（如 `personas/a.md`、`personas/b.md`）时改这一项即可切换，重启生效。直接改文件内容则在下一个 Run 生效。
- 切换的只是 `persona` Section：Timeline 与 memory.md 不变（ADR-0001，一个人格一条 Timeline），她仍记得用旧人设说过的话。想要一个全新的人，应换一个数据目录（§2.3）。
- 文件不存在或为空时不注册内容（Section 移除），记一条 warn。

### 10.2 ext-memory-md（ADR-0006）

- 注册 `memory` Section：`"rebuild"` 时读取 `memory.md` 并缓存，`"run"` 时返回缓存——**两次压缩之间 Section 字节不变**，新学到的事实仍以原文存在于近期 Timeline。
- 监听 `compacted`：把当前 memory.md（条目带编号）与**即将离开上下文的条目**交给 `cheap`，要求输出**编辑操作**，每行一条：`ADD: <条目>` / `UPDATE <编号>: <条目>` / `REMOVE <编号>`，无改动输出 `NONE`。未涉及的行（含标题、空行等非条目内容）原样保留；合并重复、修正冲突、删除过时、控制在 `budgetTokens` 内。不整份重写，避免细节被反复转述磨损。认不出的行与不存在的编号直接忽略。
- memory.md 以条目列表组织（每条一行，便于定位编辑）；人可直接手改，下次 rebuild 生效。
- 改写前把旧版本存入 `dataDir/history/<timestamp>.md`。
- 配置：`budgetTokens`（默认 1500）、`role`（默认 `cheap`）、`file`（默认 `memory.md`）。
- 不使用 Recall；Recall 机制留给将来的检索式记忆扩展（替换或补充）。

### 10.3 ext-compaction

参考 pi 的 compaction：独立请求（`cheap` 角色，可配置），系统提示为"上下文摘要助手"，带入 `previousSummary` 迭代更新，输出纯文本"交接简报"：

1. 近期发生的事（按 Room）
2. 进行中的话题与未完成的约定
3. 主人当前的状态与情绪
4. 各 Room 关键人物近况

摘要提示词可通过配置 `prompt` 或 `promptFile`（相对数据目录）覆盖；`role` 可改用其他 Model Role。请求失败或返回空文本时抛异常，即 §7.3 的"摘要失败"：本次不压缩。条目经内核导出的 `renderEntries` 转写成文本（ext-memory-md 同）。

### 10.4 ext-telegram

- 长轮询接收 update；Room：`telegram:direct:<chatId>`（direct）、`telegram:group:<chatId>`（group）。
- `isOwner = from.id === config.ownerUserId`；Owner 私聊 `high`，其余 `normal`；所有消息都产生 Signal（由模型决定是否回复）；`debounceMs` 1500。
- 规范化：图片 → image block；贴纸 → `[贴纸 😂]`；回复 → notes「回复了 X："…"」；@ 她 → notes「@了你」。
- 工具 `send(room, text, replyToMessageId?)`（模型看到 `telegram_send`）；Section `channel:telegram` 列出主人私聊 Room 与已知群。
- `onRunError`：在该 Room 发一句简短提示。
- 主人发送 `/stop` → `sofia.abortRun()`，该消息不产生 Signal。
- 直接用 Bot API（`fetch`），无第三方依赖。token 经 `sofia.secret("TELEGRAM_BOT_TOKEN")` 读取（密钥名可用 `tokenSecret` 改），缺失则扩展不加载。配置：`ownerUserId`（必填）、`debounceMs`、`images`（默认下载图片）、`apiBase`、`pollTimeoutSec`。
- 每条 Signal 的 notes 末尾带「消息 ID N」，供 `send` 的 `replyToMessageId` 引用。语音、视频、文件等其他类型转成「[语音]」之类的文字说明；入群等服务消息不产生 Signal。
- 已见过的 Room 记在 `dataDir/rooms.json`，Section 据此列出。发送遇网络错误、429、5xx 时退避重试（至多 4 次），超过 4096 字的文本分条发送。
- daemon 停机期间发来的消息，Telegram 会保留约 24 小时并在下次启动时送达，届时照常处理。

### 10.5 ext-desktop 与 apps/desktop

协议（本地 WebSocket，JSON）：

| 方向 | 消息 |
|---|---|
| client → daemon | `hello { expressions: string[]; motions: string[] }`、`say { text; images? }`、`stop {}` |
| daemon → client | `reply_delta { text }`、`reply_end { text }`、`expression { name }`、`motion { name }`、`error { message }` |

- Room 唯一：`desktop:direct:main`（direct），sender 恒为 Owner，`high`，`debounceMs: 0`。
- 客户端 `hello` 后注册工具 `expression(name)`、`motion(name)`（模型看到 `desktop_expression`、`desktop_motion`）与 `channel:desktop` Section（列出可用名称）；断开时注销。变化在下一个 Run 开始生效。
- 未连接时投递丢弃（记事件）。`onRunError` → 发 `error`。
- 协议的完整说明（含客户端必须处理的边界情况）与形象层接缝见 [`apps/desktop/README.md`](../apps/desktop/README.md)，以它为准。
- 可同时连接多个客户端，消息广播给全部；表情/动作以最近一次 `hello` 为准。
- 只监听 `127.0.0.1`。带 `http(s)://` Origin 的连接（普通网页）默认拒绝，防止任意网页冒充主人说话；开发服务器的来源加入 `allowedOrigins`。
- `apps/desktop` 现为基础版：聊天（流式、图片、打断）+ 颜文字占位形象，无构建步骤。Live2D 通过替换 `renderer/avatar.js` 接入。

### 10.6 ext-heartbeat

按 `cron` 与"距上次 Owner Signal 超过 `idleHours`"产生 internal Signal（`low`）。**目标 Room 默认为主人最近活跃的私聊 Room**：用 `sofia.timeline.query({ types: ["signal"], limit })` 取最近若干条，从新到旧找第一条 `sender.isOwner && room.kind === "direct"` 的 Signal，取其 `RoomRef`（不涉及内核改动）；找不到或配置 `target: "none"` 时无目标。提示语：

> 现在是 {时间}，你已经 {N} 小时没和主人说话了。可以考虑主动问候；如果不想打扰，只回复 `[[NO_REPLY]]`。

每分钟整点检查一次。空闲提醒在触发后，每隔 `idleHours` 再提醒一次，主人说话即重新计时（状态从 Timeline 恢复，重启不丢）；距主人上次说话不足 1 小时时省略"已经 N 小时"那半句。cron 为 5 段表达式、本地时区，非法的表达式记 warn 后忽略。

有目标 Room 时，该 Room 即 Focus Room，回复自动投递；无目标时不自动投递，她若要说话就用 `telegram_send` / desktop 工具。

### 10.7 ext-trace

订阅只读事件流，写入 `trace.db`：

```sql
CREATE TABLE events (seq INTEGER PRIMARY KEY, at INTEGER, kind TEXT, run_id TEXT, turn INTEGER,
                     room TEXT, ext TEXT, ms INTEGER, data TEXT);
```

默认只记元信息（角色、模型、用量、字数、工具名等），不记消息与工具的内容（配置 `recordPayloads: true` 开启；图片数据始终不记）。流式增量（`message_update`、`tool_execution_update`）不记。写入失败只打日志。

### 10.8 ext-admin 与 apps/admin-web

- 监听 `127.0.0.1:<port>`，提供 HTTP + WebSocket，托管 admin-web 静态文件。
- 接口：扩展列表与状态（`host.extensions()`）、读写配置（按各扩展 `configSchema` 自动生成表单）、重启、停止当前 Run、立即压缩、事件流实时推送、Trace 查询、Timeline 浏览。
- **泳道图**：按时间轴绘制 Queue/调度、Run/Turn、LLM 请求、工具、扩展 hook、Delivery 六条泳道，数据来自 trace.db。
- 配置修改后整体重启生效：`sofia start` 为监督进程，子进程以约定退出码退出时自动重新拉起。
- 接口清单见 [`apps/admin-web/README.md`](../apps/admin-web/README.md)。`apps/admin-web` 是纯静态文件（无框架、无构建），由 ext-admin 直接托管。
- 只接受 `Host` 为本机地址、且 `Origin`（若有）为管理页自身的请求，挡住其他网页的跨站请求与 DNS 重绑定。响应里不含密钥与图片数据。

---

## 11. CLI（低优先级）

- `sofia start [--terminal] [--no-supervise]`：前台运行 daemon（含监督重启）。`--terminal` 追加一个开发用的终端 Channel（`packages/daemon/src/terminal.ts`，不在官方扩展之列）：直接输入即对她说话，`/room <名字> [group]` 切换 Room，`/as <名字>` / `/me` 切换发言身份，`/stop`、`/compact`、`/quit`。
- `sofia export [--since <date>]`：Timeline 导出 JSONL。
- `sofia check`：校验配置与各扩展 schema（含自定义 provider 的模型定义与 Model Role 引用）。

开机自启（launchd）见 [`docs/launchd.md`](./launchd.md)。

---

## 12. 测试策略

- 内核：pi-ai faux provider（脚本化模型回复）+ 测试用假 Channel。必测场景：
  - 同 Room 防抖合并；跨 Room 排队；优先级与同级先到先得
  - 同 Room steer 在 Turn 结束注入；Run 结束残留 steer 回队
  - Silence Token 各写法；无 Focus Room 不投递；Delivery 不阻塞 Loop；同 Room 投递保序；流式扣留 Silence Token 前缀
  - 每个 Run 从 Timeline 重建上下文；error/aborted assistant 不进上下文；溢出→压缩→continue 重试（重建结果不以 assistant 结尾、`run_end` 只触发一次）
  - 防抖最长等待；Turn 上限触顶 notice；重试只在首个内容事件前；
  - hook 超时；单实例锁；abortRun → aborted 状态、notice、残留 steer 丢弃
  - Run 失败：Notice 写入、`onRunError` 调用、Signal 不重放
  - Compaction：切点落在 Run 边界、`before_compact` 优先级与兜底、`compacted` 在 rebuild 前完成、摘要失败时上下文不变、`sofia.compact()` 空闲/运行中两种时机、重建上下文正确
  - 重启恢复：interrupted Notice、Section/工具 diff
  - Section 不变时不产生补丁；工具变更只在 Run 边界生效
- 各扩展自带单测；不做 Telegram / Electron 端到端自动化。

---

## 13. 实施顺序

1. `core` + 假 Channel + `daemon`：终端里跑通单人格多 Room。
2. `ext-persona`、`ext-compaction`、`ext-memory-md`。
3. `ext-telegram`。
4. `ext-trace`、`ext-heartbeat`。
5. `ext-desktop` + `apps/desktop`（Live2D）。
6. `ext-admin` + `apps/admin-web`（配置表单、泳道图）。

---

## 14. v1 明确不做

- 多 Agent / 并行 Run / 抢占
- 跨 Channel 合并 Contact 身份
- `ownerOnly` 工具权限与私聊内容过滤（隐私靠 persona 提示词）
- 可插拔存储；Queue 持久化
- 单扩展热重载
- 自定义 Signal 渲染器 hook
- 向量/全文检索记忆（留给替换扩展，使用 Recall 机制）
- Timeline 分支（树状会话）
- 图片存文件引用、旧图片降级为文字（图片以 base64 直接存在条目中并随上下文重发，费用暂不考虑）
- 记忆更新失败后的补做（`compacted` 失败只记事件）
- 正文防伪造（只去除 sender.name 换行）
