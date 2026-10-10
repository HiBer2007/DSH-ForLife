/**
 * 插件日志汇的测试（`FIX_PLAN.md` §26）。
 *
 * ## 这个文件在钉什么
 *
 * **不是"写了就算"** —— 而是**拿网关那边的读端把行读回来**。
 * 那才叫"接上了"；只断言"文件里有内容"证明不了它能出现在面板上
 * （格式差一个字段，`parseRecord` 就把它当坏行丢掉，而**两边都不报错**）。
 *
 * ★ 这一条是本仓最贵那类问题的**直接对策**：
 * §23（零调用方）/§25（端子没实现）/`c16253b`（依赖没传）/§26（写到了没人读的地方）
 * —— 四次都是"两个都对的东西之间没有连起来"。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { readFileSync as readSource } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createLogStore } from '@forlife/gateway'

import { createPluginLogSink, pluginLogFileName } from '../src/log-sink.ts'

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'forlife-plugin-log-'))
}

test('★★★ 插件写的行，**网关那边的读端能读回来**（这才叫接上了）', () => {
  const dir = tempDir()
  try {
    const at = new Date('2026-10-10T08:30:00.000Z')
    const sink = createPluginLogSink({ dir, now: () => at })
    sink.write('fault', '唤醒 tick 异常：测试')
    sink.write('note', '投喂跳过：素材为空')
    sink.write('debug', '这一条默认不该被存 —— 但它确实写进了文件')

    // ★ 用**网关自己的** store 去读同一个目录
    const store = createLogStore({ dir })
    const rows = store.read({ limit: 50 })

    assert.equal(rows.length, 3, `网关应当读到 3 行，实际 ${String(rows.length)} 行（读到 0 通常意味着格式不对被丢掉）`)
    const levels = rows.map((r) => r.level)
    assert.ok(levels.includes('fault'), '★ fault 必须被认出（它是七级里最难被猜出来的那级）')
    assert.ok(levels.includes('note'), '★ note 同理')
    assert.equal(rows.find((r) => r.level === 'fault')?.text, '唤醒 tick 异常：测试', 'text 不许被改动')
    assert.equal(rows[0]?.module, 'dsh-plugin', '模块名默认是 dsh-plugin —— 面板按模块筛时靠它')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('★★★ 文件名与网关**逐字一致**（不一致 ⇒ 两边都正常而面板永远是空的）', () => {
  const at = new Date('2026-10-10T23:59:59.000Z')
  assert.equal(pluginLogFileName(at), 'forlife-2026-10-10.jsonl')
  // ★ 跨天：UTC 的日期边界决定文件名（与网关的 `toISOString().slice(0,10)` 同口径）
  assert.equal(pluginLogFileName(new Date('2026-10-11T00:00:01.000Z')), 'forlife-2026-10-11.jsonl')
})

test('★★ 跨天**自然换文件**（不做"今天是不是新的一天"的判断）', () => {
  const dir = tempDir()
  try {
    let clock = new Date('2026-10-10T23:00:00.000Z')
    const sink = createPluginLogSink({ dir, now: () => clock })
    sink.write('info', '第一天的')
    clock = new Date('2026-10-11T01:00:00.000Z')
    sink.write('info', '第二天的')

    // 两个文件各自存在，各自只有一行
    const day1 = readFileSync(join(dir, 'forlife-2026-10-10.jsonl'), 'utf8').trim().split('\n')
    const day2 = readFileSync(join(dir, 'forlife-2026-10-11.jsonl'), 'utf8').trim().split('\n')
    assert.equal(day1.length, 1)
    assert.equal(day2.length, 1)
    assert.ok(day1[0]?.includes('第一天的'))
    assert.ok(day2[0]?.includes('第二天的'))
    // ★ 而且是**追加**不是覆盖（同一个文件写两次要两行）
    sink.write('info', '第二天的又一条')
    assert.equal(readFileSync(join(dir, 'forlife-2026-10-11.jsonl'), 'utf8').trim().split('\n').length, 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('★★★ 写失败**只上报、绝不抛** —— 日志是旁路，它挂掉不该带走主流程', () => {
  const errors: string[] = []
  // 拿一个**文件**当目录 ⇒ `mkdirSync` 必失败
  const filePath = join(tempDir(), 'this-is-a-file')
  writeFileSync(filePath, 'x')

  const sink = createPluginLogSink({
    dir: join(filePath, 'sub'),
    onError: (m) => errors.push(m),
  })
  assert.doesNotThrow(() => {
    sink.write('error', '这条写不进去')
  }, '★★★ 日志写失败**不许**抛 —— 否则一次磁盘问题会让插件整个挂掉')
  assert.equal(errors.length, 1, '但要上报（静默吞掉会让"面板怎么没日志"无从查起）')
  assert.ok(errors[0]?.includes('插件日志写失败'), `上报内容要能看出是什么：${String(errors[0])}`)
})

test('★ 目录不存在时**懒创建**（不写日志就不建目录，启动路径无副作用）', () => {
  const base = tempDir()
  try {
    const nested = join(base, 'a', 'b', 'c')
    const sink = createPluginLogSink({ dir: nested, now: () => new Date('2026-10-10T00:00:00.000Z') })
    // 造汇时不建目录
    assert.throws(() => readFileSync(join(nested, 'forlife-2026-10-10.jsonl')), '造汇时不该写文件')
    sink.write('info', '第一次写')
    assert.ok(readFileSync(join(nested, 'forlife-2026-10-10.jsonl'), 'utf8').includes('第一次写'), '第一次写时才创建')
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

// ── ★★ 接线守卫（读源码）────────────────────────────────────────────────
//
// 这一条是 `c16253b` 那个教训的直接产物：**"东西写好了"和"真的接上了"是两件事**。
// 当时 `installModelRouter` 被调用、结果被用、dispose 也挂了 —— **四条守卫全绿**，
// 而 `getCatalog` 从入口就没传 ⇒ 整块功能在生产里是死的。
//
// ⇒ 这里必须断言：**两个日志入口真的把每一条都写进汇**，不只是 import 了。

test('★★★ 插件写的行**必须脱敏** —— 否则是在同一个文件里绕过网关那道保护', () => {
  // ## 这条是怎么来的
  //
  // 网关的日志汇聚点**有**脱敏（`server.ts:176` / `:193`，`redact.test.ts:144` 钉着）。
  // 而 `log-sink.ts` 写的是**同一个 JSONL 文件** —— 第一版**没有脱敏** ⇒
  // **在同一个文件里绕过了那道保护**。
  // 而插件的日志比网关的更容易带敏感内容（记忆正文、唤醒载荷、投喂素材）。
  //
  // ★ 而 `redact` 当时**根本没从 `@forlife/gateway` 导出** ⇒ 插件**引不到**
  //   —— 与 `initialRoute` / `atLevel` 是同一类"门没开"。
  const dir = tempDir()
  try {
    const sink = createPluginLogSink({ dir, now: () => new Date('2026-10-10T00:00:00.000Z') })
    // 用测试里那把**已知会被识别的**假 key（`redact.test.ts:23` 用的是同一把）
    sink.write('info', '用 oc_sk_d52d3e8dab4b_hOIdD08o25kgWnvw4HYPUCwM8k-4hkaX 调接口')
    sink.write('warn', 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig')

    const raw = readFileSync(join(dir, 'forlife-2026-10-10.jsonl'), 'utf8')
    assert.ok(
      !raw.includes('oc_sk_d52d3e8dab4b_hOIdD08o25kgWnvw4HYPUCwM8k-4hkaX'),
      '★★★ 明文 key **不许**出现在文件里 —— 这个文件是面板要读、要给人看的',
    )
    assert.ok(!raw.includes('eyJhbGciOiJIUzI1NiJ9.payload.sig'), '★★★ Bearer token 同理')
    // ★ 而且脱敏之后**仍然能被网关读出来**（别把整行写坏了）
    const store = createLogStore({ dir })
    const rows = store.read({ limit: 10 })
    assert.equal(rows.length, 2, `脱敏不许破坏可读性（实际读到 ${String(rows.length)} 行）`)
    // ⚠️ 标记是 `oc_sk_***` / `***`（`redact.ts:46-51`）——
    //    **不是** `«redacted»`：那是 `panel-api.json` **夹具**里的另一套约定，
    //    我第一版就是把它当成了脱敏产物，于是断言写错了一条。
    assert.equal(rows[0]?.text, '用 oc_sk_*** 调接口', '脱敏后该是 `oc_sk_***`（保留前缀，去掉密钥本体）')
    assert.equal(rows[1]?.text, 'Authorization: ***', 'Bearer 那条该是 `Authorization: ***`')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('★★★ 接线守卫：`log` **和** `always` 都必须把日志写进汇（只接一个 = 一半看不见）', () => {
  const src = readSource(new URL('../src/index.ts', import.meta.url), 'utf8')
  assert.match(src, /import\s*\{\s*createPluginLogSink\s*\}/, '没 import 日志汇')
  assert.match(src, /createPluginLogSink\(\{/, '没有真的造汇')
  assert.match(
    src,
    /pluginLog\?\.write\(guessLevel\(message\), message\)/,
    '★ 要用 `guessLevel` 定级 —— 与网关那边**同一套规则**，否则同一条日志在插件里叫 info、在面板里叫 error',
  )
  // ★ 两个入口都要写。只接 `always` ⇒ `verbose` 关掉时（默认）**什么都留不下**
  const writes = src.match(/pluginLog\?\.write\(/g) ?? []
  assert.ok(
    writes.length >= 2,
    `★ \`log\` 与 \`always\` **两个**都要写进汇（实际 ${String(writes.length)} 处）—— ` +
      '只接一个的话，另一条路径下的日志依旧只进 stdout，而**没人会发现**',
  )
  // ★ 目录必须与网关同源：`FORLIFE_LOG_DIR` 优先
  assert.match(src, /FORLIFE_LOG_DIR/, '★ 目录要认 `FORLIFE_LOG_DIR` —— 两边必须算出同一个目录，否则写进没人读的地方')

  // ★★ 2026-10-10 顺带钉住**同一段启动路径**上的另一件事：
  //   `scripts/doctor.mjs` 自己写着「真宿主探测的**可行做法**是在插件 apply 时
  //   **顺手跑一次**并写日志」，而那件事**从来没做** ⇒ 契约探针在生产里从不运行。
  //   ⇒ 现在它在 `apply()` 里跑了；这条钉住它别再被摘掉。
  //   （放在这个文件里是因为它已经在读 `src/index.ts` 的启动路径；
  //    语义上属于"启动路径接线"，与日志汇是同一段代码。）
  assert.match(src, /runDoctor\(ctx as never\)/, '★★ 启动路径必须跑一次宿主契约探针（否则升级 DSH 后没人会知道契约断了）')
  assert.match(
    src,
    /pluginLog\.write\('fault', `宿主契约：/,
    '★ 缺 `required` ⇒ 记忆本体不可用 ⇒ **一个子系统**不可用 ⇒ 必须是 `fault`（不是 info）',
  )
  assert.match(
    src,
    /pluginLog\.write\('warn', `宿主契约：/,
    '★ 只缺 `optional` ⇒ 降级可用 ⇒ warn；这与上一条的**分界**正是 host-contract 的三档结论',
  )
})
