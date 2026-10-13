/**
 * ★★ 日志**卫生**的守卫（用户 2026-10-11 裁定，见 `FIX_PLAN.md` §55）。
 *
 * 用户原话：「**你在日志里面塞笔记？？？？？而且日志能解析 MD 格式吗就敢写 MD**」
 *
 * 三层守卫：
 *
 * 1. **行为**：`cleanLogText` 真的能清掉 Markdown 与换行（且不误伤正常文本）。
 * 2. **接线**：`createLogger` 的写入路径上**必须**调用它 —— ★ 断言**语句位置**，
 *    不是"全文某处出现过"（§54 的教训：那种断言在真被改坏时不会响）。
 * 3. **源码**：日志调用里**不许**出现 `TODO` / `FIXME` / 「待用户拍板」这类笔记
 *    —— 那是**文档**，该进 `FIX_PLAN.md`。★ 这条是**唯一能拦住"清不掉的东西"**的一层。
 */
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { cleanLogText, findLogNoise, isCleanLogText } from '../src/admin/log-hygiene.ts'

const SRC = join(import.meta.dirname, '..', 'src')

// ── 1. 行为 ──────────────────────────────────────────────────────────────

test('★★ Markdown 粗体与行内代码被清掉（日志查看器不渲染它们）', () => {
  const raw = '⚠ 以下唤醒条件**当前没有生产者**，改它们的开关不会发生任何事'
  const clean = cleanLogText(raw)
  assert.doesNotMatch(clean, /\*\*/, '粗体标记必须清掉 —— 日志查看器只会显示成一堆星号')
  assert.match(clean, /当前没有生产者/, '★ 只清标记，正文要留下')

  const code = '搬了 200 条（按 `rowid` 排序）'
  assert.doesNotMatch(cleanLogText(code), /`/, '行内代码的反引号要清掉')
  assert.match(cleanLogText(code), /rowid/, '★ 正文留下')
})

test('★★ 换行被压平 —— 一条日志就是一行', () => {
  const clean = cleanLogText('第一行\n第二行\n\n第三行')
  assert.doesNotMatch(clean, /\n/, '换行会把一条日志撑成"一段"')
  assert.match(clean, /第一行 第二行 第三行/)
})

test('★ 正常文本**不被误伤**（井号编号、普通星号、URL）', () => {
  for (const ok of [
    '搬了 200 条',
    '#123 这条编号不该被当成 Markdown 标题',
    '成功率 53%（3/8 次）',
    'ws://gateway:3010/ 已监听',
    '2 * 3 = 6',
  ]) {
    assert.equal(cleanLogText(ok), ok, `★ 不该改动：${ok}`)
    assert.equal(isCleanLogText(ok), true, `★ 自检应当认为是干净的：${ok}`)
  }
})

test('★★★ TODO / "待用户拍板" —— **运行时也要清掉**（换成短标记）', () => {
  const raw = '★ **待用户拍板**：从 WAKE_CONDITIONS 摘掉（见 runtime.ts:1570）'
  const hits = findLogNoise(raw)
  assert.ok(hits.includes('"待用户拍板"这类笔记'), `应当报出"待用户拍板"：${hits.join('、')}`)

  const clean = cleanLogText(raw)
  // ★ 我第一版写成"只报告不删"，理由是"删了会让本该被搬走的话消失"。
  //   ★ 那个理由站不住：用户要的就是"日志里别出现这些"，
  //     内容不丢靠**搬进 FIX_PLAN.md**，不是靠让它躺在日志里。
  assert.doesNotMatch(clean, /待用户拍板/, '★★ 日志正文里不许留"待用户拍板"')
  assert.match(clean, /笔记已移出日志/, '★ 换成一句短标记，让作者知道该去搬')
  // ★ 括号里的 `runtime.ts:1570` **属于这条笔记的内容** ⇒ 随它一起走，这是对的。
  assert.doesNotMatch(clean, /runtime\.ts:1570/, '★ 长在笔记里的行号引用随笔记一起清掉')
})

test('★ 单独出现的 `文件:行号` **保留**（它是有用的定位信息）', () => {
  const raw = '沉降一轮：碎片化 200 条（判据见 log-levels.ts:64）'
  assert.ok(findLogNoise(raw).includes('文件:行号 引用'), '应当**报出**它（供守卫按上下文判断）')
  assert.equal(cleanLogText(raw), raw, '★ 但**不改写** —— 它不是笔记')
})

test('★★★ 清的是"数据拼出来的日志正文"，不只是日志调用那一行', () => {
  // ★ 这条对着真事：日志正文来自 `wake.ts:185` 的**数据表**
  //   （`describeWakeProducerGaps()` 把它拼进消息），
  //   所以**只扫"像日志调用"的源码行是扫不到的** —— 只有运行时拦得住。
  const fromDataTable =
    '⚠ 以下唤醒条件**当前没有生产者**，面板上改它们的开关/概率不会发生任何事：' +
    'peer_input_status（等：**待用户拍板**：从 WAKE_CONDITIONS 摘掉）；'
  const clean = cleanLogText(fromDataTable)
  assert.doesNotMatch(clean, /\*\*/, '★ 粗体要清')
  assert.doesNotMatch(clean, /待用户拍板/, '★★ 数据拼进来的笔记也要清')
  // ★★ 事实部分必须留下 —— 这是回退验证抓出来的：
  //    第一版正则从**前一个句号/分号**往回吞，而真文本用**逗号** ⇒ 整行都被吃掉了。
  assert.match(clean, /当前没有生产者/, '★★ 事实部分要留下（第一版把它一起吃掉了）')
  assert.match(clean, /以下唤醒条件/, '★★ 前缀也要留下')
})

test('★ 自检与清洗的范围必须一致（不许"清了但自检说没清"）', () => {
  for (const raw of ['**粗**', '带\n换行', '# 标题', '`code`']) {
    const clean = cleanLogText(raw)
    assert.equal(isCleanLogText(clean), true, `★ 清过之后自检必须认为干净：${JSON.stringify(clean)}`)
  }
})

test('★★★ **探测得到就必须清得掉** —— 判定与清除用两套词表是最阴的坑', () => {
  // ★ 这是**端到端演示**抓出来的：第一版 `test` 认识 `待决策`，
  //   而 `clean` 的替换只匹配 `待拍板`/`待用户拍板`
  //   ⇒ **探测得到、却清不掉**，`待决策` 原样落进了日志。
  //   这条断言把"判定词表"和"清除词表"钉在一起（只有一处实现）。
  const samples = [
    '待用户拍板：从 WAKE_CONDITIONS 摘掉',
    '★ 待拍板：选哪条',
    '这里是待定项，见别处',
    '两条路都自洽，待决策：见 FIX_PLAN.md §56',
    '待确认后再动',
  ]
  for (const raw of samples) {
    const hits = findLogNoise(raw)
    if (!hits.includes('"待用户拍板"这类笔记')) continue
    const clean = cleanLogText(raw)
    assert.doesNotMatch(
      clean,
      /待(?:用户)?拍板|待定项|待决策|待确认/,
      `★★ 探测到了却清不掉：${JSON.stringify(raw)} → ${JSON.stringify(clean)}`,
    )
  }
})

// ── 2. 接线（★ 断言语句位置）─────────────────────────────────────────────

test('★★★ createLogger 的写入路径上**必须**清一次（收口在唯一入口，不靠自觉）', () => {
  const src = readFileSync(join(SRC, 'admin', 'log.ts'), 'utf8')
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
  // ★ 断言"`emit` 里真的用 cleanLogText 处理了 message 并把它放进 record"，
  //   而不是"文件里某处出现过 cleanLogText"（后者在接线被删掉时仍会绿）
  assert.match(
    code,
    /const\s+text\s*=\s*cleanLogText\(\s*message\s*\)/,
    '★ `emit` 里必须 `const text = cleanLogText(message)`',
  )
  assert.match(
    code,
    /text\s*,\s*at:\s*new Date\(\)\.toISOString\(\)/,
    '★★ `record.text` 必须用**清洗后**的 `text`，而不是原始的 `message`',
  )
  assert.doesNotMatch(
    code,
    /text:\s*message\b/,
    '★★ `text: message` 是**清洗前的写法** —— 说明清洗被绕过了',
  )
})

test('★ 插件侧的写入路径也清洗（log-sink 与 gateway 是两个入口）', () => {
  const src = readFileSync(join(SRC, '..', '..', 'dsh-component', 'src', 'log-sink.ts'), 'utf8')
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
  // ★★ 这条断言**被我自己修过一次**：第一版写的是 `cleanLogText|redact\(` ——
  //   而 `redact(` **本来就在那里** ⇒ **测试绿了，接线却是空的**
  //   （插件侧根本没清洗，Markdown/笔记会原样进同一个 `.jsonl`）。
  //   ⇒ 现在要求**两者同时出现**，且 `cleanLogText` 要**套在 redact 外面**。
  assert.match(
    code,
    /cleanLogText\(\s*redact\(/,
    '★★ 插件侧必须 `cleanLogText(redact(text))` —— 写的是**同一个文件**，' +
      '网关侧的清洗在 `createLogger` 里、**管不到这条路径**',
  )
  assert.match(code, /redact\(/, '★ 脱敏也不能丢（它先于卫生就有）')
})

// ── 3. 源码扫描：日志调用里不许塞笔记 ─────────────────────────────────────

const FORBIDDEN_IN_LOG = [
  { name: 'TODO / FIXME', re: /\b(?:TODO|FIXME)\b/i },
  { name: '「待用户拍板」这类笔记', re: /待(?:用户)?拍板|待定|待决策/ },
]

/** 只扫"看起来是日志调用"的那些行。 */
function looksLikeLogCall(line: string): boolean {
  return /(?:^|[^\w.])(?:log|logger|pluginLog|log\.[a-z]+)\s*(?:\.\s*(?:debug|info|note|warn|error|fault|crash)\s*)?\(/.test(
    line,
  )
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === 'test') continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (full.endsWith('.ts')) out.push(full)
  }
  return out
}

test('★★★ 源码里：日志调用的实参**不许**出现 TODO / "待用户拍板"', () => {
  const offenders: string[] = []
  for (const file of walk(SRC)) {
    const lines = readFileSync(file, 'utf8').split('\n')
    for (const [i, line] of lines.entries()) {
      if (!looksLikeLogCall(line)) continue
      // ★ 跳过纯注释行（注释里写 TODO 没关系 —— 那是给读代码的人看的）
      if (/^\s*(?:\/\/|\*|\/\*)/.test(line)) continue
      for (const bad of FORBIDDEN_IN_LOG) {
        if (bad.re.test(line)) {
          offenders.push(`${file.replace(SRC, 'src')}:${String(i + 1)}  ${bad.name}`)
        }
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    '★★ 日志里不许写笔记 —— 那是**文档**，该进 `FIX_PLAN.md`。\n' +
      '★ 理由（用户原话）：「你在日志里面塞笔记？？？？？而且日志能解析 MD 格式吗就敢写 MD」。\n' +
      '★★ 最重的一条：把"待用户拍板"塞进 warn ⇒ **每次启动都弹一条"需要你决策"的告警**，\n' +
      '   而真出事时没人看日志。\n' +
      `命中：\n  ${offenders.join('\n  ')}`,
  )
})
