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
    QqPanel: () => unknown
    fetchQqSnapshot: (signal?: AbortSignal) => Promise<Record<string, unknown>>
    describeQq: (snapshot: unknown, ui?: unknown) => PanelNodeLike
    postAdminMessage: (text: string, actor?: string) => Promise<Record<string, unknown>>
    patchWakeRule: (scope: string, condition: string, patch: Record<string, unknown>) => Promise<Record<string, unknown>>
    PromptPanel: () => unknown
    fetchPromptSnapshot: (signal?: AbortSignal) => Promise<Record<string, unknown>>
    describePrompts: (snapshot: unknown, ui?: unknown) => PanelNodeLike
    previewPrompt: (slug: string, text: string) => Promise<Record<string, unknown>>
    savePrompt: (slug: string, text: string) => Promise<Record<string, unknown>>
    rollbackPromptRevision: (revisionId: string) => Promise<Record<string, unknown>>
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

  assert.deepEqual([...new Set(injected)], ['settings.section'], '必须用 inject 等槽位声明（直接 register 到未声明槽会抛错）')
  // 两个区块：「记忆」看记忆本体，「QQ 与后台」看网关与人类直发通道。
  // 刻意分别注册而不是塞进一个区块 —— 使用场景不同，混在一起两边都难用。
  assert.equal(registered.length, 3, '应当注册三个设置区块：记忆 / QQ 与后台 / 提示词')
  const byId = new Map(registered.map((entry) => [String(entry.options['id']), entry]))
  assert.deepEqual(byId.get('forlife-memory')?.options, {
    name: 'settings.section',
    id: 'forlife-memory',
    order: 60,
    label: '记忆',
  })
  assert.deepEqual(byId.get('forlife-qq')?.options, {
    name: 'settings.section',
    id: 'forlife-qq',
    order: 61,
    label: 'QQ 与后台',
  })
  assert.deepEqual(byId.get('forlife-prompts')?.options, {
    name: 'settings.section',
    id: 'forlife-prompts',
    order: 62,
    label: '提示词',
  })
  assert.equal(byId.get('forlife-memory')?.component, exports.MemoryPanel, '注册的组件必须是面板本身')
  assert.equal(byId.get('forlife-qq')?.component, exports.QqPanel)
  assert.equal(byId.get('forlife-prompts')?.component, exports.PromptPanel)
})

test('渲染内容：提示词面板画出编辑器、预览、历史与变量白名单', () => {
  const { exports } = loadClientModule()
  const panel = exports.describePrompts(
    {
      prompts: [
        { slug: 'p1-system', tokenCount: 320, revisions: 3, sha256: 'a'.repeat(64) },
        { slug: 'p2-style', tokenCount: 90, revisions: 2, sha256: 'b'.repeat(64) },
      ],
      revisions: [
        { id: 'r2', slug: 'p2-style', active: true, createdAt: '2026-10-05T12:00:00.000Z', createdBy: 'admin', tokenCount: 90, excerpt: '## 说话方式' },
        { id: 'r1', slug: 'p2-style', active: false, createdAt: '2026-10-05T11:00:00.000Z', createdBy: 'system', tokenCount: 88, excerpt: '## 旧风格' },
      ],
      variables: [
        { name: 'persona_name', dynamic: false, description: '它的名字' },
        { name: 'now', dynamic: true, description: '当前时间（禁止进前缀）' },
      ],
      overrides: [{ scope: 'group:88888', slug: 'p2-style' }],
      preview: {
        slug: 'p1-system',
        ok: true,
        errors: [],
        warnings: ['文本里有落单的 `{{`'],
        tokenCount: 330,
        tokenDelta: 10,
        willChange: true,
        rendered: '你是团子，主人的伙伴。',
        diff: [
          { kind: 'same', text: '你是{{persona_name}}' },
          { kind: 'removed', text: '旧的一行' },
          { kind: 'added', text: '新的一行' },
        ],
      },
    },
    { drafts: { 'p1-system': '你是{{persona_name}}', 'p2-style': '## 说话方式' }, dirty: { 'p1-system': true } },
  )
  const all = texts(panel).join(' ')
  for (const expected of [
    'P1 系统提示词',
    'P2 回答风格',
    '未保存改动',
    '有',
    '预览（p1-system）',
    '会改变前缀 ⇒ 一次缓存未命中',
    '+10',
    '最终拼装结果（变量已替换）',
    '你是团子，主人的伙伴。',
    '+ 新的一行',
    '- 旧的一行',
    '历史版本',
    '回滚到这版',
    '生效中',
    '{{persona_name}}',
    '不能用在稳定前缀里',
    '文本里有落单',
  ]) {
    assert.ok(all.includes(expected), `提示词面板应显示「${expected}」，实际：${all.slice(0, 400)}`)
  }
  const types = new Set<string>()
  const walk = (n: { type: string; children: unknown[] }): void => {
    types.add(n.type)
    for (const child of n.children) if (typeof child !== 'string') walk(child as { type: string; children: unknown[] })
  }
  walk(panel as unknown as { type: string; children: unknown[] })
  assert.ok(types.has('textarea'), '两个槽位都要有编辑框')
})

test('渲染内容：QQ 与后台面板画出积压、轮次、规则与人类直发框', () => {
  const { exports } = loadClientModule()
  const panel = exports.describeQq({
    qq: {
      sessions: 3,
      inbound: 120,
      inboundPending: 0,
      turnsRunning: 1,
      turnsDeferred: 2,
      outbox: { pending: 1, sending: 0, sent: 9, failed: 2 },
      pendingUnread: 5,
      transport: { connectedEvidence: true, lastInboundAt: '2026-10-05T12:00:00.000Z' },
    },
    queue: [
      { id: 'o1', conversation: 'onebot11:88888', conversationKind: 'group', kind: 'text', status: 'failed', source: 'model', attempt: 2, error: '平台拒绝', sentAt: '2026-10-05T12:00:01.000Z' },
    ],
    queueStats: { pending: 1, sending: 0, sent: 9, failed: 2 },
    turns: [
      { id: 't1', conversation: 'onebot11:10001', status: 'deferred', tokensIn: 1200, tokensOut: 30, toolCalls: 2, deferReason: '等下载完成', error: null, startedAt: '2026-10-05T12:00:02.000Z' },
    ],
    rules: [{ scope: '*', condition: 'group_mention_all', enabled: true, probability: 50, dailyLimit: 0, updatedBy: 'admin' }],
    pending: [{ id: 'p1', sender_name: '老王', summary: '他们聊了明天的会议', at: '2026-10-05T12:00:03.000Z' }],
    pendingStats: { unread: 5, total: 9 },
    chat: [
      { id: 'c1', role: 'human', actor: 'HiBer2007', text: '看看今天的记忆情况', handled: false },
      { id: 'c2', role: 'model', text: '今天记了 3 条', handled: true },
    ],
  })
  const all = texts(panel).join(' ')
  for (const expected of [
    '会话',
    '3',
    '入站总数',
    '120',
    '挂起轮次',
    '2',
    '出站队列：待发 1',
    'onebot11:88888',
    '群',
    '平台拒绝',
    '挂起',
    '等下载完成',
    'group_mention_all',
    '50%',
    '他们聊了明天的会议',
    '唯一能直接对它说人话',
    '看看今天的记忆情况',
    'HiBer2007',
    '今天记了 3 条',
  ]) {
    assert.ok(all.includes(expected), `面板应显示「${expected}」，实际：${all.slice(0, 300)}`)
  }
  assert.ok(all.includes('QQ 端近期有往来'), '连通性用"近期是否有往来"判断（比内存标志诚实）')
  const types = new Set<string>()
  const walk = (n: { type: string; children: unknown[] }): void => {
    types.add(n.type)
    for (const child of n.children) if (typeof child !== 'string') walk(child as { type: string; children: unknown[] })
  }
  walk(panel as unknown as { type: string; children: unknown[] })
  assert.ok(types.has('textarea'), '人类直发输入框必须在（唯一入口）')
  assert.ok(types.has('button'), '规则要有可点的调整按钮')
})

test('渲染内容：QQ 端久无往来时明确警告（不装作正常）', () => {
  const { exports } = loadClientModule()
  const panel = exports.describeQq({ qq: { transport: { connectedEvidence: false } } })
  assert.ok(texts(panel).join(' ').includes('近期没有任何 QQ 往来'), '没连上就要说没连上')
})

test('结构树 → 文本：QQ 面板也能转纯文本（断言与肉眼对账都靠它）', () => {
  const { exports } = loadClientModule()
  const panel = exports.describeQq({ qq: {}, queue: [], turns: [], rules: [], pending: [], chat: [] })
  const text = exports.panelText(panel)
  assert.ok(text.includes('队列是空的'), '空队列给友好提示')
  assert.ok(text.includes('还没有轮次记录'))
  assert.ok(text.includes('还没有对话'))
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

test('渲染内容：压缩历史（事务视角）画出状态、epoch 与回滚原因', () => {
  const { exports } = loadClientModule()
  const panel = exports.describePanel({
    state: { epoch: 2, revision: 5 },
    entries: [],
    runs: [
      { id: 'run_1', phase: 'committed', epochFrom: 0, epochTo: 1, sessionId: 'sess_1', startedAt: '2026-10-05T03:00:00.000Z', error: null },
      { id: 'run_2', phase: 'aborted', epochFrom: 1, epochTo: null, sessionId: 'sess_1', startedAt: '2026-10-05T04:00:00.000Z', error: '注入的写入故障' },
    ],
  })
  const all = texts(panel).join(' ')
  assert.ok(all.includes('压缩历史'), '要有压缩历史区块')
  assert.ok(all.includes('已提交') && all.includes('已回滚'), '两种状态都要能显示')
  assert.ok(all.includes('0 → 1'), 'epoch 变化要显示出来')
  assert.ok(all.includes('1 → ?'), '未提交的事务没有 epochTo，要显示为 ?')
  assert.ok(all.includes('注入的写入故障'), '回滚原因必须显示（否则运维无从下手）')
  assert.ok(all.includes('2026-10-05 03:00:00'), 'UTC 时间要格式化')
})

test('渲染内容：没有压缩记录时给友好提示而不是空表', () => {
  const { exports } = loadClientModule()
  const panel = exports.describePanel({ state: { epoch: 0 }, entries: [], runs: [], compaction: [] })
  assert.ok(texts(panel).join(' ').includes('还没有压缩记录'))
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



