/**
 * ★★★ **独立插件**这件事的守卫：它真的能**脱离记忆模块**单独装。
 *
 * ## 为什么这条最重要
 *
 * 用户 2026-10-11 的裁定是「最好把防止死循环的功能**单独提取出来**
 * 而不是和 memory 模块合并，**他是独立的模型输出监控工具**」。
 *
 * 而"独立"是**能被悄悄破坏**的性质：
 *  - 有人 import 一个 `@forlife/store`（⇒ 想要守卫就得背上 SQLite + 数据目录）；
 *  - 有人往 `package.json` 加一个依赖；
 *  - 有人把 `cordis.patch.yml` 的 id 写成 `loop-guard`
 *    （⇒ 与官方 `@mrweicodes/dsh-loop-guard` **撞 id**，谁覆盖谁看加载顺序）。
 *
 * ⇒ 这四条各配一条断言。**判据都是可观察的**（读文件 + 真 `apply()`）。
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { apply, inject, name } from '../src/index.ts'
import { installLoopGuard } from '../src/install.ts'

const packageDir = fileURLToPath(new URL('../', import.meta.url))

/** 安静的 `apply`（它会往 stdout 说话）。 */
function quiet<T>(fn: () => T): T {
  const original = console.log
  console.log = (): void => {}
  try {
    return fn()
  } finally {
    console.log = original
  }
}

/** 假 ctx：每个事件存一个 handler 列表。 */
function fakeCtx(): { ctx: unknown; events: string[]; fireEvent: (event: string, ...args: unknown[]) => void } {
  const events: string[] = []
  const handlers = new Map<string, ((...args: unknown[]) => void)[]>()
  return {
    events,
    fireEvent: (event, ...args) => {
      for (const handler of handlers.get(event) ?? []) handler(...args)
    },
    ctx: {
      on: (event: string, handler: (...args: unknown[]) => void) => {
        events.push(event)
        const list = handlers.get(event) ?? []
        list.push(handler)
        handlers.set(event, list)
        return () => {}
      },
    },
  }
}

/** 去注释（本仓注释写得很细 —— 不去注释的话"零依赖"这类断言会被自己的说明文字满足）。 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/gm, '$1')
}

test('★★ 插件名是 `forlife-loop-guard`，且**一个服务都不 inject**', () => {
  assert.equal(name, 'forlife-loop-guard', '宿主的 loader 诊断会用到这个名字')
  assert.deepEqual(inject, [], '**零依赖就体现在这里**：不等任何宿主服务')
})

test('★★★ 真 `apply()` ⇒ 两条腿都挂上（独立装载也能干活）', () => {
  const fake = fakeCtx()
  const result = quiet(() => apply(fake.ctx))
  // ★ `apply` 还会往宿主生命周期上挂一条 `dispose`（用于反注册）——
  //   断言两条腿时要把它排除掉，否则这条测试会在意一个无关的细节。
  const legs = fake.events.filter((event) => event !== 'dispose')
  assert.deepEqual(legs, ['agent/assistant-stream', 'session/event'], '**两条腿各一条订阅**')
  assert.ok(fake.events.includes('dispose'), '生命周期钩子也要挂（否则热重载会重复挂）')
  assert.deepEqual(
    { mounted: result.mounted, text: result.text, tool: result.tool },
    { mounted: true, text: true, tool: true },
  )
})

test('★★★ 真 `apply()` ⇒ 工具死循环**真的中止本轮**（不靠记忆模块的任何东西）', () => {
  const fake = fakeCtx()
  quiet(() => apply(fake.ctx))
  const cancels: string[] = []
  const agent = { id: 's-独立', cancel: (c: { kind: string; reason: string }): void => void cancels.push(`${c.kind}:${c.reason}`) }
  fake.fireEvent('agent/assistant-stream', { agent, frame: { type: 'start' } })
  for (let i = 0; i < 12; i += 1) {
    fake.fireEvent('session/event', { id: 's-独立' }, { type: 'tool/call', name: 'read_file', arguments: '{"path":"a.ts"}' })
  }
  assert.ok(cancels.length > 0, '**独立装载时工具腿必须也能中止**')
  assert.match(cancels[0] ?? '', /^hook:/)
})

test('★★★ 零依赖：`package.json` 里**没有** `dependencies`', () => {
  const pkg = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>
  }
  assert.equal(
    pkg.dependencies,
    undefined,
    '**一旦有依赖，"想要守卫就得背上那一坨"就会重新发生**',
  )
})

test('★★★ 零依赖：`src/` 下**没有**任何对外 import（只许相对路径）', () => {
  const srcDir = join(packageDir, 'src')
  const offenders: string[] = []
  for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.ts')) continue
    // ★ **必须去注释**：模块头里就写着"别的插件用 `import ... from '@forlife/loop-guard'`"
    //   —— 不去注释的话，这条断言会被那句说明自己满足（本仓栽过这类假绿）
    const source = stripComments(readFileSync(join(srcDir, entry.name), 'utf8'))
    for (const match of source.matchAll(/from\s+'([^']+)'/g)) {
      const specifier = match[1] ?? ''
      if (!specifier.startsWith('.')) offenders.push(`${entry.name} → ${specifier}`)
    }
  }
  assert.deepEqual(offenders, [], '**包外的一切 import 都会把它重新绑回某个系统**')
})

test('★★ `cordis.patch.yml` 的 id 是 `forlife-loop-guard`（**不能**叫 `loop-guard`）', () => {
  const patch = readFileSync(join(packageDir, 'cordis.patch.yml'), 'utf8')
  assert.match(patch, /id:\s*forlife-loop-guard/, 'id 必须是这个（否则与官方那个撞）')
  assert.doesNotMatch(patch, /^\s*id:\s*loop-guard\s*$/m, '**不许用官方那支的 id**（会互相覆盖）')
  assert.match(patch, /name:\s*'@forlife\/loop-guard'/, '要指向本包')
})

test('★★ `package.json` 的 bundle 补丁指向**真实存在的文件**（否则 profile 装载会静默少一行）', () => {
  const pkg = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as {
    dsh?: { bundle?: { patch?: string } }
    exports?: Record<string, string>
  }
  const patch = pkg.dsh?.bundle?.patch
  assert.equal(typeof patch, 'string', '`dsh.bundle.patch` 是"能被装成 bundle"的唯一凭据')
  assert.ok(existsSync(join(packageDir, patch ?? '')), `补丁文件不存在：${patch ?? ''}`)
  const entry = pkg.exports?.['.'] ?? ''
  assert.ok(existsSync(join(packageDir, entry)), `入口不存在：${entry}`)
})

test('★ 同一个 ctx 上 `installLoopGuard` 与 `apply` 不会各挂一套（去重生效）', () => {
  const fake = fakeCtx()
  quiet(() => apply(fake.ctx))
  const before = fake.events.length
  const second = installLoopGuard(fake.ctx, { log: () => {}, always: () => {}, disposers: [] })
  assert.equal(second.reason, 'already-mounted', '**apply 走过的 ctx，库调用不该再挂一遍**')
  assert.equal(fake.events.length, before, '**一条订阅都不该新增**')
})
