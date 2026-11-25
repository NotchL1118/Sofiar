# apps/desktop

Sofia 的桌面客户端：Electron 瘦客户端，经本地 WebSocket 连接 daemon 里的 `ext-desktop`。客户端不含任何 Agent 逻辑，关掉它不影响 daemon。

```
pnpm --filter @sofia/desktop start          # 需要 daemon 在运行且启用了 @sofia/ext-desktop
SOFIA_DESKTOP_URL=ws://127.0.0.1:47999 pnpm --filter @sofia/desktop start   # 连别的端口
```

现状：能聊天（流式显示、粘贴图片、打断），形象是颜文字占位。**Live2D 尚未接入**。

## 结构

| 文件 | 职责 |
|---|---|
| `main.cjs` | 主进程，只开窗口。无 preload、无 IPC |
| `renderer/app.js` | 协议收发、聊天气泡、输入框 |
| `renderer/avatar.js` | **形象层的接缝**：`window.SofiaAvatar`，接口写在文件头部 |
| `packages/ext-desktop/src/index.ts` | 服务端（daemon 内） |

无构建步骤、无框架：改完文件重启客户端即可。

## 协议

`ws://127.0.0.1:47822`（端口为 ext-desktop 的 `port` 配置），每帧一个 JSON 对象，按 `type` 区分。

客户端 → daemon

| type | 字段 | 含义 |
|---|---|---|
| `hello` | `expressions: string[]`, `motions: string[]` | 连接后发送一次。上报形象支持的表情与动作名；daemon 据此注册 `desktop_expression` / `desktop_motion` 工具与 `channel:desktop` Section，**在下一个 Run 生效**。可重发以更新 |
| `say` | `text?: string`, `images?: { data: base64, mimeType }[]` | 主人说话。成为 Room `desktop:direct:main` 的一条 Signal（sender 恒为主人、`high` 优先级、不防抖） |
| `stop` | — | 中止当前 Run |

daemon → 客户端

| type | 字段 | 含义 |
|---|---|---|
| `reply_delta` | `text` | 回复的流式增量，累加显示 |
| `reply_end` | `text` | 这条回复的完整文本，**以它为准**替换已累加的内容 |
| `expression` | `name` | 她调用了 `desktop_expression` |
| `motion` | `name` | 她调用了 `desktop_motion` |
| `error` | `message` | 这个 Run 失败了；或客户端发了无法识别的帧 |

客户端必须处理的情况：

- **有 `reply_delta` 但没有 `reply_end`**：Run 被打断或中途出错。那半截话不进入她的上下文，客户端应丢弃（`app.js` 的 `endStream()`）。
- **没有任何 `reply_delta` 也没有 `reply_end`**：她选择不说话（Silence Token）。
- **一个 Run 里多条回复**：她调用工具前后各说一句时，会有多组 `reply_delta…reply_end`。
- **断线**：自动重连并重发 `hello`。断开期间的回复不补发。
- 多个客户端可同时连接，都会收到广播；表情/动作以最近一次 `hello` 为准，全部断开后工具注销。

只监听 `127.0.0.1`。默认接受 Electron 的 `file://` 来源和省略 Origin 的本地客户端。网页开发服务器需将完整的 HTTP(S) 来源加入 ext-desktop 的 `allowedOrigins`。来源为 `null` 的页面会被拒绝。

## 接入 Live2D（下一步）

只需替换 `renderer/avatar.js`，保持 `window.SofiaAvatar` 接口不变：

1. 在 `mount(el)` 里加载模型（如 pixi-live2d-display + Cubism Core；`mount` 可以返回 Promise）。
2. 用模型自带的表情名、动作组名填充 `expressions` / `motions`——它们会原样成为模型可选的工具参数，名字要让人看得懂（`smile` 好过 `exp_03`）。
3. `setSpeaking(on)` 驱动口型；想要精确口型同步需要 TTS，协议里目前没有音频。
4. 放宽 `index.html` 的 CSP（WebGL、模型文件），模型素材放在 `renderer/` 下。

其他未做：透明无边框的桌宠窗口与拖动、托盘图标、开机自启、打包分发（electron-builder）、历史消息（客户端重开后是空的；需要的话给 ext-desktop 加一个从 Timeline 取最近消息的帧）。
