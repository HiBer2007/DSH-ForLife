/**
 * 真实 spawn 的测试（`FIX_PLAN.md` §30）。
 *
 * ## 这个文件**真的开进程**
 *
 * 与 `wake-program-runner.test.ts` 刻意相反：那里注入假 spawn 测**编排**，
 * 这里测的就是"**真的能不能跑**"。所以它是本仓少数几个**慢且依赖平台**的测试。
 *
 * ## ★ 为什么用 `.mjs` 而不是 `.sh` 做主要样本
 *
 * `node` 在 Windows 与 Linux **都存在** ⇒ `.mjs` 的用例**两处都能真跑**。
 * `.sh` / `.py` 会因为解释器缺席而**跳过**（不是失败）——
 * 而它们在**容器里**（Linux）会真的被执行到。
 * ⇒ 这样"平台相关"的部分不会变成一片红，也不会假装测过。
 *
 * ## 三条最要紧的断言
 *
 * 1. **扩展名白名单**：不在表里的扩展名 ⇒ **不启动任何进程**
 * 2. **环境变量不继承**：机密（`DEEPSEEK_API_KEY`）**不许**流进子进程
 * 3. **超时真的杀得掉**：`timedOut` 为真 + 不会挂满整个 `timeoutMs`
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { ALLOWED_SCRIPT_EXTENSIONS, createRealSpawn, interpreterFor } from '../src/wake-spawn.ts'

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'forlife-spawn-'))
}

/** 有没有这个解释器（用于决定跳过还是真跑）。 */
function has(command: string): boolean {
  if (command === 'node') return true // 我们就在 node 里
  return existsSync(command)
}

// ── 纯函数部分（任何平台都跑）────────────────────────────────────────────

test('★★★ 扩展名白名单：不在表里的一律**不许跑**（白名单不是黑名单）', () => {
  assert.ok(ALLOWED_SCRIPT_EXTENSIONS.includes('.sh'))
  assert.ok(ALLOWED_SCRIPT_EXTENSIONS.includes('.mjs'))
  // ★ 反面：这些**必须**被拒 —— 黑名单会漏掉它们，白名单不会
  for (const bad of ['/w/x.rb', '/w/x.pl', '/w/x.ps1', '/w/x.bat', '/w/x.exe', '/w/x', '/w/x.MJS.bak']) {
    assert.equal(interpreterFor(bad), undefined, `${bad} 不该在白名单里`)
  }
  // 大小写不敏感（`.MJS` 也是 `.mjs`）
  assert.deepEqual(interpreterFor('/w/x.MJS'), ['node'])
})

test('★ 白名单里**每一项**都必须有解释器映射（否则等于白名单写了个寂寞）', () => {
  for (const ext of ALLOWED_SCRIPT_EXTENSIONS) {
    assert.notEqual(interpreterFor('/w/x' + ext), undefined, `${ext} 在表里却没有解释器映射 —— 它会永远跑不起来`)
  }
})

// ── 真实 spawn（`.mjs` ⇒ 两处都能跑）────────────────────────────────────

test('★★ 真跑一个 .mjs：退出码 0、输出收在 tail 里', async () => {
  const dir = tempDir()
  try {
    const script = join(dir, 'ok.mjs')
    writeFileSync(script, 'console.log("hello-from-script")\n')
    const spawnFn = createRealSpawn()
    const r = await spawnFn({ absolutePath: script, cwd: dir, timeoutMs: 20_000, maxOutputBytes: 64 * 1024 })
    assert.equal(r.exitCode, 0, `应当成功退出，tail=${r.tail}`)
    assert.match(r.tail, /hello-from-script/)
    assert.ok(r.durationMs >= 0)
    assert.notEqual(r.timedOut, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('★★★ 机密**不许**流进子进程（默认只继承 PATH/HOME/LANG/TZ）', async () => {
  const dir = tempDir()
  const before = process.env['DEEPSEEK_API_KEY']
  try {
    // 父进程里放一个"机密"
    process.env['DEEPSEEK_API_KEY'] = 'sk-should-never-leak-into-child'
    const script = join(dir, 'env.mjs')
    writeFileSync(
      script,
      'console.log("LEAK=" + String(process.env.DEEPSEEK_API_KEY ?? "<absent>"))\n' +
        'console.log("PATH=" + String(process.env.PATH ?? process.env.Path ?? "<absent>" ).slice(0, 1))\n',
    )
    const r = await createRealSpawn()({ absolutePath: script, cwd: dir, timeoutMs: 20_000, maxOutputBytes: 64 * 1024 })
    assert.equal(r.exitCode, 0, `tail=${r.tail}`)
    assert.match(r.tail, /LEAK=<absent>/, '★★★ 机密必须**缺席** —— 脚本是工作区里的一个文件，那不构成信任')
    assert.ok(!r.tail.includes('sk-should-never-leak-into-child'), '★ 明文更不许出现')
    assert.match(r.tail, /PATH=[^<]/, '★ 但 PATH 要在（否则解释器之外的东西都用不了）')
  } finally {
    if (before === undefined) delete process.env['DEEPSEEK_API_KEY']
    else process.env['DEEPSEEK_API_KEY'] = before
    rmSync(dir, { recursive: true, force: true })
  }
})

test('★★ `extraEnv` 能显式补（需要什么就明说，而不是全量继承）', async () => {
  const dir = tempDir()
  try {
    const script = join(dir, 'extra.mjs')
    writeFileSync(script, 'console.log("GOT=" + String(process.env.MY_EXPLICIT ?? "<absent>"))\n')
    const r = await createRealSpawn({ extraEnv: { MY_EXPLICIT: 'yes' } })({
      absolutePath: script,
      cwd: dir,
      timeoutMs: 20_000,
      maxOutputBytes: 64 * 1024,
    })
    assert.match(r.tail, /GOT=yes/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('★★★ 超时**真的杀掉**（不是只在账上记一笔）', async () => {
  const dir = tempDir()
  try {
    const script = join(dir, 'slow.mjs')
    // 睡 30 秒；我们在 500ms 就杀它 —— 若没真杀，这个测试会挂 30 秒
    writeFileSync(script, 'setTimeout(() => console.log("never"), 30000)\n')
    const started = Date.now()
    const r = await createRealSpawn()({ absolutePath: script, cwd: dir, timeoutMs: 500, maxOutputBytes: 4096 })
    const elapsed = Date.now() - started
    assert.equal(r.timedOut, true, '★ 必须标记超时（`decideAfterExit` 靠它把这次算失败）')
    assert.notEqual(r.exitCode, 0, '被杀的退出码不是 0')
    assert.ok(elapsed < 10_000, `★ 必须**真的**杀掉：实际耗时 ${String(elapsed)}ms（若没杀会接近 30000ms）`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('★★ 输出**边收边截**：字节数照实记，tail 不超过上限', async () => {
  const dir = tempDir()
  try {
    const script = join(dir, 'noisy.mjs')
    // 打 200KB，上限给 4KB
    writeFileSync(script, 'process.stdout.write("x".repeat(200 * 1024))\n')
    const r = await createRealSpawn()({ absolutePath: script, cwd: dir, timeoutMs: 20_000, maxOutputBytes: 4096 })
    assert.equal(r.exitCode, 0)
    assert.ok(r.outputBytes > 4096, `★ 真实产出字节数要如实记（用来判"超输出"）：${String(r.outputBytes)}`)
    assert.ok(r.tail.length <= 4096, `★ tail 不许超过上限：实际 ${String(r.tail.length)}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('★★ 不在白名单里 ⇒ **一个进程都不开**，且给出可读原因', async () => {
  const dir = tempDir()
  try {
    const script = join(dir, 'evil.rb')
    writeFileSync(script, 'puts "should never run"\n')
    const r = await createRealSpawn()({ absolutePath: script, cwd: dir, timeoutMs: 5000, maxOutputBytes: 4096 })
    assert.equal(r.exitCode, -1, '★ 不抛异常，而是变成"跑失败"让上层按策略处理')
    assert.match(r.tail, /扩展名不在白名单里/)
    assert.equal(r.outputBytes, 0, '★ 没开进程 ⇒ 不可能有任何输出')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('★ 解释器不存在（例如没装 python3）⇒ 给出可读原因而不是崩', async (t) => {
  if (!has('/bin/sh')) return t.skip('这台机器没有 /bin/sh（Windows）—— 容器里会跑到')
  const dir = tempDir()
  const before = process.env['PATH']
  try {
    // 把 PATH 清掉 ⇒ 白名单里的 `node` 找不到（模拟"解释器没装"）
    process.env['PATH'] = ''
    const script = join(dir, 'x.mjs')
    writeFileSync(script, 'console.log(1)\n')
    const r = await createRealSpawn()({ absolutePath: script, cwd: dir, timeoutMs: 5000, maxOutputBytes: 4096 })
    assert.equal(r.exitCode, -1)
    assert.match(r.tail, /spawn 出错/)
  } finally {
    if (before !== undefined) process.env['PATH'] = before
    rmSync(dir, { recursive: true, force: true })
  }
})
