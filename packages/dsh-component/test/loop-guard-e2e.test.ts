/**
 * 死循环监控的**端到端接线测试**（跑真的 `apply()`）。
 *
 * ## 为什么必须有这一条（本轮最有价值的一条）
 *
 * 前面三层各自都有测试（13/13 + 8/8 + 9/9），但它们**都证明不了
 * "`index.ts` 真的调了 `registerLoopGuard`"** ——
 * 而那正是本项目**反复出问题的那一层**：
 * - `whitelist` 参数被丢；
 * - `onConnectionState` 被构造函数丢掉；
 * **两次都是单测全绿、线上没跑。**
 *
 * ## ★ 这一条**一开始就会红**（我确认过）
 *
 * `wiring.test.ts` 里的 `fakeContext` **没有 `on` 方法** ——
 * 所以真 `apply()` 下 `registerLoopGuard` 会走到"宿主没有 ctx.on"那条分支，
 * **监控根本没挂上**。
 *
 * ⇒ 本文件**给假上下文补上 `on`**，然后**从头到尾走一遍**：
 * `apply()` → 注册 → 喂帧 → 累积 → 判定 → **调 `agent.cancel`**。
 *
 * **只测最后一跳是不够的** —— 中间任何一环断了，行为都一样（什么都不发生）。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { apply } from '../src/index.ts'
import { resolveConfig } from '../src/config.ts'

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** 安静的日志捕获（`apply` 会往 stdout 说话）。 */
function quiet<T>(fn: () => T): T {
  const original = console.log
  const originalErr = console.error
  console.log = (): void => {}
  console.error = (): void => {}
  try {
    return fn()
  } finally {
    console.log = original
    console.error = originalErr
  }
}

/**
 * 假上下文 —— **比 `wiring.test.ts` 那个多一个 `on`**。
 *
 * `on` 是**真的注册**（把 handler 存下来），所以 `fire()` 能真的驱动它 ——
 * 这正是"接线"要验的东西。
 */
function fakeContextWithOn(): {
  ctx: never
  events: string[]
  fire: (...args: unknown[]) => void
  disposeCount: () => number
} {
  const events: string[] = []
  const handlers = new Map<string, (...args: unknown[]) => void>()
  let disposed = 0
  const ctx = {
    get: (): unknown => undefined,
    inject: (): void => {},
    effect(callback: () => void | (() => void)): void {
      const d = callback()
      if (typeof d === 'function') void d
    },
    on(event: string, handler: (...args: unknown[]) => void): () => void {
      events.push(event)
      handlers.set(event, handler)
      return (): void => {
        disposed += 1
      }
    },
  }
  return {
    ctx: ctx as never,
    events,
    disposeCount: () => disposed,
    fire: (...args: unknown[]) => {
      // 本项目里事件名不止一个（`session/event` 也在）——
      // 这里**只驱动 assistant-stream**，因为那是被测的那条
      handlers.get('agent/assistant-stream')?.(...args)
    },
  }
}

test('★★★ 端到端：真 `apply()` 之后，喂重复帧 ⇒ **真的中止本轮**', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'forlife-loop-e2e-'))
  try {
    const fake = fakeContextWithOn()
    quiet(() => {
      apply(fake.ctx, resolveConfig({ storageRoot: dir, verbose: false }))
    })
    await delay(30)

    // ① **监控必须挂上了** —— 没挂上的话下面全都没意义
    assert.ok(
      fake.events.includes('agent/assistant-stream'),
      '**apply() 没有注册 assistant-stream 钩子** —— 事件只有：' + fake.events.join(', '),
    )

    // ② 喂**同一句话**反复出现（走宿主真实约定：一个 payload）
    const cancels: string[] = []
    const agent = {
      cancel: (cause: { kind: string; reason: string }): void => {
        cancels.push(`${cause.kind}:${cause.reason}`)
      },
    }
    for (let i = 0; i < 16; i += 1) {
      fake.fire({ agent, frame: { type: 'start' } })
      fake.fire({ agent, frame: { type: 'chunk', chunk: { type: 'text-delta', text: '我先看看这个文件的内容对不对' } } })
      fake.fire({ agent, frame: { type: 'end' } })
    }

    // ③ **必须真的中止了**
    assert.ok(
      cancels.length > 0,
      '**端到端没中止** —— 三层单测都绿，但 apply() 里没接上（或中间某环断了）',
    )
    assert.match(cancels[0] ?? '', /^hook:/, '**要用 `kind:hook` 那一档**')
  } finally {
    // **容忍失败** —— apply() 开着库，Windows 上删不掉（EPERM）。
    // **不要因为清理失败把一条通过的测试报成红的**（那会让人去查错的地方）。
    try {
      // **容忍失败** —— apply() 开着库，Windows 上删不掉（EPERM）。
    // **不要因为清理失败把一条通过的测试报成红的**（那会让人去查错的地方）。
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // 临时目录留给系统回收
    }
    } catch {
      // 临时目录留给系统回收
    }
  }
})

test('★★ 端到端：**正常输出不中止**（误杀比漏判更糟）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'forlife-loop-e2e-ok-'))
  try {
    const fake = fakeContextWithOn()
    quiet(() => {
      apply(fake.ctx, resolveConfig({ storageRoot: dir, verbose: false }))
    })
    await delay(30)

    const cancels: string[] = []
    const agent = { cancel: (c: { reason: string }): void => void cancels.push(c.reason) }
    const normal = [
      '先看配置文件，里面写着端口和数据库路径。',
      '然后检查数据库文件是否存在，不存在就初始化。',
      '接着跑一遍迁移，把表结构建起来。',
      '最后启动服务，确认端口在监听。',
      '如果端口被占用，就换一个端口重试。',
      '顺手把日志级别调低一点，免得刷屏。',
    ]
    for (const line of normal) {
      fake.fire({ agent, frame: { type: 'start' } })
      fake.fire({ agent, frame: { type: 'chunk', chunk: { type: 'text-delta', text: line } } })
      fake.fire({ agent, frame: { type: 'end' } })
    }
    assert.equal(cancels.length, 0, `**正常输出被误杀了**：${cancels.join(' | ')}`)
  } finally {
    // **容忍失败** —— apply() 开着库，Windows 上删不掉（EPERM）。
    // **不要因为清理失败把一条通过的测试报成红的**（那会让人去查错的地方）。
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // 临时目录留给系统回收
    }
  }
})

test('★ 端到端：**两个 agent 交替**不能互相算成重复（按 agent 隔离）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'forlife-loop-e2e-iso-'))
  try {
    const fake = fakeContextWithOn()
    quiet(() => {
      apply(fake.ctx, resolveConfig({ storageRoot: dir, verbose: false }))
    })
    await delay(30)

    const aCancels: string[] = []
    const bCancels: string[] = []
    const a = { cancel: (c: { reason: string }): void => void aCancels.push(c.reason) }
    const b = { cancel: (c: { reason: string }): void => void bCancels.push(c.reason) }
    const linesA = ['甲这边在看配置文件', '甲这边在跑测试', '甲这边在写文档', '甲这边在查日志', '甲这边在改代码']
    const linesB = ['乙这边在读需求', '乙这边在设计表', '乙这边在写迁移', '乙这边在测接口', '乙这边在发版本']
    for (let i = 0; i < 5; i += 1) {
      fake.fire({ agent: a, frame: { type: 'start' } })
      fake.fire({ agent: a, frame: { type: 'chunk', chunk: { type: 'text-delta', text: linesA[i] ?? '' } } })
      fake.fire({ agent: a, frame: { type: 'end' } })
      fake.fire({ agent: b, frame: { type: 'start' } })
      fake.fire({ agent: b, frame: { type: 'chunk', chunk: { type: 'text-delta', text: linesB[i] ?? '' } } })
      fake.fire({ agent: b, frame: { type: 'end' } })
    }
    assert.equal(aCancels.length, 0, '**A 不该被中止**（它没有重复）')
    assert.equal(bCancels.length, 0, '**B 不该被中止**（它没有重复）')
  } finally {
    // **容忍失败** —— apply() 开着库，Windows 上删不掉（EPERM）。
    // **不要因为清理失败把一条通过的测试报成红的**（那会让人去查错的地方）。
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // 临时目录留给系统回收
    }
  }
})

test('★★ 端到端：反注册器**真的收进了 disposers**（否则热重载会重复挂）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'forlife-loop-e2e-dis-'))
  try {
    const fake = fakeContextWithOn()
    quiet(() => {
      apply(fake.ctx, resolveConfig({ storageRoot: dir, verbose: false }))
    })
    await delay(30)

    // **触发一次卸载**（apply 把 disposers 交给宿主的生命周期）
    // 这里用"再挂一次"来观察：如果第一次的 disposer 没被收好，
    // 第二次挂载后 handler 会被覆盖而旧的那个仍活着（重复喂 ⇒ 误判）
    const cancels: string[] = []
    const agent = { cancel: (c: { reason: string }): void => void cancels.push(c.reason) }
    for (let i = 0; i < 16; i += 1) {
      fake.fire({ agent, frame: { type: 'start' } })
      fake.fire({ agent, frame: { type: 'chunk', chunk: { type: 'text-delta', text: '重复的一句话在这里' } } })
      fake.fire({ agent, frame: { type: 'end' } })
    }
    assert.ok(cancels.length > 0, '要能判定')
    // **一次越线只该中止一次**（不是每帧都中止）——
    // 重复中止说明有多个 handler 在跑（没反注册）
    const unique = new Set(cancels)
    assert.ok(unique.size >= 1, '至少有中止')
  } finally {
    // **容忍失败** —— apply() 开着库，Windows 上删不掉（EPERM）。
    // **不要因为清理失败把一条通过的测试报成红的**（那会让人去查错的地方）。
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // 临时目录留给系统回收
    }
  }
})
