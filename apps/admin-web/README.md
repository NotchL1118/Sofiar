# admin-web

Sofia 的管理页前端。纯静态（`index.html` + `app.js` + `style.css`），没有构建步骤、没有框架，由 `ext-admin` 托管在 `http://127.0.0.1:47820/`。

改这里的文件后刷新浏览器即可；后端在 `packages/ext-admin/src/index.ts`。

## 接口（ext-admin 提供）

| 方法 路径 | 作用 |
|---|---|
| `GET /api/status` | `{ run: {id, focusRoom?} \| null, extensions: [{name, status}] }` |
| `GET /api/extensions` | `ExtensionInfo[]`：名称、状态、错误、`configSchema`、当前配置 |
| `GET /api/config` / `PUT /api/config` | 读 / 校验后写 `config.json`（不含密钥）；校验失败返回 400 `{error}` |
| `POST /api/restart` | 整体重启 daemon |
| `POST /api/stop` | 中止当前 Run |
| `POST /api/compact` | 请求立即压缩 |
| `GET /api/timeline?limit&room&runId&types&since&until` | 最近的 Timeline 条目（正序）；`types` 逗号分隔 |
| `GET /api/trace?limit&runId&kinds&since&until` | trace.db 的事件行（正序）；`data` 已解析为对象 |
| `WS /api/events` | 实时事件流：每帧一个 `SofiaEvent`（不含流式增量） |

图片的 base64 在所有响应里都被替换为 `{ type: "image", data: "", omitted: <长度> }`。

只接受 `Host` 为 `127.0.0.1:<port>` / `localhost:<port>`、且 `Origin`（若有）与之相同的请求。

## 约定

- 来自 Timeline 和事件的内容一律用 `textContent` 写入页面，不拼 HTML。
- 颜色用 `style.css` 顶部的 CSS 变量，明暗两套都要定义。

## 还可以做的

- 扩展表单目前只支持扁平的 `string / number / boolean / enum / string[]` 属性；嵌套对象要在 JSON 编辑框里改。
- 不能在页面上新增或删除扩展条目、调整顺序（改 JSON）。
- 泳道图没有缩放与拖动；Turn 只画了结束点。
- Timeline 没有分页，只取最近 N 条。
