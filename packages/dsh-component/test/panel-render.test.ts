/**
 * 面板组件的**真实渲染**测试 —— 拿真服务端的真响应，把四个组件各渲染两遍。
 *
 * ## 为什么必须补这一层（我连着漏了两次的那一层）
 *
 * 1. 之前的测试测的是 `describeX(snapshot)` + `renderPanel()`，**绕过了组件本身**。
 *    `RoutesPanel` 恰恰是在**组件里**漏了 `renderPanel(jsx, …)`：它把 `node()` 造的
 *    **裸描述符**（`{type, props, children}` 这种纯数据）直接 `return` 给了 React。
 *    React 抛 "Objects are not valid as a React child"，宿主 `SlotErrorBoundary`
 *    把异常吞成 `<div data-slot-error>`，界面上只剩一片空白 ——
 *    而**所有旧测试全绿**。这个文件就是盯着这件事的。
 *
 * 2. 假的 React 只渲染**第一遍**（loading 态）。只在"数据到达后"那一遍出问题的
 *    代码路径永远测不到。这里用带**真 setter**、**真副作用队列**的替身，
 *    把第二遍也渲染出来，并按 React 的规矩检查 Hook 数量
 *    （Hook 数量变了 React 会抛 "Rendered more hooks than during the previous render"）。
 *
 * 3. 数据来自 `fixtures/panel-api.json`：从**正在运行的服务端**抓的真实响应
 *    （密钥类字段已脱敏）。测的是"它真收到的形状"，而不是"我以为的形状"。
 *
 * 附带说明：`element.__jsx` 那个戳是这套检查的支点。`node()` 永远造不出带戳的对象，
 * 所以"组件返回了裸描述符"这类错误**必然**被抓住，不存在"检查永远不失败"的假绿。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

/** 捕获到的模块定义。 */
let captured: { id: string; factory: (require: (id: string) => unknown) => unknown } | undefined

// 必须在 import 之前装好假的模块加载器（文件顶层就会调用它）
;(globalThis as unknown as { window: unknown }).window = {
  __ModuleLoader__: {
    load(definition: { id: string; factory: (require: (id: string) => unknown) => unknown }): void {
      captured = definition
    },
  },
}

await import('../client/index.js')

/** 从真实服务端抓的面板接口响应。 */
const FIXTURES = JSON.parse(
  readFileSync(new URL('./fixtures/panel-api.json', import.meta.url), 'utf8'),
) as Record<string, { status: number; payload: unknown }>

/**
 * HTML 空元素：React 不允许它们带 `children`（哪怕是个空数组）。
 * 替身必须照抄这条规则，否则"面板在浏览器里白屏、测试却全绿"会重演。
 */
const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
])

// ── 一个"会二次渲染"的 React 替身 ──────────────────────────────────────────

interface ReactRuntime {
  React: Record<string, unknown>
  /** 渲染一遍；Hook 数量与上一遍不一致就抛（同 React）。 */
  render: (component: () => unknown) => unknown
  /** 跑这一遍攒下的副作用（含 async 加载）。 */
  flush: () => void
  /** 跑副作用返回的清理函数（清掉轮询定时器，否则测试进程不退出）。 */
  dispose: () => void
}

function makeReact(): ReactRuntime {
  const slots: { value: unknown }[] = []
  let cursor = 0
  let hookCount: number | undefined
  let pending: (() => unknown)[] = []
  let cleanups: (() => void)[] = []

  /**
   * 每个 Hook 一个按调用序号定位的槽（与 React 的规则一致：靠调用顺序认身份）。
   * 传进来的 `make` 返回的是**值本身**，不是槽 —— 别套两层：
   * 我第一版写成 `use(() => ({ value: initial }))`，于是 `useState` 返回了
   * `{value: ''}` 这种包装对象，`if (notice)` 恒为真，把对象塞进 children 才把
   * 面板自己搞崩。**替身写错会冤枉被测代码**，所以这条注释留着。
   */
  const use = (make: () => unknown): { value: unknown } => {
    const index = cursor++
    const existing = slots[index]
    if (existing !== undefined) return existing
    const slot = { value: make() }
    slots[index] = slot
    return slot
  }

  const React = {
    useState(initial: unknown): [unknown, (next: unknown) => void] {
      const slot = use(() => (typeof initial === 'function' ? (initial as () => unknown)() : initial))
      const set = (next: unknown): void => {
        slot.value = typeof next === 'function' ? (next as (prev: unknown) => unknown)(slot.value) : next
      }
      return [slot.value, set]
    },
    useEffect(effect: () => unknown): void {
      use(() => effect)
      pending.push(effect)
    },
    useCallback(fn: unknown): unknown {
      return use(() => fn).value
    },
    useMemo(fn: () => unknown): unknown {
      return use(() => fn()).value
    },
  }

  return {
    React,
    render(component) {
      cursor = 0
      pending = []
      const out = component()
      if (hookCount !== undefined && hookCount !== cursor) {
        throw new Error(`Hook 数量从 ${hookCount} 变成 ${cursor}：React 会抛 "Rendered more hooks than during the previous render"`)
      }
      hookCount = cursor
      return out
    },
    flush() {
      const batch = pending
      pending = []
      for (const effect of batch) {
        const cleanup = effect()
        if (typeof cleanup === 'function') cleanups.push(cleanup as () => void)
      }
    },
    dispose() {
      for (const cleanup of cleanups) cleanup()
      cleanups = []
    },
  }
}

/** 让 `void load()` 里的 await 链跑完（fetch 是本地替身，几个宏任务足够）。 */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setTimeout(resolve, 0))
}

// ── 用真响应回放的 fetch 替身 ──────────────────────────────────────────────

function installFixtureFetch(): () => void {
  const original = globalThis.fetch
  globalThis.fetch = (async (input: unknown) => {
    const raw = typeof input === 'string' ? input : String((input as { url?: unknown } | null)?.url ?? input)
    const path = raw.replace(/^https?:\/\/[^/]+/, '')
    const fixture = FIXTURES[path]
    if (fixture === undefined) throw new Error(`夹具里没有这个路径（面板打了一个没抓过的接口）：${path}`)
    return {
      ok: fixture.status >= 200 && fixture.status < 300,
      status: fixture.status,
      json: async () => fixture.payload,
    }
  }) as unknown as typeof fetch
  return () => {
    globalThis.fetch = original
  }
}

interface PanelExports {
  MemoryPanel: () => unknown
  QqPanel: () => unknown
  PromptPanel: () => unknown
  RoutesPanel: () => unknown
  describeRoutes: (snapshot: unknown) => unknown
}

/** 用假 require 跑出真实导出（React 用上面那个会二次渲染的替身）。 */
function loadClientModule(runtime: ReactRuntime): { exports: PanelExports } {
  assert.ok(captured !== undefined, '客户端文件必须调用 window.__ModuleLoader__.load')
  const require = (id: string): unknown => {
    if (id === 'react') return runtime.React
    if (id === 'react/jsx-runtime') {
      return {
        // 与 react/jsx-runtime 同签名：第三参是 key，刻意忽略（子节点只认 props.children）
        // 元素形状也必须同构：{type, props}，**不是**把 props 摊平到根上
        jsx: (type: unknown, props: unknown): unknown => {
          // **忠实复刻 React 的空元素校验**。少了这一条，替身就会放过真 React 会拒绝的树：
          // 「QQ 与后台」「模型与路由」白屏的真因就是 `node('input', {…})` 带着
          // `children: []` 进了 React —— React 判的是 `props.children != null`，
          // 空数组不是 null，于是抛 Minified React error #137（args[]=input）。
          if (typeof type === 'string' && VOID_TAGS.has(type)) {
            const children = props === null || typeof props !== 'object' ? undefined : (props as { children?: unknown }).children
            if (children !== undefined && children !== null) {
              throw new Error(`Minified React error #137：<${type}> 是空元素（void tag），不能有 children`)
            }
          }
          return { type, props: Object.assign({}, props), __jsx: true }
        },
      }
    }
    throw new Error(`未预期的 require：${id}`)
  }
  return { exports: captured.factory(require) as PanelExports }
}

// ── 断言工具 ──────────────────────────────────────────────────────────────

/**
 * 断言这是 `jsx()` 造出来的 React 元素，而不是 `node()` 造的裸描述符。
 *
 * 支点是 `__jsx` 这个戳：`node()` 永远造不出来，所以错误必然被抓。
 */
function asReactElement(value: unknown, what: string): { type: unknown; props: Record<string, unknown> } {
  assert.ok(value !== null && typeof value === 'object', `${what}：组件必须返回元素对象，实际是 ${typeof value}`)
  const element = value as { type?: unknown; props?: unknown; children?: unknown; __jsx?: unknown }
  assert.equal(
    element.__jsx,
    true,
    `${what}：返回的不是 React 元素（裸描述符）。node() 造的 {type, props, children} 必须经 renderPanel(jsx, …) 包装，否则 React 抛 "Objects are not valid as a React child"`,
  )
  assert.equal(element.children, undefined, `${what}：裸描述符才有 children 数组；React 元素的子节点在 props.children`)
  assert.ok(
    typeof element.type === 'string' || typeof element.type === 'function',
    `${what}：type 必须是字符串或组件，实际是 ${typeof element.type}`,
  )
  return element as { type: unknown; props: Record<string, unknown> }
}

/** 把元素树里的文本抠出来（子节点在 props.children）。 */
function elementText(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number') return String(value)
  if (Array.isArray(value)) return value.map((child) => elementText(child)).join(' ')
  if (value === null || typeof value !== 'object') return ''
  const props = (value as { props?: { children?: unknown } }).props
  return props === undefined ? '' : elementText(props.children)
}

// ── 四条真渲染 ────────────────────────────────────────────────────────────

const PANELS = [
  { name: '记忆', key: 'MemoryPanel', floor: 40 },
  { name: 'QQ 与后台', key: 'QqPanel', floor: 300 },
  { name: '提示词', key: 'PromptPanel', floor: 300 },
  { name: '模型与路由', key: 'RoutesPanel', floor: 200 },
] as const

for (const panel of PANELS) {
  test(`组件真渲染：${panel.name} —— 两遍都必须是 React 元素，且数据到达后有内容`, async () => {
    const restore = installFixtureFetch()
    const runtime = makeReact()
    try {
      const { exports } = loadClientModule(runtime)
      const Component = exports[panel.key as keyof PanelExports]
      assert.equal(typeof Component, 'function', `exports.${panel.key} 必须是组件函数`)

      // 第一遍：loading 态（RoutesPanel 的 bug 有一半就在这个分支里）
      asReactElement(runtime.render(Component as () => unknown), `${panel.name}·第一遍（加载中）`)

      // 副作用 = 真去取数；等它落地再渲染第二遍
      runtime.flush()
      await settle()

      const second = asReactElement(runtime.render(Component as () => unknown), `${panel.name}·第二遍（数据到达）`)
      const text = elementText(second).replace(/\s+/g, ' ').trim()
      assert.ok(
        text.length >= panel.floor,
        `${panel.name} 在真实数据下应有内容（≥${panel.floor} 字），实际只有 ${text.length} 字：${text.slice(0, 200)}`,
      )
    } finally {
      runtime.dispose()
      restore()
    }
  })
}

test('自检：这套"必须是 React 元素"的检查抓得住裸描述符（免得它永远不失败）', () => {
  const runtime = makeReact()
  const { exports } = loadClientModule(runtime)
  // describeRoutes 返回的正是 node() 造的裸描述符 —— 组件**直接**返回它就会白屏
  const routesFixture = FIXTURES['/api/forlife/routes']
  assert.ok(routesFixture !== undefined, '夹具里必须有 /api/forlife/routes')
  const descriptor = exports.describeRoutes(routesFixture.payload)
  assert.throws(() => asReactElement(descriptor, '自检'), /裸描述符/)
})
