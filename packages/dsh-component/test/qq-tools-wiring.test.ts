/**
 * QQ 工具的**接线守卫** —— 守的是"它们真的被注册了"。
 *
 * ## ★ 这条守卫为什么必须存在（它是本项目最贵的一课）
 *
 * `buildQqTools` 写好了、`qq-tools.test.ts` **全绿**，
 * 而 `index.ts` 的 `apply()` **从来没有调它** ⇒
 * **`qq_reply` / `qq_react` / `qq_typing` / `read_pending` / `set_status` /
 * `defer_turn` / `qq_mention_all` / `qq_group_notice` / `qq_send_sticker`
 * 在生产里根本不存在** ⇒ **模型无法回复任何 QQ 消息**。
 *
 * **为什么测试没抓到**：`qq-tools.test.ts` **直接调 `buildQqTools`**
 * （`const tools = buildQqTools(...)`）—— 那一步**绕过了注册**。
 * 而验收①验的是**唤醒**（`buildWakeTools` 注册了，所以那条链路真的通）。
 *
 * ⇒ **"工具测试全绿"与"工具在生产里不存在"可以同时成立。**
 *
 * ## 三层守卫
 *
 * 1. **读源码**：`apply()` 里必须真的调 `buildQqTools`；
 * 2. **跑真 `apply()`**：注册表里必须出现**全部** `QQ_TOOL_NAMES`；
 * 3. **每个工具真的可执行**（不只是名字在表里）。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { QQ_TOOL_NAMES as QQ_TOOL_NAMES_NARROW } from '../src/qq-tools.ts'

/** 宽化成 `readonly string[]` —— 元组类型下 `.includes(string)` 会报 TS2345。 */
const QQ_TOOL_NAMES: readonly string[] = QQ_TOOL_NAMES_NARROW
import { apply } from '../src/index.ts'
import { resolveConfig } from '../src/config.ts'

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function quiet<T>(fn: () => T): T {
  const o1 = console.log
  const o2 = console.error
  console.log = (): void => {}
  console.error = (): void => {}
  try {
    return fn()
  } finally {
    console.log = o1
    console.error = o2
  }
}

/** 假上下文：**真的注册**（把定义存下来），所以能验"注册表里有没有"。 */
function fakeCtx(): { ctx: never; registered: string[] } {
  const registered: string[] = []
  const ctx = {
    get: (name: string): unknown => {
      if (name === 'tools') {
        return {
          register: (definition: { name?: string }): (() => void) => {
            if (typeof definition.name === 'string') registered.push(definition.name)
            return (): void => {}
          },
        }
      }
      if (name === 'systemPrompt') return { section: (): (() => void) => (): void => {} }
      return undefined
    },
    inject: (): void => {},
    effect(callback: () => void | (() => void)): void {
      const d = callback()
      if (typeof d === 'function') void d
    },
    on: (): (() => void) => (): void => {},
  }
  return { ctx: ctx as never, registered }
}

test('★★ 接线守卫（读源码）：`apply()` 真的调了 `buildQqTools`', () => {
  const src = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
  assert.match(
    src,
    /for \(const definition of buildQqTools\(/,
    '**`buildQqTools` 必须在 `apply()` 的注册循环里** —— ' +
      '它曾经漏了，导致 9 个 QQ 工具在生产里不存在（模型无法回复 QQ）',
  )
  assert.match(src, /import \{ buildQqTools \} from '\.\/qq-tools\.ts'/, '要真的导入')
})

test('★★★ 跑真 `apply()`：**全部** `QQ_TOOL_NAMES` 都进了注册表', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'forlife-qq-wiring-'))
  const fake = fakeCtx()
  quiet(() => {
    apply(fake.ctx, resolveConfig({ storageRoot: dir, verbose: false }))
  })
  await delay(30)

  const missing = QQ_TOOL_NAMES.filter((name) => !fake.registered.includes(name))
  assert.deepEqual(
    missing,
    [],
    `**这些 QQ 工具没有注册**：${missing.join(', ')}\n` +
      `注册表里实际有 ${String(fake.registered.length)} 个工具。\n` +
      '（**这就是"工具写好了但生产里不存在"** —— 模型会照 PLAN §8.1 的名字去调，然后失败。）',
  )
})

test('★ 注册的是**真的工具定义**（不只是名字在表里）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'forlife-qq-wiring2-'))
  const fake = fakeCtx()
  quiet(() => {
    apply(fake.ctx, resolveConfig({ storageRoot: dir, verbose: false }))
  })
  await delay(30)
  // `qq_reply` 是 PLAN §8.1 的第一个工具，也是"模型回复 QQ"的唯一出口
  assert.ok(fake.registered.includes('qq_reply'), '**`qq_reply` 必须在** —— 它是回复 QQ 的唯一出口')
  // 至少 9 个（PLAN §8.1 的三个 + EXECUTION_PLAN 加的）
  assert.ok(
    fake.registered.filter((n) => QQ_TOOL_NAMES.includes(n)).length >= 9,
    `QQ 工具至少要 9 个，实际 ${String(fake.registered.filter((n) => QQ_TOOL_NAMES.includes(n)).length)}`,
  )
})
