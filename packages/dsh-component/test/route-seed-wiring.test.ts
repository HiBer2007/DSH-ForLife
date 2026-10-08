import { readFileSync } from "node:fs"
import { test } from "node:test"
import assert from "node:assert/strict"

/**
 * ★ 路由表播种的**接线守卫**（第 8 次同一个模式之后加的）。
 *
 * ## 为什么需要它
 *
 * `model_routes`（档位 → 具体模型的唯一真源）有**两个**播种函数，
 * 而它们的接线状态曾经完全不同：
 *
 * | 函数 | 曾经 |
 * |---|---|
 * | `seedDefaultRoutes()` | ✅ 生产路径真的在调 |
 * | `seedOpenCodeGoRoutes()` | ❌ **生产路径零调用**（只有测试调） |
 *
 * ⇒ 后果：库里**永远停在**内置默认（`deepseek-official`），
 *   面板「路由」页看到的永远是旧的，而 `opencode-go` 接入点从没被播种过。
 *
 * **⇒ 这种"库代码写好了、单元测试过了、生产路径上零调用"的缺陷，**
 *   **单元测试永远抓不到** —— 因为单元测试**直接调那个函数**，绕过了接线。
 *
 * ## 这个测试怎么抓
 *
 * **读源码**，断言 `index.ts` 里**真的调了它**，且**在有 key 时才调**。
 * 它不好看，但它拦的正是"功能写好了、测试全绿、而线上根本没跑"。
 */
const SRC = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')

/** 去掉注释再判 —— 这个仓库栽过"grep 匹配到注释"的坑。 */
const code = SRC.split(/\r?\n/)
  .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
  .join('\n')

test('接线：index.ts 必须真的调 seedOpenCodeGoRoutes（不能只写不调）', () => {
  assert.match(
    code,
    /seedOpenCodeGoRoutes\(runtime\.db,/,
    '**seedOpenCodeGoRoutes 必须被生产路径调用** —— 否则路由表会永远停在内置播种（面板里看到的路由表永远是旧的）',
  )
})

test('接线：必须 import 它（而不是靠别处副作用）', () => {
  assert.match(code, /import \{[^}]*seedOpenCodeGoRoutes[^}]*\}/, 'seedOpenCodeGoRoutes 必须被 import')
})

test('接线：必须用 replace: true（否则"只补空表"⇒ 永远切不过去）', () => {
  assert.match(
    code,
    /seedOpenCodeGoRoutes\(runtime\.db, \{ replace: true/,
    '必须传 replace: true —— 默认的"只补空表"在有旧行时直接返回，切不到 opencode-go',
  )
})

test('接线：必须有 key 才切（不能无条件替换掉用户的内置配置）', () => {
  assert.match(code, /FORLIFE_OPENCODE_GO_KEY/, '要靠这个引用名判断"有没有 key"')
  // 断言它在 if 里（而不是无条件调用）
  const at = code.indexOf('seedOpenCodeGoRoutes(runtime.db,')
  const before = code.slice(Math.max(0, at - 400), at)
  assert.match(before, /if \(/, '调用必须在条件里 —— 没 key 时不该动路由表')
})
