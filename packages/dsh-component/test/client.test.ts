/**
 * 面板客户端的测试 —— **测的就是要发布的那份文件**。
 *
 * 手法：在 Node 里装一个假的 `window.__ModuleLoader__` 捕获模块定义，
 * 再用假的 `require` 提供最小 React，然后拿真实的 `factory` 跑起来。
 * 这样不搭浏览器、不搭打包器，也能断言：
 *  - 加载契约（`load({id, factory})`）与导出形状（`apply` / `inject`）；
 *  - 注册契约（`slots.inject('settings.section', …)` + register 选项）；
 *  - 渲染内容（给一份快照，它画出哪些行/指标/告警）；
 *  - 取数路径与失败降级（HTTP 不 ok 时进 `error` 而不是抛）。
 */
import assert from 'node:assert/strict'
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

/** 假 React：只提供面板用到的那几个。 */
function fakeReact(): { React: unknown; jsxCalls: { type: string; props: unknown }[] } {
  const jsxCalls: { type: string; props: unknown }[] = []
  const React = {
    useState(initial: unknown): [unknown, (v: unknown) => void] {
      return [initial, () => {}]
    },
    useEffect(): void {
      // 不在测试里执行副作用
    },
  }
  return { React, jsxCalls }
}

/** 用假 require 跑出真实导出。 */
function loadClientModule(): {
  exports: {
    apply: (ctx: unknown) => void
    inject: readonly string[]
    MemoryPanel: () => unknown
    fetchSnapshot: (signal?: AbortSignal) => Promise<Record<string, unknown>>
    describePanel: (snapshot: unknown) => PanelNodeLike
    renderPanel: (h: unknown, panel: PanelNodeLike) => unknown
    panelText: (panel: PanelNodeLike) => string
  }
  jsxCalls: { type: string; props: unknown }[]
} {
  assert.ok(captured !== undefined, '客户端文件必须调用 window.__ModuleLoader__.load')
  const { React, jsxCalls } = fakeReact()
  const require = (id: string): unknown => {
    if (id === 'react') return React
    if (id === 'react/jsx-runtime') {
      return {
        jsx: (type: string, props: unknown): unknown => {
          jsxCalls.push({ type, props })
          return { type, props }
        },
      }
    }
    throw new Error(`未预期的 require：${id}`)
  }
  return { exports: captured.factory(require) as never, jsxCalls }
}

interface PanelNodeLike {
  type: string
  props: Record<string, unknown>
  children: (PanelNodeLike | string)[]
}

/** 深度遍历结构树，收集所有字符串。 */
function texts(panel: PanelNodeLike): string[] {
  return panel.children.flatMap((c) => (typeof c === 'string' ? [c] : texts(c)))
}

/** 深度遍历，收集所有节点类型。 */
function types(panel: PanelNodeLike): string[] {
  return [panel.type, ...panel.children.flatMap((c) => (typeof c === 'string' ? [] : types(c)))]
}

test('加载契约：id 正确，导出 apply / inject 与纯函数', () => {
  assert.ok(captured !== undefined)
  assert.equal(captured.id, 'forlife-memory', '模块 id 必须与包名一致（宿主按 id 注册）')
  const { exports } = loadClientModule()
  assert.equal(typeof exports.apply, 'function')
  // 导出的 inject 是**服务名**（官方模板为 ['slots']）；包级依赖在 package.json 的 dsh.client.inject
  assert.deepEqual(exports.inject, ['slots'], '模块导出的 inject 必须是服务名，写错会导致 apply 永不被调用')
  for (const name of ['MemoryPanel', 'fetchSnapshot', 'describePanel', 'renderPanel', 'panelText'] as const) {
    assert.equal(typeof exports[name], 'function', `必须导出 ${name}（测试可达性）`)
  }
})

test('注册契约：先 slots.inject 等声明，再 register 到 settings.section', () => {
  const { exports } = loadClientModule()
  const injected: string[] = []
  const registered: { options: Record<string, unknown>; component: unknown }[] = []
  const disposer = (): void => {}

  const ctx = {
    slots: {
      inject(key: string, callback: () => unknown): void {
        injected.push(key)
        callback()
      },
      register(options: Record<string, unknown>, component: unknown): () => void {
        registered.push({ options, component })
        return disposer
      },
    },
  }

  exports.apply(ctx)

  assert.deepEqual(injected, ['settings.section'], '必须用 inject 等槽位声明（直接 register 到未声明槽会抛错）')
  assert.equal(registered.length, 1)
  assert.deepEqual(registered[0]?.options, {
    name: 'settings.section',
    id: 'forlife-memory',
    order: 60,
    label: '记忆',
  })
  assert.equal(registered[0]?.component, exports.MemoryPanel, '注册的组件必须是面板本身')
})

test('渲染内容：指标、指纹、条目表都画出来', () => {
  const { exports } = loadClientModule()
  const panel = exports.describePanel({
    state: {
      epoch: 3,
      revision: 42,
      activeCount: 2,
      fragmentCount: 1,
      activeTokens: 20,
      fragmentTokens: 8,
      renderedTokens: 90,
      renderedSha256: 'abc123',
      dbPath: 'D:\\data\\forlife.sqlite',
      violations: [],
    },
    entries: [
      { id: 'm1', type: 'semantic', status: 'active', summary: '用户养了一只叫团子的猫', tokenCount: 12, windowOffset: 0, epoch: 3, createdAt: '2026-10-05T01:02:03.000Z' },
      { id: 'm2', type: 'fragment', status: 'fragmented', summary: '缩略', hint: 'QQ bot 防抖与消息队列', tokenCount: 8, windowOffset: 1, epoch: 3, sourceScope: 'group:123', createdAt: '2026-10-05T02:03:04.000Z' },
    ],
  })

  const all = texts(panel).join(' ')
  for (const expected of [
    'epoch', '3',
    '修订号', '42',
    '活跃条目', '2',
    '碎片', '1',
    '渲染 token', '90',
    'abc123',
    '用户养了一只叫团子的猫',
    'QQ bot 防抖与消息队列', // 碎片显示 hint 而不是 summary
    'group:123',
    '2026-10-05 01:02:03', // UTC 时间，T 换成空格
  ]) {
    assert.ok(all.includes(expected), `面板应显示「${expected}」，实际文本：${all.slice(0, 240)}`)
  }
  assert.ok(types(panel).includes('table'), '条目要用表格呈现')
  // 碎片行必须用 hint，而不是它的 summary
  assert.ok(!all.includes(' 缩略 '), '碎片行不该显示 summary（应显示 hint）')
})

test('渲染内容：约束违反单独成块，空条目给友好提示', () => {
  const { exports } = loadClientModule()
  const panel = exports.describePanel({
    state: { epoch: 0, revision: 1, violations: ['mid_x: 碎片 hint 120 token 超过上限 80', '碎片区占比 31% 超过上限 20%'] },
    entries: [],
  })
  const all = texts(panel).join(' ')
  assert.ok(all.includes('2 处约束违反'), '违反数量要显示出来')
  assert.ok(all.includes('超过上限 80'), '具体违反内容要列出')
  assert.ok(all.includes('还没有记忆条目'), '空状态要给提示而不是空白表')
})

test('渲染内容：取数失败时显示错误，而不是装作没事', () => {
  const { exports } = loadClientModule()
  const panel = exports.describePanel({ error: '/state → HTTP 500' })
  assert.ok(texts(panel).join(' ').includes('读取失败：/state → HTTP 500'))
})

test('renderPanel：把结构树交给宿主的 jsx 造元素', () => {
  const { exports } = loadClientModule()
  const calls: { type: string; props: unknown }[] = []
  const h = (type: string, props: unknown, ...children: unknown[]): unknown => {
    calls.push({ type, props })
    return { type, children }
  }
  const panel = exports.describePanel({ state: { epoch: 1 }, entries: [] })
  exports.renderPanel(h, panel)
  assert.ok(calls.length > 10, `应调用 jsx 多次，实际 ${calls.length}`)
  assert.equal(calls[0]?.type, panel.type, '根节点类型必须一致')
  assert.equal(exports.panelText(panel).length > 0, true)
})

test('取数：走 /api/forlife/*，HTTP 失败进 error 字段（不抛）', async () => {
  const { exports } = loadClientModule()
  const requested: string[] = []
  const originalFetch = globalThis.fetch

  globalThis.fetch = (async (input: string | URL) => {
    const url = String(input)
    requested.push(url)
    if (url.endsWith('/state')) {
      return new Response(JSON.stringify({ epoch: 2, revision: 7, activeCount: 1 }), { status: 200 })
    }
    if (url.endsWith('/entries')) {
      return new Response(JSON.stringify({ entries: [{ id: 'm1', type: 'semantic', summary: 'x', tokenCount: 1, windowOffset: 0, epoch: 2, createdAt: '2026-10-05T00:00:00.000Z' }] }), { status: 200 })
    }
    if (url.includes('/compaction')) {
      return new Response(JSON.stringify({ log: [] }), { status: 200 })
    }
    return new Response('nope', { status: 500 })
  }) as typeof fetch

  try {
    const ok = await exports.fetchSnapshot()
    assert.ok(requested.every((u) => u.startsWith('/api/forlife')), `取数路径必须是我们自己的接口：${requested.join(' , ')}`)
    assert.equal((ok.state as { epoch: number }).epoch, 2)
    assert.equal((ok.entries as unknown[]).length, 1)

    globalThis.fetch = (async () => new Response('boom', { status: 503 })) as typeof fetch
    const failed = await exports.fetchSnapshot()
    assert.equal(failed.error, '/state → HTTP 503', 'HTTP 失败必须落进 error 字段')
    assert.equal(failed.state, undefined)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('面板组件：加载中状态返回提示文本', () => {
  const { exports } = loadClientModule()
  // 首次渲染时 loading=true（useEffect 在测试替身里不执行）
  const element = exports.MemoryPanel() as { type: string; props: { children: string } }
  assert.equal(element.type, 'div')
  assert.match(element.props.children, /正在读取记忆状态/)
})

