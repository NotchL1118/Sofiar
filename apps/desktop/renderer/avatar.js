// 形象层的接缝。app.js 只通过 window.SofiaAvatar 这个接口驱动形象：
//
//   expressions: string[]        可用表情名（hello 时上报给 daemon，成为模型可调用的 desktop_expression 选项）
//   motions: string[]            可用动作名（同上，desktop_motion）
//   mount(el): void | Promise    把形象挂到容器里；返回后 expressions / motions 必须已就绪
//   setExpression(name): void    daemon 发来 expression
//   playMotion(name): void       daemon 发来 motion
//   setSpeaking(on): void        她正在说话（流式输出期间为 true），可用于口型
//
// 现在是颜文字占位实现。接入 Live2D 时替换本文件即可（例如 pixi-live2d-display：在 mount 里加载模型，
// 从模型的 expressions / motion groups 填充两个数组），app.js 与协议都不用动。
window.SofiaAvatar = (() => {
  const faces = { neutral: "( ˘ω˘ )", smile: "(≧▽≦)", angry: "(｀へ´)", sad: "(´；ω；`)", surprised: "Σ(ﾟДﾟ)", shy: "(〃ω〃)" }
  const motions = ["wave", "nod", "shake", "jump"]
  let el
  return {
    expressions: Object.keys(faces),
    motions,
    mount(container) {
      el = document.createElement("div")
      el.className = "placeholder-avatar"
      el.textContent = faces.neutral
      container.replaceChildren(el)
    },
    setExpression(name) {
      if (el && faces[name]) el.textContent = faces[name]
    },
    playMotion(name) {
      if (!el || !motions.includes(name)) return
      const cls = `m-${name}`
      el.classList.remove(...motions.map((m) => `m-${m}`))
      void el.offsetWidth // 重新触发动画
      el.classList.add(cls)
      el.addEventListener("animationend", () => el.classList.remove(cls), { once: true })
    },
    setSpeaking(on) {
      if (el) el.classList.toggle("speaking", Boolean(on))
    },
  }
})()
