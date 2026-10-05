/**
 * 插件接线测试：用**假上下文**驱动 `apply()`，覆盖真实宿主里难以构造的分支。
 *
 * 真实 DSH 服务的端到端断言在 `harness.test.ts`；这里补的是"宿主服务缺失/异常时我们怎么办"：
 *  - 没有 `systemPrompt` → 只写库、不注册提示段，并且**明确喊出来**（不能静默失效）；
 *  - 没有 `tools` → 不注册工具，但仍开库；
 *  - 没有 `connection` → 不注册面板接口，其它能力照常；
 *  - 存储打不开 → 视为**系统性故障**：报错、不抛异常、不注册任何能力；
 *  - 反注册时 → 库被关闭、运行时登记表被清理（不留悬挂连接）。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'

import { activeRuntimes, apply, resolveDshHome } from '../src/index.ts'
import { resolveConfig } from '../src/config.ts'
import { L2_NAME, L3_NAME, L2_ORDER, L3_ORDER } from '../src/prompt.ts'
import { MEMORY_TOOL_NAMES } from '../src/tools.ts'

interface Recorded {
  readonly sections: { name: string; order: number; text: unknown }[];
  readonly tools: string[];
  readonly routes: { path: string; methods: readonly string[]; requestBody: string }[];
  readonly effects: (() => void)[];
}

/** 构造一个假宿主上下文。 */
function fakeContext(options: { systemPrompt?: boolean; tools?: boolean; connection?: boolean } = {}): {
  ctx: never
  recorded: Recorded
} {
  const recorded: Recorded = { sections: [], tools: [], routes: [], effects: [] }
  const scoped: Record<string, unknown> = {}
  if (options.connection === true) {
    scoped.connection = {
      fetch: {
        register(route: { path: string; methods: readonly string[]; requestBody: string }): () => Promise<void> {
          recorded.routes.push({ path: route.path, methods: route.methods, requestBody: route.requestBody })
          return async (): Promise<void> => {}
        },
      },
    }
  }
  const ctx = {
    get(name: string): unknown {
      if (name === 'systemPrompt' && options.systemPrompt === true) {
        return {
          section(section: { name: string; order: number; text: unknown }): () => void {
            recorded.sections.push(section)
            return (): void => {}
          },
        }
      }
      if (name === 'tools' && options.tools === true) {
        return {
          register(definition: { name: string }): () => void {
            recorded.tools.push(definition.name)
            return (): void => {}
          },
        }
      }
      return undefined
    },
    inject(names: string[], callback: (c: unknown) => void): void {
      if (names.includes('connection') && options.connection === true) callback({ get: (n: string) => scoped[n] })
    },
    /**
     * 忠实模拟 cordis 的 `ctx.effect` 语义：**先调用回调**，把它**返回的** disposer 记下来，
     * 由宿主在卸载时调用。
     *
     * （第一版替身只存了回调本身、直接调用它 —— 结果 `() => cleanup` 只是"返回 cleanup"
     *   而从未执行，测试因此红了却指向错误的地方。替身必须与真实契约一致。）
     */
    effect(callback: () => void | (() => void)): void {
      const disposer = callback()
      if (typeof disposer === 'function') recorded.effects.push(disposer as () => void)
    },
  }
  return { ctx: ctx as never, recorded }
}

/** 安静的日志捕获（apply 会往 stdout 说话）。 */
function quiet<T>(fn: () => T): T {
  const original = console.log
  console.log = (): void => {}
  try {
    return fn()
  } finally {
    console.log = original
  }
}

test('接线：完整宿主下注册 2 个提示段 + 4 个工具 + 5 条面板路由', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'forlife-wire-'))
  try {
    const base = activeRuntimes().length
    const { ctx, recorded } = fakeContext({ systemPrompt: true, tools: true, connection: true })
    quiet(() => {
      apply(ctx, resolveConfig({ storageRoot: dir, verbose: false }))
    })
    await delay(30)

    assert.deepEqual(
      recorded.sections.map((s) => s.name).sort(),
      [L2_NAME, L3_NAME].sort(),
      '必须注册 L2 / L3 两个提示段',
    )
    assert.equal(recorded.sections.find((s) => s.name === L2_NAME)?.order, L2_ORDER)
    assert.equal(recorded.sections.find((s) => s.name === L3_NAME)?.order, L3_ORDER)

    assert.deepEqual(recorded.tools.sort(), [...MEMORY_TOOL_NAMES].sort(), '必须注册四个记忆工具')

    assert.deepEqual(
      recorded.routes.map((r) => r.path).sort(),
      ['/forlife/compaction', '/forlife/entries', '/forlife/health', '/forlife/spills', '/forlife/state'],
    )
    for (const route of recorded.routes) {
      assert.deepEqual(route.methods, ['GET'])
      assert.equal(route.requestBody, 'buffered', '面板接口是只读小响应，用 buffered')
    }

    assert.equal(activeRuntimes().length, base + 1, '运行时必须登记（面板/诊断靠它取）')

    // 反注册：库要关掉、登记表要清理
    assert.equal(recorded.effects.length, 1, '必须注册一个收尾 effect')
    recorded.effects[0]?.()
    await delay(20)
    assert.equal(activeRuntimes().length, base, '收尾后不得留下悬挂运行时')
  } finally {
    await cleanup(dir)
  }
})

test('降级：没有 systemPrompt / tools / connection 时不抛错，仍能开库', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'forlife-wire-bare-'))
  try {
    const base = activeRuntimes().length
    const { ctx, recorded } = fakeContext({})
    quiet(() => {
      apply(ctx, resolveConfig({ storageRoot: dir }))
    })
    await delay(20)
    assert.deepEqual(recorded.sections, [], '没有 systemPrompt 就不该注册段落')
    assert.deepEqual(recorded.tools, [], '没有 tools 就不该注册工具')
    assert.deepEqual(recorded.routes, [], '没有 connection 就不该注册面板接口')
    assert.equal(activeRuntimes().length, base + 1, '但库仍要打开（记忆写入不受宿主能力影响）')
    recorded.effects[0]?.()
  } finally {
    await cleanup(dir)
  }
})

test('故障：存储打不开时视为系统性故障 —— 不抛异常、不注册任何能力', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'forlife-wire-fail-'))
  try {
    // 用一个**文件**占住数据库路径，让 mkdir/open 必然失败
    const blocked = join(dir, 'blocked.sqlite')
    writeFileSync(blocked, 'not a directory')
    const base = activeRuntimes().length
    const { ctx, recorded } = fakeContext({ systemPrompt: true, tools: true, connection: true })

    const messages: string[] = []
    const original = console.log
    console.log = (...args: unknown[]): void => {
      messages.push(args.join(' '))
    }
    try {
      apply(ctx, resolveConfig({ storageRoot: join(blocked, 'sub'), dbFile: 'x.sqlite' }))
    } finally {
      console.log = original
    }

    assert.equal(recorded.sections.length, 0, '存储失败时不得注册提示段')
    assert.equal(recorded.tools.length, 0, '存储失败时不得注册工具')
    assert.equal(activeRuntimes().length, base)
    assert.ok(
      messages.some((m) => m.includes('记忆库打开失败')),
      `必须显式报出系统性故障，实际日志：${messages.join(' | ')}`,
    )
  } finally {
    await cleanup(dir)
  }
})

test('DSH_HOME 解析：环境变量优先，且不写宿主默认目录', () => {
  assert.equal(resolveDshHome({ DSH_HOME: 'D:\\isolated' }), 'D:\\isolated')
  const relative = resolveDshHome({ DSH_HOME: 'relative-home' })
  assert.ok(relative.endsWith('relative-home'), '相对路径按 cwd 解析')
  const fallback = resolveDshHome({})
  assert.ok(fallback.endsWith('.dsh'), '没有环境变量时才回落到宿主默认目录（只读场景）')
})

async function cleanup(dir: string): Promise<void> {
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true })
      return
    } catch {
      await delay(40)
    }
  }
}


