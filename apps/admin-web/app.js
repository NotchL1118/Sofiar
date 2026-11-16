// Sofia 管理页：纯静态、无构建。所有来自 Timeline / 事件的内容只经 textContent 写入页面。
const $ = (id) => document.getElementById(id)
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") el.className = v
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v)
    else if (v === true) el.setAttribute(k, "")
    else if (v !== false && v != null) el.setAttribute(k, v)
  }
  for (const c of children.flat()) if (c != null) el.append(c)
  return el
}
async function api(method, path, body) {
  const res = await fetch(path, { method, headers: body === undefined ? {} : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || `${res.status}`)
  return data
}
const pad = (n) => String(n).padStart(2, "0")
const clock = (at) => { const d = new Date(at); return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` }
const stamp = (at) => { const d = new Date(at); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${clock(at)}` }

// ───────── 标签页 ─────────
const loaders = { overview: loadStatus, extensions: loadExtensions, timeline: loadTimeline, lanes: loadRanges }
for (const btn of document.querySelectorAll("#tabs button")) {
  btn.addEventListener("click", () => {
    for (const b of document.querySelectorAll("#tabs button")) b.classList.toggle("active", b === btn)
    for (const s of document.querySelectorAll("main > section")) s.hidden = s.id !== btn.dataset.tab
    loaders[btn.dataset.tab]()
  })
}

// ───────── 概览 ─────────
async function loadStatus() {
  try {
    const s = await api("GET", "/api/status")
    $("status").replaceChildren(
      h("div", {}, "当前 Run：", s.run ? h("b", {}, `${s.run.focusRoom ? s.run.focusRoom.label : "（无 Focus Room）"}  `) : "空闲", s.run ? h("span", { class: "muted" }, s.run.id) : null),
      h("div", { class: "bar" }, s.extensions.map((e) => h("span", { class: `pill ${e.status === "loaded" ? "ok" : e.status === "error" ? "err" : ""}` }, e.name))),
    )
  } catch (e) { $("status").textContent = `读取状态失败：${e.message}` }
}
const act = (id, path, confirmText) => $(id).addEventListener("click", async () => {
  if (confirmText && !confirm(confirmText)) return
  try { await api("POST", path); setTimeout(loadStatus, 300) } catch (e) { alert(e.message) }
})
act("act-stop", "/api/stop")
act("act-compact", "/api/compact")
act("act-restart", "/api/restart", "重启 daemon？当前 Run 会被中断。")

function describeEvent(e) {
  switch (e.type) {
    case "signal_received": case "steered": case "signal_dropped": {
      const s = e.signal.source
      return s.kind === "room" ? `${s.room.label} ← ${s.sender.name}` : `internal ← ${s.from}`
    }
    case "run_scheduled": return `${e.chosen}（${e.reason}）`
    case "run_start": return `${e.run.focusRoom ? e.run.focusRoom.label : "无 Focus Room"}，${e.signals} 条 Signal`
    case "run_end": return `${e.status}${e.error ? `：${e.error}` : ""}`
    case "llm_request": return `${e.role} ${e.model} · ${e.tokens} tok · ${e.ms ?? "?"}ms · ${e.stopReason}`
    case "llm_retry": return `第 ${e.attempt} 次重试：${e.error}`
    case "tool_execution_start": return e.toolName
    case "tool_execution_end": return `${e.toolName} ${e.isError ? "失败" : "完成"} ${e.durationMs ?? ""}ms`
    case "delivery": return `${e.room} ${e.ok ? "已投递" : `失败：${e.error}`}`
    case "hook": return `${e.ext}.${e.event} ${e.ms}ms${e.error ? ` ✗ ${e.error}` : ""}`
    case "compaction": return `${e.reason} ${e.ok ? `完成 ${e.tokensBefore}→${e.tokensAfter}` : `未执行：${e.error}`}`
    case "ext_error": return `${e.ext}：${e.error}`
    case "log": return `[${e.ext}] ${e.message}`
    case "section_patch": return e.sections.join(", ")
    case "tools_patch": return `+${e.added.join(",") || "-"} −${e.removed.join(",") || "-"}`
    case "bucket_ready": return e.bucket
    case "message_end": return e.message.role
    default: return ""
  }
}
const isError = (e) => e.type === "ext_error" || e.error || (e.type === "delivery" && !e.ok) || (e.type === "log" && e.level === "error") || (e.type === "run_end" && e.status !== "ok")
function pushEvent(e) {
  const box = $("events")
  const atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 30
  box.append(h("div", { class: isError(e) ? "e" : "" }, h("span", { class: "t" }, `${clock(e.at)} `), h("span", { class: "k" }, e.type.padEnd(22)), describeEvent(e)))
  while (box.childElementCount > 800) box.firstChild.remove()
  if (atBottom) box.scrollTop = box.scrollHeight
  if (e.type === "run_start" || e.type === "run_end") loadStatus()
}
function connect() {
  const ws = new WebSocket(`ws://${location.host}/api/events`)
  const set = (text, cls) => { $("conn").textContent = text; $("conn").className = `pill ${cls}` }
  ws.onopen = () => { set("已连接", "ok"); loadStatus() }
  ws.onmessage = (m) => { try { pushEvent(JSON.parse(m.data)) } catch {} }
  ws.onclose = () => { set("已断开，重连中…", "warn"); setTimeout(connect, 1500) }
}

// ───────── 扩展与配置 ─────────
let config = null
function fieldFor(key, schema, value, onChange) {
  const type = schema.type
  let input
  if (Array.isArray(schema.enum)) {
    input = h("select", {}, h("option", { value: "" }, "（默认）"), schema.enum.map((v) => h("option", { value: v }, v)))
    input.value = value ?? ""
    input.onchange = () => onChange(input.value === "" ? undefined : input.value)
  } else if (type === "boolean") {
    input = h("input", { type: "checkbox" })
    input.checked = value === true
    input.onchange = () => onChange(input.checked)
  } else if (type === "number" || type === "integer") {
    input = h("input", { type: "number" })
    input.value = value ?? ""
    input.oninput = () => onChange(input.value === "" ? undefined : Number(input.value))
  } else if (type === "array") {
    input = h("textarea", { rows: 3, placeholder: "每行一项" })
    input.value = Array.isArray(value) ? value.join("\n") : ""
    input.oninput = () => { const items = input.value.split("\n").map((s) => s.trim()).filter(Boolean); onChange(items.length ? items : undefined) }
  } else {
    input = h("input", { type: "text" })
    input.value = value ?? ""
    input.oninput = () => onChange(input.value === "" ? undefined : input.value)
  }
  return h("div", { class: "field" }, h("label", {}, key), input, schema.description ? h("small", {}, schema.description) : null)
}
function syncRaw() { $("raw-config").value = JSON.stringify(config, null, 2) }
async function loadExtensions() {
  let infos
  try { [config, infos] = await Promise.all([api("GET", "/api/config"), api("GET", "/api/extensions")]) }
  catch (e) { $("ext-list").textContent = `读取失败：${e.message}`; return }
  config.extensions ??= []
  syncRaw()
  const cards = config.extensions.map((entry) => {
    const info = infos.find((i) => i.use === entry.use)
    const status = entry.enabled === false ? "disabled" : info ? info.status : "未加载"
    const enabled = h("input", { type: "checkbox" })
    enabled.checked = entry.enabled !== false
    enabled.onchange = () => { if (enabled.checked) delete entry.enabled; else entry.enabled = false; syncRaw() }
    const set = (key, v) => {
      entry.config ??= {}
      if (v === undefined) delete entry.config[key]; else entry.config[key] = v
      if (Object.keys(entry.config).length === 0) delete entry.config
      syncRaw()
    }
    const props = info && info.configSchema && info.configSchema.properties
    return h("div", { class: "card ext" },
      h("h3", {}, info && info.status !== "disabled" ? info.name : entry.use, h("span", { class: `pill ${status === "loaded" ? "ok" : status === "error" ? "err" : ""}` }, status),
        h("span", { class: "muted" }, entry.use), h("label", { class: "muted" }, enabled, " 启用")),
      info && info.error ? h("div", { class: "hint", style: "color:var(--err)" }, info.error) : null,
      props ? Object.entries(props).map(([key, schema]) => fieldFor(key, schema, entry.config && entry.config[key], (v) => set(key, v)))
        : h("div", { class: "hint" }, entry.config ? `配置：${JSON.stringify(entry.config)}（无 schema，请在下方 JSON 中修改）` : "没有可配置项"),
    )
  })
  $("ext-list").replaceChildren(...cards)
}
$("raw-config").addEventListener("change", () => { try { config = JSON.parse($("raw-config").value); $("save-msg").textContent = "" } catch (e) { $("save-msg").textContent = `JSON 有误：${e.message}` } })
$("save-config").addEventListener("click", async () => {
  try {
    config = JSON.parse($("raw-config").value)
    await api("PUT", "/api/config", config)
    $("save-msg").textContent = "已保存。重启 daemon 后生效（概览页）。"
  } catch (e) { $("save-msg").textContent = `保存失败：${e.message}` }
})

// ───────── Timeline ─────────
const blocksText = (content) => typeof content === "string" ? content : (content || []).map((b) => b.type === "text" ? b.text : b.type === "image" ? "[图片]" : b.type === "toolCall" ? `→ ${b.name}(${JSON.stringify(b.arguments)})` : "").filter(Boolean).join("\n")
function entryText(e) {
  const d = e.data || {}
  switch (e.type) {
    case "signal": { const s = d.source; return `${s.kind === "room" ? `${s.sender.name}${s.sender.isOwner ? "（主人）" : ""}` : `internal:${s.from}`}：${blocksText(d.content)}${(d.notes || []).map((n) => `\n  （${n}）`).join("")}` }
    case "assistant": return blocksText(d.content) || (d.errorMessage ? `✗ ${d.errorMessage}` : "（空）")
    case "toolResult": return `${d.toolName}${d.isError ? " ✗" : ""}：${blocksText(d.content)}`
    case "notice": return d.text
    case "recall": return (d.items || []).map((i) => `- ${i}`).join("\n")
    case "compaction": return `摘要（压缩前 ${d.tokensBefore} tok）：\n${d.summary}`
    case "system": return [d.sections ? `sections: ${Object.keys(d.sections).join(", ")}` : "", d.toolsAdded ? `+tools: ${d.toolsAdded.map((t) => t.name).join(", ")}` : "", d.toolsRemoved ? `-tools: ${d.toolsRemoved.map((t) => t.name).join(", ")}` : ""].filter(Boolean).join("\n")
    default: return JSON.stringify(d)
  }
}
async function loadTimeline() {
  const q = new URLSearchParams({ limit: $("tl-limit").value || "100" })
  if ($("tl-room").value.trim()) q.set("room", $("tl-room").value.trim())
  if ($("tl-types").value.trim()) q.set("types", $("tl-types").value.replace(/\s/g, ""))
  try {
    const entries = await api("GET", `/api/timeline?${q}`)
    $("tl-list").replaceChildren(...(entries.length ? entries.map((e) => {
      const failed = e.type === "assistant" && (e.data.stopReason === "error" || e.data.stopReason === "aborted")
      return h("div", { class: `entry ${e.type}${failed ? " failed" : ""}` },
        h("div", { class: "meta" }, `#${e.seq} · ${stamp(e.at)} · ${e.type}${e.room ? ` · ${e.room}` : ""}${failed ? ` · ${e.data.stopReason}` : ""}`),
        h("pre", {}, entryText(e)))
    }) : [h("p", { class: "hint" }, "没有条目")]))
  } catch (e) { $("tl-list").textContent = `读取失败：${e.message}` }
}
$("tl-load").addEventListener("click", loadTimeline)

// ───────── 泳道图 ─────────
const LANES = [
  { name: "Queue / 调度", color: "--lane1", kinds: ["signal_received", "signal_dropped", "bucket_ready", "run_scheduled", "steered"] },
  { name: "Run / Turn", color: "--lane2", kinds: ["run_end", "turn_end", "compaction"] },
  { name: "LLM 请求", color: "--lane3", kinds: ["llm_request", "llm_retry"] },
  { name: "工具", color: "--lane4", kinds: ["tool_execution_end"] },
  { name: "扩展 hook", color: "--lane5", kinds: ["hook", "ext_error"] },
  { name: "Delivery", color: "--lane6", kinds: ["delivery"] },
]
async function loadRanges() {
  const select = $("lane-range")
  const keep = select.value
  let runs = []
  try { runs = await api("GET", "/api/trace?kinds=run_start,run_end&limit=120") } catch {}
  const ends = new Map(runs.filter((r) => r.kind === "run_end").map((r) => [r.run_id, r]))
  const options = [h("option", { value: "recent:10" }, "最近 10 分钟"), h("option", { value: "recent:60" }, "最近 1 小时")]
  for (const start of runs.filter((r) => r.kind === "run_start").reverse()) {
    const end = ends.get(start.run_id)
    options.push(h("option", { value: `span:${start.at - 3000}:${(end ? end.at : Date.now()) + 1500}` }, `Run ${stamp(start.at)} · ${start.room || "internal"}${end ? ` · ${end.data.status}` : " · 进行中"}`))
  }
  select.replaceChildren(...options)
  if ([...select.options].some((o) => o.value === keep)) select.value = keep
  loadLanes()
}
async function loadLanes() {
  const [mode, a, b] = $("lane-range").value.split(":")
  const until = mode === "span" ? Number(b) : Date.now()
  const since = mode === "span" ? Number(a) : until - Number(a) * 60000
  let rows
  try { rows = await api("GET", `/api/trace?since=${since}&until=${until}&limit=20000`) } catch (e) { $("lane-chart").textContent = `读取失败：${e.message}`; return }
  const NS = "http://www.w3.org/2000/svg"
  const s = (tag, attrs, text) => { const el = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v); if (text != null) el.textContent = text; return el }
  const left = 110, laneH = 34, top = 22
  const width = Math.max($("lane-chart").clientWidth - 20, 700)
  const x = (at) => left + ((at - since) / (until - since)) * (width - left - 10)
  const svg = s("svg", { width, height: top + LANES.length * laneH + 6 })
  for (let i = 0; i <= 6; i++) {
    const at = since + ((until - since) * i) / 6
    svg.append(s("line", { x1: x(at), x2: x(at), y1: top - 4, y2: top + LANES.length * laneH, stroke: "var(--line)" }), s("text", { x: x(at), y: 12, "text-anchor": i === 0 ? "start" : i === 6 ? "end" : "middle" }, clock(at)))
  }
  LANES.forEach((lane, i) => {
    const y = top + i * laneH
    svg.append(s("text", { x: 4, y: y + laneH / 2 + 4 }, lane.name), s("line", { x1: left, x2: width - 10, y1: y + laneH, y2: y + laneH, stroke: "var(--line)" }))
    for (const r of rows.filter((r) => lane.kinds.includes(r.kind))) {
      const d = r.data || {}
      const bad = d.error || d.isError || d.ok === false || r.kind === "ext_error" || (r.kind === "run_end" && d.status !== "ok")
      const color = bad ? "var(--err)" : `var(${lane.color})`
      const sub = r.kind === "turn_end" ? 14 : 0 // Turn 画在 Run 条的下半部
      const label = `${r.kind}${r.ext ? ` · ${r.ext}` : ""}${r.turn ? ` · turn ${r.turn}` : ""}${r.ms != null ? ` · ${r.ms}ms` : ""}\n${clock(r.at)}\n${JSON.stringify(d)}`
      let mark
      if (r.ms != null && r.kind !== "turn_end") {
        const x1 = Math.max(x(r.at - r.ms), left)
        mark = s("rect", { x: x1, y: y + 6, width: Math.max(x(r.at) - x1, 2), height: r.kind === "run_end" ? 10 : laneH - 14, rx: 2, fill: color, opacity: r.kind === "run_end" ? 0.45 : 0.8 })
      } else {
        mark = s("circle", { cx: x(r.at), cy: y + 11 + sub, r: 4, fill: color })
      }
      mark.append(s("title", {}, label))
      svg.append(mark)
    }
  })
  $("lane-chart").replaceChildren(rows.length ? svg : h("p", { class: "hint" }, "这个时间范围内没有 Trace 记录（是否启用了 ext-trace？）"))
}
$("lane-load").addEventListener("click", loadRanges)
$("lane-range").addEventListener("change", loadLanes)

connect()
loadStatus()
