// Sofia 桌面客户端的主进程：只负责开窗口。全部逻辑在 renderer/，经 WebSocket 连接 ext-desktop。
// 关掉客户端不影响 daemon。
const { app, BrowserWindow, shell } = require("electron")
const path = require("node:path")

const url = process.env.SOFIA_DESKTOP_URL || "ws://127.0.0.1:47822"
const smoke = process.env.SOFIA_DESKTOP_SMOKE === "1" // 冒烟测试：不显示窗口，把页面日志打到 stdout，几秒后退出

function createWindow() {
  const win = new BrowserWindow({
    width: 380,
    height: 600,
    minWidth: 300,
    minHeight: 420,
    show: !smoke,
    title: "Sofia",
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  })
  win.setMenuBarVisibility(false)
  // 回复里的链接用系统浏览器打开，不在窗口里跳转
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:\/\//.test(target)) void shell.openExternal(target)
    return { action: "deny" }
  })
  win.webContents.on("will-navigate", (event) => event.preventDefault())
  if (smoke) win.webContents.on("console-message", (_e, _level, message) => console.log(`[renderer] ${message}`))
  void win.loadFile(path.join(__dirname, "renderer", "index.html"), { query: { url } })
}

app.whenReady().then(() => {
  createWindow()
  app.on("activate", () => BrowserWindow.getAllWindows().length === 0 && createWindow())
  if (smoke) {
    setTimeout(async () => {
      const [win] = BrowserWindow.getAllWindows()
      const text = await win.webContents.executeJavaScript("document.body.innerText + ' | avatar=' + document.querySelector('#avatar').innerText + ' | connected=' + document.querySelector('#status').classList.contains('on')")
      console.log(`[dom] ${String(text).replace(/\n+/g, " / ")}`)
      app.quit()
    }, Number(process.env.SOFIA_DESKTOP_SMOKE_MS || 4000))
  }
})
app.on("window-all-closed", () => app.quit())
