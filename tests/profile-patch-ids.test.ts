/**
 * ★ **接线守卫**：profile patch 的 `id` 必须是 base bundle 里的**短 id**，不能是包名。
 *
 * ## 为什么要有这个测试（2026-10-08，第 17 处缺陷）
 *
 * `profiles/*​/cordis.patch.yml` 用 `- id: <X>` 定位 base bundle 里的条目。
 * 而 base bundle 的结构是：
 *
 * ```yaml
 * - id: llm-pi-ai                          # ← 短 id
 *   name: '@deepseek-ai/dsh-llm-pi-ai'     # ← 包名
 * ```
 *
 * **我们把包名当 id 用了**：
 *
 * ```yaml
 * - id: '@deepseek-ai/dsh-llm-pi-ai'       # ❌ 找不到这个 id
 *   config: { providers: { opencode-go: … } }
 * ```
 *
 * ## 失效方式是**静默**的（这才是它藏了这么久的原因）
 *
 * dsh 只在 `--dump-config` 时才打一行：
 *
 * ```
 * dsh: [<profile>/cordis.patch.yml] patch: entry "@deepseek-ai/dsh-llm-pi-ai" not found
 * ```
 *
 * **正常启动一个字都不说** —— 那段 patch 被整段丢弃，
 * **而插件照常加载、容器照常 healthy**（又一个"起来了 ≠ 能用"）。
 *
 * ## 后果（真发生过，靠探针才挖出来）
 *
 * - `opencode-go` 这个 provider **从没注册上过**
 *   （探针实测：`providers=2(deepseek-official, deepseek-account)`）
 * - `agent-default-model` 的配置没生效
 *   （探针实测：`current=deepseek-official/deepseek-flash`，而 patch 里写的是 `opencode-go`）
 * - ⇒ **库里那 11 行 `opencode-go` 路由全是"DSH 调不到"的死候选**
 *
 * ## 这个测试拦什么
 *
 * ① **不许**把 `'@…'`（包名）当 `id` 用 —— 那正是这次的错
 * ② **必须**用的是短 id（不含 `@`、不含 `/`）
 * ③ 用到的 id **要么在已知 base id 清单里**，**要么是本文件自己 `insert` 的**
 * ④ **回归守卫**：patch 里提到 `dsh-llm-pi-ai` / `dsh-agent-default-model` 时，
 *    必须**同时**出现对应的短 id
 */
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

/** 仓库根。 */
const ROOT = fileURLToPath(new URL('..', import.meta.url))

/**
 * base bundle 里**已知的短 id**（从 `dsh --profile <p> --dump-config` 的输出里抄来的）。
 *
 * ⚠️ 这份清单**不要求完整** —— 它的作用是「拦住明显写错的」。
 * 新用到一个不在清单里的 id 时，**把它加进来**（那是「我知道自己在定位谁」的确认动作）。
 */
const KNOWN_BASE_IDS = new Set([
  'agent',
  'agent-default-model',
  'authorization',
  'compaction-basic',
  'config-editor',
  'credentials',
  'deepseek-account',
  'deepseek-llm-api-extensions',
  'hmr',
  'jobs',
  'llm',
  'llm-pi-ai',
  'llm-retry',
  'plugin-manager',
  'session',
  'session-title',
  'session-title-llm',
  'settings',
  'storage',
  'time-context',
  'timer',
  'tool-plugin-manager',
  'typert',
  'ui-settings-general',
  'user-questions',
])

/** 读一个 profile 的 patch（没有就返回 `undefined`）。 */
function readPatch(profile: string): string | undefined {
  try {
    return readFileSync(join(ROOT, 'profiles', profile, 'cordis.patch.yml'), 'utf8')
  } catch {
    return undefined
  }
}

/** 从 patch 里抽出所有 `- id: <X>`（去掉引号）。 */
function extractIds(src: string): { readonly line: number; readonly id: string }[] {
  const out: { line: number; id: string }[] = []
  const lines = src.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    // ★ **只认缩进 0**：patch 的顶层条目。嵌套的 `- id:` 是 provider 的 models 列表里的模型名，不是 patch 目标。
    const m = /^-\s*id:\s*'?"?([^'"\s]+)'?"?\s*$/.exec(lines[i] ?? '')
    if (m?.[1] !== undefined) out.push({ line: i + 1, id: m[1] })
  }
  return out
}

/**
 * 该 patch **自己带来的** id（它们不需要在 base bundle 里存在）。
 *
 * ## 判据：**看有没有 name:**
 *
 * patch 里顶层 `- id: X` 有两种截然不同的含义：
 *
 * ```yaml
 * # ① 定位 base 里的条目 —— **只带 config**（没有 name）⇒ X 必须在 base 里存在
 * - id: llm-pi-ai
 *   config: { providers: { … } }
 *
 * # ② 新增一个插件 —— **带 name** ⇒ X 是我们自己起的，base 里当然没有
 * - id: forlife-memory
 *   name: forlife-memory
 *   config: { … }
 * ```
 *
 * **★ 混淆这两者正是这次缺陷的根源**（拿包名当 ① 的 id ⇒ 静默丢弃）。
 * ⇒ 这里也按同一个判据区分：**有 name 的算「新增」，没有的算「定位」**。
 *
 * 另外 `- insert:` 下面嵌套的条目当然也算「新增」。
 */
function ownIds(src: string): Set<string> {
  const out = new Set<string>()
  const lines = src.split(/\r?\n/)

  // ── ① insert: 下面的嵌套条目
  let inInsert = false
  let insertIndent = 0
  for (const line of lines) {
    const trimmed = line.trim()
    if (/^-\s*insert:\s*$/.test(trimmed)) {
      inInsert = true
      insertIndent = line.length - line.trimStart().length
      continue
    }
    if (!inInsert) continue
    const indent = line.length - line.trimStart().length
    if (trimmed !== '' && indent <= insertIndent) {
      inInsert = false
      continue
    }
    const m = /^-\s*id:\s*'?"?([^'"\s]+)'?"?\s*$/.exec(trimmed)
    if (m?.[1] !== undefined) out.add(m[1])
  }

  // ── ② 顶层 `- id: X` 且**同一个条目里有 name:** ⇒ 新增
  for (let i = 0; i < lines.length; i++) {
    const m = /^-\s*id:\s*'?"?([^'"\s]+)'?"?\s*$/.exec(lines[i] ?? '')
    if (m?.[1] === undefined) continue
    let hasName = false
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j] ?? ''
      if (/^-\s/.test(line)) break
      if (/^\s+name:\s*\S/.test(line)) { hasName = true; break }
    }
    if (hasName) out.add(m[1])
  }

  return out
}

/** 仓库里的所有 profile（有 patch 的）。 */
const PROFILES = readdirSync(join(ROOT, 'profiles'), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .filter((name) => readPatch(name) !== undefined)
  .sort()

test('至少扫到 2 个 profile（否则这个测试等于没跑）', () => {
  assert.ok(PROFILES.length >= 2, `只扫到 ${String(PROFILES.length)} 个 profile：${PROFILES.join(', ')}`)
})

for (const profile of PROFILES) {
  test(`${profile}：不许把包名当 patch 的 id`, () => {
    const src = readPatch(profile)
    assert.ok(src !== undefined)
    const bad = extractIds(src).filter((entry) => entry.id.startsWith('@') || entry.id.includes('/'))
    assert.deepEqual(
      bad.map((entry) => `L${String(entry.line)}: ${entry.id}`),
      [],
      'patch 用「- id: <包名>」定位是**静默失效**的（只在 --dump-config 时警告）。' +
        'base bundle 的结构是「id: <短名>」+「name: <包名>」，这里要写短名。',
    )
  })

  test(`${profile}：用到的 id 要么是已知 base id，要么是本文件自己新增的`, () => {
    const src = readPatch(profile) ?? ''
    const own = ownIds(src)
    const unknown = extractIds(src).filter((entry) => !KNOWN_BASE_IDS.has(entry.id) && !own.has(entry.id))
    assert.deepEqual(
      unknown.map((entry) => `L${String(entry.line)}: ${entry.id}`),
      [],
      '出现了不在已知 base id 清单里的 id。若它确实在 base 里，请加进 KNOWN_BASE_IDS；' +
        '若是本 profile 自己 insert 的，请确认它确实在 base 里（有 name 的条目会被 ownIds() 认作新增）。',
    )
  })

  test(`${profile}：★ 提到 llm-pi-ai / agent-default-model 就必须用短 id 定位（回归守卫）`, () => {
    const src = readPatch(profile) ?? ''
    const ids = extractIds(src).map((entry) => entry.id)
    if (src.includes('dsh-llm-pi-ai')) {
      assert.ok(
        ids.includes('llm-pi-ai'),
        'patch 里提到了 dsh-llm-pi-ai，就必须有「- id: llm-pi-ai」—— 否则 providers 那段会被整段丢弃。',
      )
    }
    if (src.includes('dsh-agent-default-model')) {
      assert.ok(
        ids.includes('agent-default-model'),
        'patch 里提到了 dsh-agent-default-model，就必须有「- id: agent-default-model」。',
      )
    }
  })
}
