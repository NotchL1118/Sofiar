// Sofia 桌面客户端：瘦客户端，只做协议收发与显示。协议见 ../README.md。
const $ = (id) => document.getElementById(id)
const url = new URLSearchParams(location.search).get("url") || "ws://127.0.0.1:47822"
const avatar = window.SofiaAvatar
const log = $("log")
let ws
let streaming // 正在流式输出的气泡
let pendingImages = []

function bubble(cls, text) {
  const el = document.createElement("div")
  el.className = `msg ${cls}`
  el.textContent = text
  log.append(el)
  log.scrollTop = log.scrollHeight
  return el
}
function endStream(finalText) {
  avatar.setSpeaking(false)
  if (streaming && finalText === undefined) streaming.remove() // 被打断或出错：丢掉半截话（她不会记得说过）
  else if (streaming) {
    streaming.textContent = finalText
    streaming.classList.remove("streaming")
  } else if (finalText !== undefined) bubble("her", finalText)
  streaming = undefined
  log.scrollTop = log.scrollHeight
}

const handlers = {
  reply_delta({ text }) {
    if (!streaming) {
      streaming = bubble("her streaming", "")
      avatar.setSpeaking(true)
    }
    streaming.textContent += text
    log.scrollTop = log.scrollHeight
  },
  reply_end({ text }) {
    endStream(text)
  },
  expression({ name }) {
    avatar.setExpression(name)
  },
  motion({ name }) {
    avatar.playMotion(name)
  },
  error({ message }) {
    endStream()
    bubble("note err", `出错了：${message}`)
  },
}

function setConnected(on) {
  $("status").classList.toggle("on", on)
  $("status").title = on ? `已连接 ${url}` : "未连接（daemon 没在运行，或没启用 ext-desktop）"
  $("send").disabled = !on
  $("stop").disabled = !on
}

function connect() {
  ws = new WebSocket(url)
  ws.onopen = () => {
    setConnected(true)
    ws.send(JSON.stringify({ type: "hello", expressions: avatar.expressions, motions: avatar.motions }))
    console.log("connected", url)
  }
  ws.onmessage = (event) => {
    let message
    try {
      message = JSON.parse(event.data)
    } catch {
      return
    }
    const handler = handlers[message.type]
    if (handler) handler(message)
  }
  ws.onclose = () => {
    setConnected(false)
    endStream()
    setTimeout(connect, 2000)
  }
  ws.onerror = () => {}
}

function send() {
  const text = $("input").value.trim()
  if ((!text && pendingImages.length === 0) || ws.readyState !== WebSocket.OPEN) return
  ws.send(JSON.stringify({ type: "say", text, ...(pendingImages.length ? { images: pendingImages.map(({ data, mimeType }) => ({ data, mimeType })) } : {}) }))
  bubble("me", [text, pendingImages.length ? `[图片 ×${pendingImages.length}]` : ""].filter(Boolean).join(" "))
  $("input").value = ""
  $("input").style.height = ""
  pendingImages = []
  renderAttachments()
}

function renderAttachments() {
  $("attachments").replaceChildren(
    ...pendingImages.map((image, i) => {
      const img = document.createElement("img")
      img.src = image.preview
      img.title = "点击移除"
      img.onclick = () => {
        pendingImages.splice(i, 1)
        renderAttachments()
      }
      return img
    }),
  )
}

$("form").addEventListener("submit", (e) => {
  e.preventDefault()
  send()
})
$("input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault()
    send()
  }
})
$("input").addEventListener("input", () => {
  $("input").style.height = "auto"
  $("input").style.height = `${Math.min($("input").scrollHeight, 120)}px`
})
$("input").addEventListener("paste", (e) => {
  for (const item of e.clipboardData?.items ?? []) {
    if (!item.type.startsWith("image/")) continue
    const file = item.getAsFile()
    if (!file) continue
    e.preventDefault()
    const reader = new FileReader()
    reader.onload = () => {
      const preview = String(reader.result)
      pendingImages.push({ preview, mimeType: file.type, data: preview.slice(preview.indexOf(",") + 1) })
      renderAttachments()
    }
    reader.readAsDataURL(file)
  }
})
$("stop").addEventListener("click", () => {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "stop" }))
  endStream()
})

Promise.resolve(avatar.mount($("avatar"))).then(() => {
  setConnected(false)
  connect()
})
