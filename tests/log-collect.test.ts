/**
 * ★★ 日志采集端的**归一规则**测试（`FIX_PLAN.md` §57 待办③）。
 *
 * ## 为什么这一组测试重要（不是"顺手加的"）
 *
 * §57 的活证据是 NapCat 的三行：
 * ```
 * 10-11 14:01:20 [error] [OneBot] [WebSocket Client] 在 3 秒后尝试重新连接
 * 10-11 14:01:23 [error] 反向WebSocket (ws://gateway:3010/) 连接错误 Error: connect ECONNREFUSED
 * ```
 * ★ **它们必须以 `error` 级别进库** —— 否则面板按"错误"筛时**照样看不到**，
 * 那这套采集就白做了（采集的意义就是"那 3 次失败要看得见"）。
 *
 * 所以这里逐条钉：级别标记优先于关键词、关键词能认出 `ECONNREFUSED` 与中文
 * （`断开`/`掉线`/`重连`）、Caddy 的 JSON 形态、`MM-DD` 补年份、以及
 * ★ **空行不许变成空记录**（否则日志库会被空行灌满）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  CONTAINER_MODULES,
  selectWindow,
  guessLevelFromText,
  isBlockArtText,
  lineTimestamp,
  normalizeCaddyLine,
  normalizeDshLine,
  normalizeLine,
  normalizeNapCatLine,
  parseCursor,
  stampToIso,
  stripTimestamp,
  toBatches,
} from '../scripts/log-collect-lib.mjs'

/** 固定"现在"，让补年份可预期。 */
const NOW = new Date('2026-10-12T02:00:00.000Z')

test('★★★ §57 的活证据：NapCat 那三行必须是 `error`（否则按等级筛照样看不到）', () => {
  const lines = [
    '10-11 14:01:20 [error] [OneBot] [WebSocket Client] 在 3 秒后尝试重新连接',
    '10-11 14:01:23 [error] 反向WebSocket (ws://gateway:3010/) 连接错误 Error: connect ECONNREFUSED',
    '10-11 14:01:26 [error] 在 3 秒后尝试重新连接',
  ]
  for (const line of lines) {
    const record = normalizeNapCatLine(line, NOW)
    assert.ok(record !== undefined, `要能归一：${line}`)
    assert.equal(record.level, 'error', `必须是 error：${line}`)
    assert.equal(record.module, 'napcat', '模块名必须是 napcat（面板按它筛）')
    assert.ok(!record.text.includes('[error]'), '正文里不该再留着级别标记（级别已经是字段了）')
    assert.match(record.at, /^2026-\d{2}-\d{2}T/, `时间要补成年份：${record.at}`)
  }
})

test('★★ 级别标记优先于关键词（`[warn]` 的行不许被里面的 "error" 拉成 error）', () => {
  const record = normalizeNapCatLine('10-11 14:01:20 [warn] 上次的 error 已恢复', NOW)
  assert.equal(record?.level, 'warn', '标记是 warn ⇒ 就是 warn')
})

test('★★ 关键词能认出网络错误与中文（没有标记时）', () => {
  assert.equal(guessLevelFromText('connect ECONNREFUSED 127.0.0.1:3010'), 'error')
  assert.equal(guessLevelFromText('反向 WebSocket 连接断开，3 秒后重连'), 'error', '★ 中文"断开"要认出来')
  assert.equal(guessLevelFromText('没有可用额度，稍后重试'), 'warn', '★ 中文"重试"是 warn 不是 error')
  assert.equal(guessLevelFromText('[OneBot] 已连接'), 'info', '普通行不许被升格')
  assert.equal(guessLevelFromText('FATAL: out of memory'), 'crash')
})

test('★★ Caddy：JSON 一行一条（`level`/`ts`/`logger`/`msg`）', () => {
  const line = JSON.stringify({ level: 'error', ts: 1_760_000_000, logger: 'http.log.error', msg: 'dial tcp: refused' })
  const record = normalizeCaddyLine(line, NOW)
  assert.equal(record?.level, 'error')
  assert.equal(record?.module, 'caddy')
  assert.match(String(record?.text), /\[http\.log\.error\] dial tcp: refused/)
  assert.equal(record?.at, new Date(1_760_000_000 * 1000).toISOString(), 'ts 是秒 ⇒ 要用它')
  // 非 JSON 的启动行也要收（否则 Caddy 的启动信息会丢）
  const plain = normalizeCaddyLine('serving initial configuration', NOW)
  assert.equal(plain?.level, 'info')
  assert.equal(plain?.text, 'serving initial configuration')
})

test('★ DSH 宿主：`[forlife] …` 与带 ISO 前缀两种形态', () => {
  const a = normalizeDshLine('[forlife] 记忆库就绪', NOW)
  assert.equal(a?.module, 'dsh-host')
  assert.equal(a?.text, '记忆库就绪', '`[forlife]` 前缀要去掉')
  const b = normalizeDshLine('2026-10-12T01:59:00.000Z [warn] 端点额度用尽', NOW)
  assert.equal(b?.level, 'warn')
  assert.equal(b?.at, '2026-10-12T01:59:00.000Z', '带 ISO 前缀时要用它自己的时间')
})

test('★★ 空行/纯空白不许变成记录（否则日志库被空行灌满）', () => {
  for (const module of Object.values(CONTAINER_MODULES)) {
    assert.equal(normalizeLine(module, '   ', NOW), undefined, `${module} 的空行不该产出记录`)
    assert.equal(normalizeLine(module, '', NOW), undefined, `${module} 的空串不该产出记录`)
  }
})

test('★ `MM-DD` 补年份：跨年（比现在晚一天以上 ⇒ 算去年）', () => {
  const iso = stampToIso('10-11 14:01:20', NOW)
  assert.match(String(iso), /^2026-10-11T/, `应当是 2026-10-11：${iso}`)
  // 12-31 在 1 月 1 日读到时，应当算成去年
  const newYear = new Date('2026-01-01T02:00:00.000Z')
  const old = stampToIso('12-31 23:59:00', newYear)
  assert.match(String(old), /^2025-12-31T/, `跨年要算去年：${old}`)
})

test('★★ `docker logs --timestamps` 的前缀：取出来做游标、从正文里去掉', () => {
  const line = '2026-10-12T01:58:03.123456789Z 10-11 14:01:20 [error] boom'
  assert.equal(lineTimestamp(line), '2026-10-12T01:58:03.123Z')
  assert.equal(stripTimestamp(line), '10-11 14:01:20 [error] boom')
  // 没有前缀时不许误伤正文
  assert.equal(stripTimestamp('10-11 14:01:20 [error] boom'), '10-11 14:01:20 [error] boom')
  assert.equal(lineTimestamp('10-11 14:01:20 [error] boom'), undefined)
})

test('★ 分批：每批不超过 200（网关侧那条上限是硬要求）', () => {
  const records = Array.from({ length: 450 }, (_, i) => ({ level: 'info', module: 'napcat', text: `#${String(i)}`, at: NOW.toISOString() }))
  const batches = toBatches(records, 200)
  assert.deepEqual(batches.map((b) => b.length), [200, 200, 50])
  assert.equal(batches.flat().length, 450, '不许丢记录')
})

test('★★★ 限额时**从最旧的开始发**，游标只推进到"真正发出去的那一条"（真机踩过的丢数据）', () => {
  // 2026-10-12 第一次真跑就撞上：NapCat 读到 2314 行、一次只发 2000 条，
  // 而第一版发的是**最新**的 2000 条 + 游标推到"读到的最后一行"
  // ⇒ ★ 被丢掉的那 314 条**永远不会再被采到**（游标已经越过它们）。
  const entries = Array.from({ length: 2314 }, (_, i) => ({
    record: { level: 'info', module: 'napcat', text: `#${String(i)}`, at: NOW.toISOString() },
    stamp: new Date(NOW.getTime() + i * 1000).toISOString(),
  }))
  const first = selectWindow(entries, 2000)
  assert.equal(first.window.length, 2000)
  assert.equal(first.remaining, 314, '要说出还剩多少（下次继续）')
  assert.equal(first.window[0]?.text, '#0', '★ 必须从**最旧**的开始发')
  assert.equal(first.cursor, entries[1999]?.stamp, '★★ 游标 = 真正发出去的最后一条，不是读到的最后一行')
  // 下一窗接着发剩下的 314 条，且**一条不漏**
  const rest = entries.slice(2000)
  const second = selectWindow(rest, 2000)
  assert.equal(second.window.length, 314)
  assert.equal(second.remaining, 0)
  assert.equal(second.cursor, entries[2313]?.stamp)
  assert.equal(first.window.length + second.window.length, 2314, '★ 两窗加起来必须等于全部（不许漏）')
})
test('★★★ ANSI 颜色码必须剥掉（真机第一次采集就撞上：NapCat 的 `[\\u001b[31merror\\u001b[39m]`）', () => {
  // ★ 不剥的话：① 面板上显示成一堆控制字符；② **级别标记本身认不出来** ⇒ 全都变成 info，
  //   而"那 84 条 error 要看得见"正是这套采集存在的理由。
  const colored = '\u001b[31merror\u001b[39m [Core] [Login] Login Error,ErrType:  1  ErrCode: 3'
  const record = normalizeNapCatLine(`10-12 14:24:19 ${colored}`, NOW)
  assert.ok(record !== undefined)
  assert.equal(record.level, 'error', '★ 剥掉颜色码之后必须认出 error')
  assert.ok(!record.text.includes('\u001b'), '正文里不许再留控制字符')
  assert.match(record.text, /Login Error/)
  // 没有级别标记、只有颜色码时，也要靠关键词兜住
  const plain = normalizeNapCatLine('10-12 14:24:19 \u001b[33m连接断开\u001b[0m', NOW)
  assert.equal(plain?.level, 'error', '中文"断开" + 颜色码也要认出来')
})

test('★ 游标解析：坏 JSON / 坏时间戳都要能扛（否则采集端一启动就崩）', () => {
  assert.deepEqual(parseCursor('{"forlife-qq-1":"2026-10-12T01:00:00.000Z"}'), {
    'forlife-qq-1': '2026-10-12T01:00:00.000Z',
  })
  assert.deepEqual(parseCursor('不是 JSON'), {})
  assert.deepEqual(parseCursor('[1,2,3]'), {})
  assert.deepEqual(parseCursor('{"forlife-qq-1":"昨天"}'), {}, '认不出的时间戳要丢掉，不许把游标搞坏')
})

test('★★★ 操作提示（扫码/授权/二维码）⇒ `note`，★ 高于 `info`（用户 2026-10-13 的要求）', () => {
  // 用户原话：「像扫描二维码登录这样的信息**理应属于 NOTE**，高于 INFO，
  // 他们不是一个普通的信息，而是一个**提示、一个操作通知**」。
  const notes = [
    '请扫描下面的二维码，然后在手机上授权登录：',
    '二维码已保存到 /app/napcat/cache/qrcode.png',
    '二维码解码URL: https://txz.qq.com/p?k=xxx',
    '如果控制台二维码无法扫码，可以复制解码url到二维码生成网站生成二维码再扫码',
  ]
  for (const text of notes) {
    assert.equal(guessLevelFromText(text), 'note', `应当是 note（高于 info）：${text}`)
  }
  // ★ 两条**边界**：强信号优先 —— 有错误词就还是 error，不许被"二维码"拉成 note
  assert.equal(guessLevelFromText('登录服务已断开，将允许重新获取二维码'), 'error', '★ 断开是 error')
  assert.equal(guessLevelFromText('[error] 扫码失败'), 'error', '★ 有 error 就是 error')
  // ★ 普通行不许被误升
  assert.equal(guessLevelFromText('[OneBot] 已连接'), 'info')
  assert.equal(guessLevelFromText('没有可用额度，稍后重试'), 'warn')
})

test('★★ 归一后的 NapCat 扫码行确实是 `note`（走完整归一，不只是关键词函数）', () => {
  const line = '10-13 13:00:56 [info] 请扫描下面的二维码，然后在手机上授权登录：'
  const record = normalizeNapCatLine(line, NOW)
  assert.equal(record?.level, 'note', '★ 归一后的等级要升到 note（面板上才筛得出来）')
  assert.equal(record?.module, 'napcat')
})
test('★ 容器 → 模块名映射是稳定的（面板按模块筛，改名会让历史与新日志断开）', () => {
  assert.deepEqual(CONTAINER_MODULES, {
    'forlife-qq-1': 'napcat',
    'forlife-caddy-1': 'caddy',
    'forlife-dsh-1': 'dsh-host',
    'forlife-llama-server-1': 'llama',
  })
})

test('★★★ 二维码本体（方块字符行）⇒ note —— ★ 不是只有"文字提示"才升', () => {
  // ★★ 这条是**注入验证逼出来的**：我把 `if (isBlockArtText(text)) return 'note'` 注入成
  //    `if (false && …)`，结果**一条测试都没红** ⇒ 说明"二维码本体归 note"当时**没被任何测试盯着**。
  //    （原来那几条只覆盖了"请扫描下面的二维码…"这类**文字**提示，走的是 NOTE_PATTERNS。）
  const qr = '█ ▄▄▄▄▄ █▀ █▀▀▀ ▀▀▄ █ ▄▀▄██ ▄▄▄▄▄ █'
  assert.equal(isBlockArtText(qr), true, '先得认得出来这是块状图')
  assert.equal(guessLevelFromText(qr), 'note', '★ 二维码本体必须是 note')
  // ★ 真实形状：NapCat 那行自带 [info] 标记 ⇒ 归一后仍要升到 note
  const line = `10-13 13:25:57 [info] ${qr}`
  assert.equal(normalizeNapCatLine(line, NOW)?.level, 'note', '★ 归一后也必须是 note')
  // ★ 普通行不许被误伤
  assert.equal(guessLevelFromText('[OneBot] 已连接'), 'info')
  assert.equal(guessLevelFromText('收到一条群消息：今天天气不错'), 'info')
})