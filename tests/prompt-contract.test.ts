/**
 * 位置契约 lint 的**自测**（阶段 4 交付物 4/5 的一部分）。
 *
 * 为什么 lint 也要测：一个从不失败的检查等于没有检查，
 * 而且比没有更糟 —— 它会让人以为"有守卫"，从而放松警惕。
 *
 * 所以这里做两件事：
 *  ① 跑一次真实仓库的 lint，必须是 0；
 *  ② **故意造一个违规**（把 `Date.now()` 塞进前缀段），确认它真的报错。
 *     这条不成立的话，①的绿灯毫无意义。
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, test } from 'node:test'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const LINT = join(REPO_ROOT, 'scripts', 'lint-prompt-positions.ts')

/** 临时违规文件所在目录（放在 packages 下才会被扫到）。 */
const VIOLATION_DIR = join(REPO_ROOT, 'packages', 'dsh-component', 'src', '__lint-fixture__')
const VIOLATION_FILE = join(VIOLATION_DIR, 'violation.ts')

/** 跑 lint，返回退出码与输出。 */
function runLint(): { code: number; output: string } {
  try {
    const output = execFileSync(process.execPath, [LINT], { encoding: 'utf8', cwd: REPO_ROOT, stdio: 'pipe' })
    return { code: 0, output }
  } catch (error) {
    const err = error as { status?: number; stdout?: string; stderr?: string }
    return { code: err.status ?? 1, output: `${err.stdout ?? ''}${err.stderr ?? ''}` }
  }
}

after(() => {
  try {
    rmSync(VIOLATION_DIR, { recursive: true, force: true })
  } catch {
    // 清理失败不影响断言
  }
})

test('真实仓库：位置契约检查必须通过（前缀里没有动态内容）', () => {
  const { code, output } = runLint()
  assert.equal(code, 0, `lint 应当通过，实际输出：\n${output}`)
  assert.match(output, /位置契约检查通过/)
  // 我们的每一段都要被扫到（漏扫等于没守）。
  // ⚠️ 2026-10-09 加 `FEED_MODE_NAME`：新加的段如果**没被扫到**，
  //    "前缀里没有动态内容"这条承诺就有一个盲区（那段恰好也在前缀区、order 140）。
  // ⚠️ 2026-10-09 加 `PROACTIVITY_NAME`（order 115）—— 同一类盲区，别再漏第三次。
  for (const name of ['P1_NAME', 'P2_NAME', 'PROACTIVITY_NAME', 'L2_NAME', 'L3_NAME', 'FEED_MODE_NAME']) {
    assert.ok(output.includes(name), `lint 应当扫到 ${name}`)
  }
})

test('故意违规：把动态内容塞进前缀段必须被抓住（否则这个 lint 毫无意义）', () => {
  mkdirSync(VIOLATION_DIR, { recursive: true })
  try {
    // 这是一个**看起来很正常**的段：位置在前缀区，但文本里带了当前时间。
    // 真实场景里这种写法极易出现（"给模型加个时间提示"），而它会让缓存永不命中。
    writeFileSync(
      VIOLATION_FILE,
      [
        "import type { MemoryRuntime } from '../runtime.ts'",
        '',
        'export function registerBad(systemPrompt: { section(s: unknown): () => void }, runtime: MemoryRuntime): () => void {',
        '  return systemPrompt.section({',
        "    name: 'forlife:oops-time-in-prefix',",
        '    order: 140,',
        '    text: () => `现在是 ${new Date().toISOString()}`,',
        '    interpolate: false,',
        '  })',
        '}',
        '',
      ].join('\n'),
      'utf8',
    )

    const { code, output } = runLint()
    assert.equal(code, 1, `lint 必须报错，实际输出：\n${output}`)
    assert.match(output, /位置契约违规/)
    assert.match(output, /forlife:oops-time-in-prefix|oops-time-in-prefix/, '要指出是哪个段')
    assert.match(output, /动态内容/, '要说清问题是什么')
    assert.match(output, /尾部注入/, '要告诉人该怎么改')
  } finally {
    rmSync(VIOLATION_DIR, { recursive: true, force: true })
  }

  // 清理之后必须恢复通过（证明失败是那条违规造成的，而不是环境问题）
  const after = runLint()
  assert.equal(after.code, 0, '移除违规后应当恢复通过')
})

test('故意违规：同一 order 被两个段占用也要被抓住', () => {
  mkdirSync(VIOLATION_DIR, { recursive: true })
  try {
    writeFileSync(
      VIOLATION_FILE,
      [
        'export function registerCollision(systemPrompt: { section(s: unknown): () => void }): () => void {',
        '  return systemPrompt.section({',
        "    name: 'forlife:collides-with-p1',",
        '    order: 100,',
        "    text: '静态文本，但位置与 P1 撞车',",
        '    interpolate: false,',
        '  })',
        '}',
        '',
      ].join('\n'),
      'utf8',
    )
    const { code, output } = runLint()
    assert.equal(code, 1, `order 撞车必须报错，实际：\n${output}`)
    assert.match(output, /被多个段占用/)
  } finally {
    rmSync(VIOLATION_DIR, { recursive: true, force: true })
  }
})
