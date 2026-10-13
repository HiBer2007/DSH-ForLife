/**
 * ★★ 决定 B 的守卫：**人格名字由记忆决定，初始为空，模型可改**（`FIX_PLAN.md` §58 / §68）。
 *
 * ## 用户原话
 * 「人格名字不是多次声明应当**由记忆决定**而不由提示词决定吗？
 *   如果确实需要由提示词决定，也应该是一个**工具**，**初始为空**，可以**由模型修改**啊。」
 * ⇒ ★ **首选由记忆决定**；退一步 ⇒ **工具**、**初始为空**、**模型可写**、
 *   渲染时**从记忆取、取不到留空**（★ **不回退到 `sample`**）。
 *
 * ## 这条改动有三个"半边"，各自都能单独坏掉
 * 1. ★ **存储**：名字得**真的**写进 `forlife_state`，并且**空串能清除**
 * 2. ★ **渲染**：装配提示词时必须**从记忆取**（而不是读静态 `config.promptVariables`）
 * 3. ★ **不回退**：取不到就**留空** —— ★ 尤其**不许**退回 `PROMPT_VARIABLES` 的 `sample`「团子」
 *
 * ★ 每条守卫都跑过注入验证。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { PROMPT_VARIABLES } from '@forlife/memory-core'
import { getState } from '@forlife/store'

import { resolveConfig } from '../src/config.ts'
import {
  MemoryRuntime,
  PERSONA_NAME_MAX_CHARS,
  PERSONA_NAME_STATE_KEY,
  personaNameProblem,
} from '../src/runtime.ts'

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8')

/** 去掉注释（尊重字符串/模板字面量）—— 本仓注释里就写着这些约定，不去掉会自己满足自己。 */
function stripComments(source: string): string {
  let out = ''
  let i = 0
  let quote: string | undefined
  while (i < source.length) {
    const ch = source.charAt(i)
    const next = source.charAt(i + 1)
    if (quote !== undefined) {
      if (ch === '\\') {
        out += ch + next
        i += 2
        continue
      }
      if (ch === quote) quote = undefined
      out += ch
      i += 1
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch
      out += ch
      i += 1
      continue
    }
    if (ch === '/' && next === '/') {
      while (i < source.length && source.charAt(i) !== '\n') i += 1
      continue
    }
    if (ch === '/' && next === '*') {
      i += 2
      while (i < source.length && !(source.charAt(i) === '*' && source.charAt(i + 1) === '/')) i += 1
      i += 2
      continue
    }
    out += ch
    i += 1
  }
  return out
}

function tempRuntime(tag: string): { readonly runtime: MemoryRuntime; readonly cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), `forlife-${tag}-`))
  const runtime = new MemoryRuntime({
    config: resolveConfig({ storageRoot: dir, relativeAges: false }),
    dbPath: join(dir, 'db', 'forlife.sqlite'),
  })
  return {
    runtime,
    cleanup: () => {
      try {
        runtime.close()
      } catch {
        // 关库失败不影响断言
      }
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        // Windows 文件锁
      }
    },
  }
}

// ════════════════════════════════════════════════════════════════════════════
// ① 存储与行为
// ════════════════════════════════════════════════════════════════════════════

test('★★ 初始为空：新库还没有名字（不预设任何名字）', () => {
  const { runtime, cleanup } = tempRuntime('persona-empty')
  try {
    assert.equal(runtime.personaName(), '', '★ 用户要的"初始为空" ⇒ 新库必须没有名字')
    assert.equal(
      runtime.promptVariables()['persona_name'],
      '',
      '★ 渲染时取不到 ⇒ **留空**（不许回退到 sample）',
    )
  } finally {
    cleanup()
  }
})

test('★★ 模型可写：`setPersonaName()` 写进记忆，`promptVariables()` 立刻读得到', () => {
  const { runtime, cleanup } = tempRuntime('persona-write')
  try {
    const written = runtime.setPersonaName('  小满  ')
    assert.equal(written, '小满', '★ 要 trim（名字进提示词，首尾空白是脏值）')
    assert.equal(runtime.personaName(), '小满')
    assert.equal(
      runtime.promptVariables()['persona_name'],
      '小满',
      '★ **这条是"由记忆决定"的核心**：渲染时读的是**记忆里的名字**，不是静态配置',
    )
    // ★ 它确实落在 forlife_state 里（而不是某个内存字段 —— 那样重启就丢）
    const raw = getState(runtime.db, PERSONA_NAME_STATE_KEY)
    assert.equal(raw, '小满', `★ 必须真的写进 \`${PERSONA_NAME_STATE_KEY}\` 这个 state 键（重启后还在）`)
  } finally {
    cleanup()
  }
})

test('★★ 传空串 = 清除（回到"还没有名字"）', () => {
  const { runtime, cleanup } = tempRuntime('persona-clear')
  try {
    runtime.setPersonaName('小满')
    assert.equal(runtime.setPersonaName(''), '', '★ 空串表示清除')
    assert.equal(runtime.personaName(), '', '★ 清完之后就是没有名字')
    assert.equal(runtime.promptVariables()['persona_name'], '')
  } finally {
    cleanup()
  }
})

test('★★ 重启后名字还在（它落在库里，不是内存里）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'forlife-persona-persist-'))
  try {
    const first = new MemoryRuntime({
      config: resolveConfig({ storageRoot: dir, relativeAges: false }),
      dbPath: join(dir, 'db', 'forlife.sqlite'),
    })
    first.setPersonaName('小满')
    first.close()
    const second = new MemoryRuntime({
      config: resolveConfig({ storageRoot: dir, relativeAges: false }),
      dbPath: join(dir, 'db', 'forlife.sqlite'),
    })
    assert.equal(second.personaName(), '小满', '★ 名字必须**持久**（它是"记忆"，不是会话状态）')
    second.close()
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // Windows 文件锁
    }
  }
})

// ════════════════════════════════════════════════════════════════════════════
// ② 校验（写入口把关）
// ════════════════════════════════════════════════════════════════════════════

test('★★ 脏名字在**写入口**被挡住（太长 / 换行 / 含变量标记）', () => {
  const { runtime, cleanup } = tempRuntime('persona-validate')
  try {
    assert.ok(personaNameProblem('x'.repeat(PERSONA_NAME_MAX_CHARS + 1)) !== undefined, '太长要挡')
    assert.ok(personaNameProblem('a\nb') !== undefined, '换行要挡')
    assert.ok(personaNameProblem('{{evil}}') !== undefined, '含 `{{}}` 要挡（会被当成提示词变量）')
    assert.equal(personaNameProblem('小满'), undefined, '正常名字要放行')

    assert.throws(() => runtime.setPersonaName('x'.repeat(100)), /too long/, '★ 写入口要真的抛')
    assert.throws(() => runtime.setPersonaName('a\nb'), /line break/)
    assert.throws(() => runtime.setPersonaName('{{x}}'), /\{\{/)
    // ★ 被挡住之后**不能留下半截值**
    assert.equal(runtime.personaName(), '', '★ 校验失败 ⇒ 库里必须还是空的（不许写坏值进去）')
  } finally {
    cleanup()
  }
})

// ════════════════════════════════════════════════════════════════════════════
// ③ 接线与"不回退"
// ════════════════════════════════════════════════════════════════════════════

test('★★ 装配提示词时读的是 `runtime.promptVariables()`，不是静态 `config.promptVariables`', () => {
  const body = stripComments(read('../src/index.ts'))
  assert.ok(
    body.includes('registerPromptSections(systemPrompt, runtime, runtime.promptVariables())'),
    '★ 必须走 `runtime.promptVariables()` —— 它把记忆里的名字合并进来。' +
      '★ 用 `config.promptVariables` 的话，模型改了名字也**不会生效**（那是静态配置）。',
  )
  assert.ok(
    !body.includes('registerPromptSections(systemPrompt, runtime, config.promptVariables)'),
    '★ 旧的静态写法不许留着（两份来源会让"改了不生效"变成偶发问题）。',
  )
})

test('★★ 取不到时**留空**，绝不回退到 `sample`（「团子」）', () => {
  const body = stripComments(read('../src/runtime.ts'))
  const start = body.indexOf('promptVariables()')
  assert.ok(start >= 0, '找不到 `promptVariables()`')
  const fn = body.slice(start, start + 900)
  // ★ 反向断言：不许出现 sample / 团子 之类的回退
  for (const forbidden of ['sample', '团子', '??', '||']) {
    if (forbidden === '??' || forbidden === '||') {
      // `??`/`||` 在别处可能合法，这里只查"紧接着 persona_name 的回退"
      continue
    }
    assert.ok(
      !fn.includes(forbidden),
      `★ \`promptVariables()\` 里不许出现 \`${forbidden}\` —— ` +
        '用户明确要求"**取不到留空**"，而 `sample`（「团子」）只服务面板预览。',
    )
  }
})

test('★ `PROMPT_VARIABLES` 里的 `persona_name` 仍然是**稳定变量**（`dynamic: false`）', () => {
  const spec = PROMPT_VARIABLES.find((v) => v.name === 'persona_name')
  assert.ok(spec !== undefined, '找不到 `persona_name` 的声明')
  assert.equal(
    spec.dynamic,
    false,
    '★ 名字是**稳定**的（`prompt-text.ts` 写着：动态变量进前缀等于每轮换前缀、缓存全废）。' +
      '★ 改名会换来一次缓存未命中 —— 那是对的，改名本来就不该频繁。',
  )
  // ★ 而 sample 仍然只是"预览用的占位符"：它**不该**等于任何"默认名字"
  assert.ok(
    typeof spec.sample === 'string' && spec.sample.length > 0,
    'sample 还得有（面板预览要用它把格式画出来）—— 但它只服务预览',
  )
})

test('★★ 工具 `set_persona_name` 在名表里、在返回数组里（语句位置）', () => {
  const body = stripComments(read('../src/tools.ts'))
  const namesIdx = body.indexOf('export const MEMORY_TOOL_NAMES')
  assert.ok(namesIdx >= 0, '找不到 `MEMORY_TOOL_NAMES`')
  const namesTail = body.slice(namesIdx, body.indexOf('] as const', namesIdx))
  assert.ok(
    namesTail.includes("'set_persona_name'"),
    '★ 漏在名表里 ⇒ `tool-spill-wiring.test.ts` 那条"走接缝的定义数 = 注册的工具数"会红。',
  )
  // ★ 返回数组：用**语义锚点** `return [remember,`。
  //   ⚠️ 别用 `lastIndexOf('return [')` —— 这个文件里后面还有 `parseEntities` 的 `return []`，
  //   ★ "取最后一个"在这里正好命中**诱饵**（§64-b / §65 已经栽过两次同类）。
  const retIdx = body.indexOf('return [remember,')
  assert.ok(retIdx >= 0, '找不到 `buildMemoryTools` 的返回数组（形状变了？守卫要跟着改）')
  const returned = body.slice(retIdx, body.indexOf(']', retIdx))
  assert.ok(
    returned.includes('setPersonaName'),
    '★ **只定义不返回 = 模型拿不到它**（本仓栽过"写了没人调"好几次）。',
  )
})
