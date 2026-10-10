/**
 * 进程级失败守卫的测试（用户 2026-10-10 的七级里，`crash` 那一档此前**永远是空的**）。
 *
 * ## 这个文件在钉什么
 *
 * 1. **★ 崩溃真的会被记下来**（而且是 `crash` 级、带堆栈）——
 *    这是"面板上那一档恒为 0"的反面；**"恒为 0"会被读成"没崩过"，那是最危险的误读**
 * 2. **★★ 记完必须死**：`uncaughtException` 一旦装了处理器，Node 的默认行为
 *    （打印 + 退出）**就被关掉了**。所以"只记不退"会让进程带着未知状态继续跑，
 *    那比直接崩危险得多
 * 3. **幂等**：重复装只生效一次（处理器叠一堆的话，一次崩溃会打 N 条，
 *    而且第一个处理器退出之后后面的可能来不及跑）
 * 4. **堆栈不许丢**（那是崩溃现场）
 *
 * ## ★ 为什么这里调的是 `makeCrashHandler`，而不是 `process.emit`
 *
 * 本仓测试用 `--experimental-test-isolation=none`，而 **`node:test` 自己就装了
 * `uncaughtException` 监听器**。在测试里 `process.emit('uncaughtException', …)`
 * 会被**判成测试失败** —— 实测：探针错误直接出现在失败输出里（`Error: 探针：故意炸的`）。
 *
 * ⇒ 处理器做成**可直接调用的纯函数**，测试调它；
 *   "有没有真的挂到 `process.on` 上"由**接线守卫**（读源码）钉住 —— 见本文件最后两条。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { crashGuardInstalled, installCrashGuard, makeCrashHandler } from '../src/admin/crash-guard.ts'
import { createLogger, installLogSink, type LogRecord } from '../src/admin/log.ts'

/** 造一个记账用的处理器（落点装到 got 里）。 */
function probe(): { readonly got: LogRecord[]; readonly fatal: number[]; readonly run: (reason: unknown, kind: 'uncaughtException' | 'unhandledRejection') => void; readonly uninstall: () => void } {
  const got: LogRecord[] = []
  const fatal: number[] = []
  const uninstall = installLogSink((record) => got.push(record))
  const run = makeCrashHandler({
    log: createLogger('crash-guard'),
    onFatal: (code) => fatal.push(code),
  })
  return { got, fatal, run, uninstall }
}

test('★★★ 未捕获异常 ⇒ 一条 crash（带堆栈）**并且**要求退出', () => {
  const p = probe()
  try {
    p.run(new Error('探针：故意炸的'), 'uncaughtException')

    const crashes = p.got.filter((record) => record.level === 'crash')
    assert.equal(crashes.length, 1, '必须有且只有一条 crash')
    const line = crashes[0]
    assert.equal(line?.module, 'crash-guard', '模块名要能一眼认出是它')
    assert.ok(line?.text.includes('探针：故意炸的'), `要带上原来的错误信息：${line?.text ?? ''}`)
    assert.ok(
      line?.text.includes('crash-guard.test.ts'),
      `★ 堆栈不许丢 —— 那是崩溃现场；实际：${line?.text ?? ''}`,
    )
    assert.ok(line?.text.includes('进程级失败'), '话术要说清这是"整个进程要没了"，不是某次操作出错')

    // ★★ 纪律 ①：记完必须死
    assert.deepEqual(p.fatal, [1], '★ 必须用退出码 1 结束 —— 只记不退会让进程带着未知状态继续跑')
  } finally {
    p.uninstall()
  }
})

test('★★ 未处理的拒绝走同一条路（Node 15 起它是**致命**的，不是警告）', () => {
  const p = probe()
  try {
    p.run(new Error('探针：未处理的拒绝'), 'unhandledRejection')
    const crashes = p.got.filter((record) => record.level === 'crash')
    assert.equal(crashes.length, 1)
    assert.ok(crashes[0]?.text.includes('未处理的拒绝'))
    assert.ok(crashes[0]?.text.includes('致命'), '话术要点明它是致命的（否则人会当警告忽略）')
    assert.deepEqual(p.fatal, [1])
  } finally {
    p.uninstall()
  }
})

test('★★ 落点炸了也必须退出（记日志失败不许把"死"也吞掉）', () => {
  const fatal: number[] = []
  const uninstall = installLogSink(() => {
    throw new Error('落点炸了')
  })
  try {
    const run = makeCrashHandler({
      // 连 logger 本身都抛（比"落点抛"更极端）
      log: {
        crash: () => {
          throw new Error('连记都记不了')
        },
      },
      onFatal: (code) => fatal.push(code),
    })
    // 不抛 = 通过
    run(new Error('探针'), 'uncaughtException')
    assert.deepEqual(fatal, [1], '★ 记不下来也必须死 —— 否则进程带着未知状态继续跑')
  } finally {
    uninstall()
  }
})

test('★ 非 Error 的崩溃值也要能摊成一行（不许抛、不许变 [object Object]）', () => {
  const p = probe()
  try {
    p.run('字符串形式的崩溃', 'uncaughtException')
    assert.ok(p.got[0]?.text.includes('字符串形式的崩溃'))
    p.got.length = 0
    p.run({ code: 'E_PROBE', detail: '对象形式的崩溃' }, 'unhandledRejection')
    assert.ok(p.got[0]?.text.includes('E_PROBE'), `对象要摊成 JSON：${p.got[0]?.text ?? ''}`)
  } finally {
    p.uninstall()
  }
})

test('★ 幂等：`installCrashGuard` 第二次调用不生效', () => {
  const before = crashGuardInstalled()
  if (!before) {
    assert.equal(installCrashGuard(() => undefined), true, '第一次装生效')
  }
  assert.equal(installCrashGuard(() => undefined), false, '★ 重复装不许再生效一个（叠一堆处理器）')
  assert.equal(crashGuardInstalled(), true)
})

test('★★ 接线守卫：CLI **入口**真的装了它，而且排在其它一切之前、且不从 start() 装', async () => {
  const { readFileSync } = await import('node:fs')
  const raw = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8')
  const src = raw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n')

  const mainAt = src.indexOf('async function main(')
  assert.ok(mainAt > 0, '找不到 main()')
  const body = src.slice(mainAt, mainAt + 800)
  const guardAt = body.indexOf('installCrashGuard()')
  const configAt = body.indexOf('resolveRuntimeConfig()')
  assert.ok(guardAt > 0, '★ 入口必须装崩溃守卫（否则 crash 那一级永远是空的）')
  assert.ok(
    configAt < 0 || guardAt < configAt,
    '★ 必须排在 `resolveRuntimeConfig()` **之前** —— 装在后面的话，启动阶段崩了照样没有日志',
  )
  // 而且不许从 `start()` 里装（那会被测试反复调用 ⇒ 处理器叠一堆）
  const startAt = src.indexOf('async start()')
  const startSection = src.slice(startAt, startAt + 3000)
  assert.ok(startAt > 0, '找不到 start()')
  assert.ok(!startSection.includes('installCrashGuard'), '★ 不许从 start() 装 —— 它会被测试反复调用')
})

test('★ 接线守卫：处理器真的挂到了 `process.on` 上（两个事件都要）', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../src/admin/crash-guard.ts', import.meta.url), 'utf8')
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n')
  assert.match(code, /process\.on\('uncaughtException'/, '未捕获异常必须挂上')
  assert.match(code, /process\.on\('unhandledRejection'/, '未处理的拒绝必须挂上')
  assert.match(code, /if \(installed\) return false/, '幂等判断必须在（叠处理器是个安静的故障）')
})
