/**
 * admin-ui 的首屏主题引导 —— **必须是独立文件，不能内联**。
 *
 * 原因：面板用严格 CSP（`script-src 'self'`）。内联脚本会逼我们放开 `'unsafe-inline'`，
 * 那 CSP 就等于没有。而这段逻辑又必须在首屏渲染前跑完（否则深色模式下会闪一下白），
 * 所以它只能是一个**阻塞加载的小文件**。
 *
 * 三种取值：system（跟随系统）/ light / dark。存放在 localStorage，键名与前端约定一致。
 */
;(() => {
  const KEY = 'forlife-theme'
  let mode = 'system'
  try {
    const saved = localStorage.getItem(KEY)
    if (saved === 'light' || saved === 'dark' || saved === 'system') mode = saved
  } catch {
    // 隐私模式读不到，跟随系统即可
  }
  document.documentElement.dataset.theme = mode
  const dark = mode === 'dark' || (mode === 'system' && matchMedia('(prefers-color-scheme: dark)').matches)
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light'
})()
