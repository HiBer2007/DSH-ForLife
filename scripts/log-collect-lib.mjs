/**
 * 日志采集端的**归一规则**（`FIX_PLAN.md` §57 待办③）—— 纯函数，可单测。
 *
 * ## 为什么归一放在**宿主侧**
 *
 * 各家的 stdout 格式完全不同（NapCat 是 `10-11 14:01:20 [error] …`、Caddy 是 JSON、
 * DSH 是 `[forlife] …`），而容器里那套只认 `LogRecord`。
 * ★ 把"认格式"的活放在采集端 ⇒ 容器侧**一行都不用改**，
 * 而且**改规则不用重建镜像**（§57 的设计理由之一）。
 *
 * ## ★★ 级别判断是这一节的重点
 *
 * §57 的活证据是 NapCat 的三行 `[error] … ECONNREFUSED` ——
 * ★ 它们**必须**以 `error` 级别进库，否则面板按等级筛"错误"时**照样看不到**
 * （那等于白采集）。所以：
 *   - 行里自带级别标记（`[error]` / `[warn]` / Caddy 的 JSON `level`）⇒ **以它为准**；
 *   - 没有标记 ⇒ 用关键词猜（`error|fail|ECONNREFUSED|断开|掉线|重连` …），
 *     ★ 但**只在猜得出时才升格**，否则一律 `info`（不把正常行刷成错误）。
 *
 * @module scripts/log-collect-lib
 */

/** 七个等级（与 `packages/gateway/src/admin/log-levels.ts` 的 `LOG_LEVELS` **必须一致**）。 */
export const LEVELS = ['debug', 'info', 'note', 'warn', 'error', 'fault', 'crash']

/** 一条归一后的记录（与网关的 `LogRecord` 同形）。 */
/** @typedef {{ level: string, module: string, text: string, at: string }} NormalizedRecord */

/**
 * 去掉 ANSI 颜色码。
 *
 * ★ 真机第一次采集就看到了：NapCat 的级别标记带色 ——
 *   `[\u001b[31merror\u001b[39m] [Core] [Login] Login Error…`
 *   ⇒ 面板上会显示成一堆 `\u001b[31m`，而**级别标记本身也因此认不出来**。
 *   ⇒ 归一的第一步就是把它剥掉（顺带让 `levelMarker` 能认出色块里的 `error`）。
 *
 * @param {string} text - 原始文本。
 * @returns {string} 剥掉颜色码的文本。
 */
export function stripAnsi(text) {
  // eslint-disable-next-line no-control-regex -- 要的就是控制字符
  return text.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '')
}

/**
 * 从文本里猜等级。
 *
 * ★ 顺序有意义：先看最强的信号（`crash`/`fault`），再看 `error`，最后 `warn`。
 * ★ 中文关键词不是"顺手加的"：NapCat 与我们的组件都会打中文（`断开`/`掉线`/`重连`/`失败`）。
 *
 * @param {string} text - 一行日志。
 * @returns {string} 七个等级之一（猜不出就是 `info`）。
 */
export function guessLevelFromText(text) {
  const lower = text.toLowerCase()
  if (/panic|fatal|out of memory|oom-kill/.test(lower)) return 'crash'
  if (/econnrefused|econnreset|etimedout|enotfound|segfault/.test(lower)) return 'error'
  if (/\b(error|err|failed|failure|exception|traceback)\b/.test(lower)) return 'error'
  if (/错误|失败|异常|断开|掉线|连不上|超时/.test(text)) return 'error'
  // ★★ 操作提示：**高于 info、低于 error**（用户 2026-10-13 的要求）
  if (NOTE_PATTERNS.some((pattern) => pattern.test(text))) return 'note'
  // ★★ 二维码本体（方块字符行）也归 note —— 用户 2026-10-13：
  //   「这个依旧有行距，而且是 INFO 不是 NOTE」⇒ 那 20 多行二维码每行都该是 note，
  //   而不是只有前后的文字提示是 note。判据与面板那边一致：方块字符占比 ≥60%。
  if (isBlockArtText(text)) return 'note'
  if (/\b(warn|warning|deprecat)/.test(lower)) return 'warn'
  if (/警告|重试|重连|限流/.test(text)) return 'warn'
  return 'info'
}

/**
 * ★★ **操作提示**（"该你动手了"）—— 用户 2026-10-13 明确要求：它们**高于 `info`**。
 *
 * 用户原话：「需要为 NapCat 等的日志做出一点额外的辅助分级，尤其是原 INFO，
 * 其包含了所有非 Warn 和 Error 的信息，但是**像扫描二维码登录这样的信息理应属于 NOTE**，
 * 高于 INFO，他们不是一个普通的信息，而是一个**提示、一个操作通知**」。
 *
 * ★ 判据（对着 NapCat 的真机日志逐条挑的）：
 *   扫码 / 授权登录 / 二维码（保存路径 · 解码 URL · 生成网站）/ 重新获取二维码。
 * ★ 顺序：**排在 error 之后、warn 之前** —— 这样 `[error] … 扫码失败` 仍是 error
 *   （强信号优先），而"请扫描下面的二维码"这类**没有**错误词的提示升到 `note`。
 */
const NOTE_PATTERNS = [
  /扫描.{0,8}二维码/,
  /二维码.{0,8}扫码/,
  /扫码/,
  /授权登录/,
  /请在手机上/,
  /二维码已保存/,
  /二维码解码URL/i,
  /二维码路径/,
  /重新获取二维码/,
  /复制解码url/i,
]

/**
 * ★★ 标记与猜测**怎么合**（2026-10-13 加，用户要求"扫码这类提示要高于 info"）。
 *
 * 规则：
 * 1. **没有标记** ⇒ 用猜的；
 * 2. 标记是 `warn`/`error`/`fault`/`crash` ⇒ **以标记为准**（强信号不许被"二维码"之类拉低）；
 * 3. ★ 标记是 `info`/`debug`、而这一行**是操作提示**（扫码/授权/二维码…）⇒ **升到 `note`**。
 *
 * ★ 为什么第 3 条是必须的：NapCat 的真机日志里，那条"请扫描下面的二维码"**自带 `[info]` 标记**
 *   （面板截图里显示的就是 INFO）—— 若只看标记，用户的这条要求就永远落不了地。
 */
function resolveLevel(marked, text) {
  const guessed = guessLevelFromText(text)
  if (marked === undefined) return guessed
  if ((marked === 'info' || marked === 'debug') && guessed === 'note') return 'note'
  return marked
}
/**
 * 这一行是不是**方块字符拼的图**（NapCat 的登录二维码）。
 *
 * ★ 判据与面板侧（`LogsView.vue` 的 `isBlockArt`）**一致**：方块字符占比 ≥60% 且至少 8 个字符。
 * ★ 只认字符形状、不认模块名 ⇒ 别的容器有块状图也一样认；普通日志一行都不会被误伤。
 *
 * @param {string} text - 一行日志。
 * @returns {boolean} 是不是块状图。
 */
export function isBlockArtText(text) {
  const stripped = text.replace(/\s+/g, '')
  if (stripped.length < 8) return false
  let blocks = 0
  for (const ch of stripped) if (/[\u2580-\u259f\u25a0-\u25af\u2800-\u28ff]/.test(ch)) blocks += 1
  return blocks / stripped.length >= 0.6
}
/** 把等级标记（`[error]` / `[warn]` / `ERROR`）读出来；没有就 `undefined`。 */
export function levelMarker(text) {
  const match = /\[(debug|info|note|warn|warning|error|fault|crash)\]/i.exec(text)
  if (match === null) return undefined
  const raw = String(match[1]).toLowerCase()
  return raw === 'warning' ? 'warn' : raw
}

/**
 * 补年份：NapCat 只打 `MM-DD HH:MM:SS`。
 *
 * @param {string} stamp - `10-11 14:01:20`。
 * @param {Date} now - 当前时刻（用来定年份）。
 * @returns {string | undefined} ISO 时间戳；认不出返回 `undefined`。
 */
export function stampToIso(stamp, now) {
  const match = /^(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(stamp.trim())
  if (match === null) return undefined
  const [, mm, dd, hh, mi, ss] = match
  const year = now.getUTCFullYear()
  // ★ 本地时间（NapCat 打的是容器本地时间）—— 先按 UTC 拼，再用本地时区偏移校正。
  const naive = Date.UTC(year, Number(mm) - 1, Number(dd), Number(hh), Number(mi), Number(ss))
  const offsetMs = now.getTimezoneOffset() * 60_000
  const at = new Date(naive + offsetMs)
  if (Number.isNaN(at.getTime())) return undefined
  // ★ 跨年：如果算出来比"现在"晚了 1 天以上，那多半是去年的最后几天（12-31 → 01-01）。
  if (at.getTime() - now.getTime() > 24 * 3600_000) at.setUTCFullYear(year - 1)
  return at.toISOString()
}

/**
 * NapCat：`10-11 14:01:20 [error] [OneBot] [WebSocket Client] 在 3 秒后尝试重新连接`
 *
 * @param {string} line - 原始行。
 * @param {Date} now - 当前时刻。
 * @returns {NormalizedRecord | undefined} 归一结果（认不出格式返回 `undefined`）。
 */
export function normalizeNapCatLine(line, now) {
  const trimmed = stripAnsi(line).trim()
  if (trimmed === '') return undefined
  const match = /^(\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2})\s+(.*)$/.exec(trimmed)
  if (match === null) {
    // 没有时间戳的行（例如启动横幅）也收 —— 时间用"收到时刻"，正文照旧。
    return { level: resolveLevel(levelMarker(trimmed), trimmed), module: 'napcat', text: trimmed, at: now.toISOString() }
  }
  const [, stamp, rest] = match
  const marked = levelMarker(rest)
  return {
    level: resolveLevel(marked, rest),
    module: 'napcat',
    text: rest.replace(/\[(debug|info|note|warn|warning|error|fault|crash)\]\s*/i, '').trim(),
    at: stampToIso(stamp, now) ?? now.toISOString(),
  }
}

/**
 * Caddy：JSON 一行一条（`{"level":"error","ts":…,"logger":"http.log.error","msg":"…"}`）。
 *
 * @param {string} line - 原始行。
 * @param {Date} now - 当前时刻。
 * @returns {NormalizedRecord | undefined} 归一结果。
 */
export function normalizeCaddyLine(line, now) {
  const trimmed = stripAnsi(line).trim()
  if (trimmed === '') return undefined
  if (!trimmed.startsWith('{')) {
    // Caddy 启动时也会打非 JSON 的行（`serving initial configuration`）
    return { level: guessLevelFromText(trimmed), module: 'caddy', text: trimmed, at: now.toISOString() }
  }
  let parsed
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return { level: guessLevelFromText(trimmed), module: 'caddy', text: trimmed, at: now.toISOString() }
  }
  const level = typeof parsed.level === 'string' ? parsed.level.toLowerCase() : guessLevelFromText(trimmed)
  const logger = typeof parsed.logger === 'string' ? `[${parsed.logger}] ` : ''
  const msg = typeof parsed.msg === 'string' ? parsed.msg : JSON.stringify(parsed)
  const ts = typeof parsed.ts === 'number' ? new Date(parsed.ts * 1000).toISOString() : now.toISOString()
  return {
    level: level === 'warning' ? 'warn' : level,
    module: 'caddy',
    text: `${logger}${msg}`.trim(),
    at: ts,
  }
}

/**
 * DSH 宿主 / 我们的组件：`[forlife] …` 或 `2026-10-12T… [level] …`。
 *
 * @param {string} line - 原始行。
 * @param {Date} now - 当前时刻。
 * @returns {NormalizedRecord | undefined} 归一结果。
 */
export function normalizeDshLine(line, now) {
  const trimmed = stripAnsi(line).trim()
  if (trimmed === '') return undefined
  const isoMatch = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?)\s+(.*)$/.exec(trimmed)
  if (isoMatch !== null) {
    const [, iso, rest] = isoMatch
    return {
      level: resolveLevel(levelMarker(rest), rest),
      module: 'dsh-host',
      text: rest.replace(/\[(debug|info|note|warn|warning|error|fault|crash)\]\s*/i, '').trim(),
      at: new Date(iso).toISOString(),
    }
  }
  return {
    level: levelMarker(trimmed) ?? guessLevelFromText(trimmed),
    module: 'dsh-host',
    text: trimmed.replace(/^\[forlife\]\s*/, ''),
    at: now.toISOString(),
  }
}

/** 容器名 → 模块名（面板按模块筛，所以名字要稳定、短、可读）。 */
export const CONTAINER_MODULES = {
  'forlife-qq-1': 'napcat',
  'forlife-caddy-1': 'caddy',
  'forlife-dsh-1': 'dsh-host',
  'forlife-llama-server-1': 'llama',
}

/**
 * 按模块归一一行。
 *
 * @param {string} module - 模块名（由容器名映射而来）。
 * @param {string} line - 原始行。
 * @param {Date} now - 当前时刻。
 * @returns {NormalizedRecord | undefined} 归一结果（空行返回 `undefined`）。
 */
export function normalizeLine(module, line, now) {
  switch (module) {
    case 'napcat':
      return normalizeNapCatLine(line, now)
    case 'caddy':
      return normalizeCaddyLine(line, now)
    case 'dsh-host':
      return normalizeDshLine(line, now)
    default: {
      const trimmed = stripAnsi(line).trim()
      if (trimmed === '') return undefined
      return { level: resolveLevel(levelMarker(trimmed), trimmed), module, text: trimmed, at: now.toISOString() }
    }
  }
}

/**
 * 把记录切成一批发给网关（网关侧一批最多 200 条）。
 *
 * @param {readonly NormalizedRecord[]} records - 记录。
 * @param {number} max - 每批上限。
 * @returns {NormalizedRecord[][]} 批次。
 */
export function toBatches(records, max) {
  const out = []
  for (let i = 0; i < records.length; i += max) out.push(records.slice(i, i + max))
  return out
}

/**
 * 从一批"带宿主时间戳的记录"里选出本次要发的窗口。
 *
 * ★★ 这里有一条**真机踩出来的纪律**（2026-10-12 第一次真跑就撞上）：
 *   一次最多发 `MAX_PER_RUN` 条时，**必须从最旧的开始发**，而且
 *   **游标只能推进到"真正发出去的最后一条"**。
 *   第一版是 `records.slice(-max)`（发最新的）+ 游标推到"读到的最后一行" ⇒
 *   ★ 被丢掉的那 314 条**永远不会再被采到**（游标已经越过它们了）。
 *   ⇒ 现在：取**最旧的 max 条**，游标 = 这一窗最后一条的宿主时间戳；
 *     剩下的下次再采（`remaining > 0` 时采集端会打印出来提醒）。
 *
 * @param {readonly {record: NormalizedRecord, stamp: string | undefined}[]} entries - 按行序（= 时间序）。
 * @param {number} max - 本次最多发多少条。
 * @returns {{window: NormalizedRecord[], remaining: number, cursor: string | undefined}} 窗口、剩余条数、新游标。
 */
export function selectWindow(entries, max) {
  const window = entries.slice(0, Math.max(0, max))
  const last = window[window.length - 1]
  return {
    window: window.map((entry) => entry.record),
    remaining: Math.max(0, entries.length - window.length),
    cursor: last?.stamp,
  }
}

/**
 * 从 `docker logs --timestamps` 的一行里取时间戳（RFC3339 前缀）。
 *
 * ★ `--timestamps` 加的时间戳是**宿主时区的 RFC3339**，比容器自己打的更可信
 *   （容器时钟可能不对）；我们用它做**游标**，正文里那份容器时间照旧保留。
 *
 * @param {string} line - 带时间戳的一行。
 * @returns {string | undefined} ISO 时间戳。
 */
export function lineTimestamp(line) {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))/.exec(line.trim())
  if (match === null) return undefined
  const at = new Date(match[1])
  return Number.isNaN(at.getTime()) ? undefined : at.toISOString()
}

/** 去掉 `docker logs --timestamps` 加的那个前缀，留下容器自己打的内容。 */
export function stripTimestamp(line) {
  return line.replace(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})\s?/, '')
}

/**
 * 解析采集游标（断点续传）。
 *
 * @param {string} text - 状态文件内容。
 * @returns {Record<string, string>} 容器名 → 上次读到的 ISO 时间。
 */
export function parseCursor(text) {
  try {
    const parsed = JSON.parse(text)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out = {}
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'string' && !Number.isNaN(Date.parse(value))) out[key] = new Date(value).toISOString()
    }
    return out
  } catch {
    return {}
  }
}
