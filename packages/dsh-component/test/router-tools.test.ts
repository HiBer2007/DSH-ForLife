/**
 * 路由工具的测试（阶段 5 交付物 10 的工具面）。
 *
 * 守三件：
 *  - `switch_model` 必须**给理由**、受冷却与预算限制、且**只能往上**（往下切是省成本，该由自动判定做）；
 *  - 覆盖**可撤销**（revert_model）；
 *  - **子代理连工具都拿不到**（第一道防线：不是"调了会报错"，而是"根本没有"）。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { after, before, test } from 'node:test'

import { defineTool } from '@deepseek-ai/dsh-tools'
import { listRoutingLog, openDatabase } from '@forlife/store'

import { resolveConfig } from '../src/config.ts'
import { buildRouterTools, ROUTER_TOOL_NAMES } from '../src/router-tools.ts'
import { MemoryRuntime } from '../src/runtime.ts'

const dir = mkdtempSync(join(tmpdir(), 'forlife-rtools-'))
let runtime: MemoryRuntime

before(() => {
  openDatabase({ file: join(dir, 'seed.sqlite') }).close()
  runtime = new MemoryRuntime({ config: resolveConfig({ storageRoot: dir }), dbPath: join(dir, 'forlife.sqlite') })
})

after(async () => {
  runtime.close()
  for (let i = 0; i < 6; i++) {
    try {
      rmSync(dir, { recursive: true, force: true })
      return
    } catch {
      await delay(40)
    }
  }
})

/** 取一个工具。 */
function tool(name: string, options: { readonly isSubagent?: boolean } = {}): { execute(args: unknown, exec: unknown): Promise<unknown> } {
  const tools = buildRouterTools(defineTool as never, runtime, options) as unknown as {
    name: string
    execute(args: unknown, exec: unknown): Promise<unknown>
  }[]
  const found = tools.find((item) => item.name === name)
  assert.ok(found !== undefined, `工具 ${name} 不存在`)
  return found
}

const exec = { callId: 'c1', signal: new AbortController().signal }

/**
 * 用一个**全新 runtime** 跑一段测试。
 *
 * 为什么需要：切换有冷却与每小时预算，它们读的是 `routing_log` 里的历史 ——
 * 共用 runtime 会让测试之间**通过数据库互相影响**（前一个测试切过一次，
 * 后一个测试就被冷却拦住）。这种顺序依赖是坏味道：测试单独跑会过，一起跑就红。
 *
 * @param fn - 测试体。
 */
async function withFreshRuntime(fn: (fresh: MemoryRuntime, toolOf: (name: string) => { execute(args: unknown, exec: unknown): Promise<unknown> }) => Promise<void>): Promise<void> {
  const scratch = mkdtempSync(join(tmpdir(), 'forlife-rtools-fresh-'))
  openDatabase({ file: join(scratch, 'seed.sqlite') }).close()
  const fresh = new MemoryRuntime({ config: resolveConfig({ storageRoot: scratch, verbose: false }), dbPath: join(scratch, 'forlife.sqlite') })
  try {
    const toolOf = (name: string): { execute(args: unknown, exec: unknown): Promise<unknown> } => {
      const tools = buildRouterTools(defineTool as never, fresh) as unknown as {
        name: string
        execute(args: unknown, exec: unknown): Promise<unknown>
      }[]
      const found = tools.find((item) => item.name === name)
      assert.ok(found !== undefined, `工具 ${name} 不存在`)
      return found
    }
    await fn(fresh, toolOf)
  } finally {
    fresh.close()
    for (let i = 0; i < 6; i++) {
      try {
        rmSync(scratch, { recursive: true, force: true })
        break
      } catch {
        await delay(40)
      }
    }
  }
}

test('工具清单：主代理有三个，**子代理一个都没有**（第一道防线）', () => {
  const main = buildRouterTools(defineTool as never, runtime) as unknown as { name: string }[]
  assert.deepEqual(main.map((item) => item.name).sort(), [...ROUTER_TOOL_NAMES].sort())
  const sub = buildRouterTools(defineTool as never, runtime, { isSubagent: true })
  assert.deepEqual(sub, [], '子代理连工具都拿不到 —— 不是"调了会报错"，而是"根本没有"')
})

test('switch_model：理由太短会被拒（那看起来像随手切的）', async () => {
  const result = (await tool('switch_model').execute({ tier: 'L3', reason: '换' }, exec)) as Record<string, unknown>
  assert.equal(result['ok'], false)
  assert.match(String(result['note']), /理由太短/)
  assert.equal(runtime.tierOverride(), undefined, '被拒时不该改变状态')
})

test('switch_model：正常切换生效、留痕，并且**只能往上**', async () => {
  const result = (await tool('switch_model').execute({ tier: 'L3', reason: '这个架构问题超出当前能力，委派也解决不了' }, exec)) as Record<string, unknown>
  assert.equal(result['ok'], true)
  assert.equal(result['tier'], 'L3')
  assert.match(String(result['note']), /作废.*上下文缓存/, '要说清代价（否则模型会随手切）')
  assert.equal(runtime.tierOverride()?.tier, 'L3')

  // 已经最高档 ⇒ 不能再往上
  const again = (await tool('switch_model').execute({ tier: 'L3', reason: '我还想再强一点' }, exec)) as Record<string, unknown>
  assert.equal(again['ok'], false)

  // 留痕：routing_log 里要有 switched=1 的行
  const rows = listRoutingLog(runtime.db, 20)
  assert.ok(rows.some((row) => row['switched'] === 1 && row['source'] === 'switch'), '切换必须落 routing_log')
})

test('switch_model：冷却期内再切会被拦，且拦的原因写进日志', async () => {
  await withFreshRuntime(async (fresh, toolOf) => {
    const first = (await toolOf('switch_model').execute({ tier: 'L2', reason: '先切到中等档试试看' }, exec)) as Record<string, unknown>
    assert.equal(first['ok'], true)
    assert.equal(fresh.tierOverride()?.tier, 'L2')

    const second = (await toolOf('switch_model').execute({ tier: 'L3', reason: '立刻再往上切一档看看' }, exec)) as Record<string, unknown>
    assert.equal(second['ok'], false)
    assert.match(String(second['note']), /冷却中/)
    assert.ok(Number(second['cooldownRemainingMs']) > 0)
    assert.ok(listRoutingLog(fresh.db, 20).some((row) => row['source'] === 'switch-refused'), '被拒也要留痕（排障时最关心"为什么没切成"）')
  })
})

test('revert_model：撤销覆盖，回到自动判定', async () => {
  await withFreshRuntime(async (fresh, toolOf) => {
    // 自己造出"已切换"的状态，不依赖别的测试留下的东西
    const switched = (await toolOf('switch_model').execute({ tier: 'L3', reason: '这个任务确实超出当前能力' }, exec)) as Record<string, unknown>
    assert.equal(switched['ok'], true)
    assert.ok(fresh.tierOverride() !== undefined)

    const result = (await toolOf('revert_model').execute({}, exec)) as Record<string, unknown>
    assert.equal(result['ok'], true)
    assert.match(String(result['note']), /回到自动判定/)
    assert.equal(fresh.tierOverride(), undefined)

    // 没有覆盖时撤销要如实说（而不是假装成功）
    const again = (await toolOf('revert_model').execute({}, exec)) as Record<string, unknown>
    assert.equal(again['ok'], false)
    assert.match(String(again['note']), /没有手动切换过/)
  })
})

test('router_status：能看出档位来源、角色分配与最近降级次数（auto 与 override 两种都要对）', async () => {
  await withFreshRuntime(async (fresh, toolOf) => {
    // 没有覆盖 ⇒ auto
    const auto = (await toolOf('router_status').execute({}, exec)) as Record<string, unknown>
    assert.equal(auto['ok'], true)
    assert.equal(auto['source'], 'auto')
    assert.ok(Array.isArray(auto['routes']))
    assert.ok(typeof auto['recentDegraded'] === 'number')
    assert.equal(auto['reason'], undefined, 'auto 时不该有理由')

    // 手动切换后 ⇒ override，并且把**理由**带出来（排障要知道"谁为了什么切的"）
    await toolOf('switch_model').execute({ tier: 'L3', reason: '这个复盘任务需要更强的模型' }, exec)
    const override = (await toolOf('router_status').execute({}, exec)) as Record<string, unknown>
    assert.equal(override['source'], 'override')
    assert.equal(override['tier'], 'L3')
    assert.match(String(override['reason']), /复盘任务/)
    void fresh
  })
})



