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
    RoutesPanel: () => unknown
    fetchRoutesSnapshot: (signal?: AbortSignal) => Promise<Record<string, unknown>>
    describeRoutes: (snapshot: unknown) => PanelNodeLike
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
  // 四个区块：「记忆」看记忆本体，「QQ 与后台」看网关与人类直发通道，
  // 「提示词」编辑人设与风格，「模型与路由」管模型供应。
  // 刻意分别注册而不是塞进一个区块 —— 使用场景不同，混在一起两边都难用。
  //
  // 断言**包含关系**而不是数量：这是第四次踩"数量断言"的坑了
  // （每加一个区块就要改一次测试 ⇒ 改多了人会闭眼改 ⇒ 断言失去意义）。
  const sectionIds = new Set(registered.map((entry) => String(entry.options['id'])))
  for (const required of ['forlife-memory', 'forlife-qq', 'forlife-prompts', 'forlife-routes']) {
    assert.ok(sectionIds.has(required), `必须注册区块 ${required}`)
  }
  assert.equal(registered.length, sectionIds.size, '不该注册重复 id 的区块')
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

test('渲染内容：预览结果走 ui.preview 也要画出来（这才是真实路径）', () => {
  const { exports } = loadClientModule()
  // 真实的 fetchPromptSnapshot **从不**设置 snapshot.preview：
  // 预览结果只存在于 React 状态里，经 ui.preview 传进来。
  // 上面那条测试把 preview 塞进了 snapshot，所以它一直是绿的 —— 而点「预览」其实毫无反应。
  const panel = exports.describePrompts(
    {
      prompts: [{ slug: 'p1-system', tokenCount: 320, revisions: 1 }],
      revisions: [],
      variables: [],
      overrides: [],
    },
    {
      drafts: {},
      preview: {
        slug: 'p1-system',
        errors: [],
        warnings: [],
        tokenCount: 330,
        tokenDelta: 10,
        willChange: true,
        diff: [{ kind: 'added', text: '新加的这一行' }],
      },
    },
  )
  const all = texts(panel).join(' ')
  assert.ok(all.includes('预览（p1-system）'), `点完预览必须看到结果，实际：${all.slice(0, 300)}`)
  assert.ok(all.includes('+ 新加的这一行'), `diff 必须画出来，实际：${all.slice(0, 300)}`)
  assert.ok(!all.includes('点「预览」看看'), '不能还停在占位文字上（说明预览结果没接上）')
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

test('渲染内容：时间感知卡（最新读数年龄/注入成本/漂移/按会话时区）', () => {
  const { exports } = loadClientModule()
  const panel = exports.describeQq({
    qq: {},
    time: {
      settings: { systemTimezone: 'UTC', conversationTimezone: 'Asia/Shanghai', displayTimezone: 'Asia/Shanghai', hour24: true },
      latest: { at: '2026-10-05T12:00:00.000Z', reason: 'after-compaction', timezone: 'Asia/Shanghai', ageMs: 12_000, fresh: true },
      freshThresholdMs: 30_000,
      byReason: [{ reason: 'turn-first', count: 3 }],
      tokenCost: 480,
      readings: [{ at: '2026-10-05T12:00:00.000Z', reason: 'after-compaction', timezone: 'Asia/Shanghai', tokenCount: 160 }],
      clocks: [{ scope: 'group:88888', timezone: 'Asia/Tokyo', source: 'model_note' }],
      drift: { count: 2, avgMs: 120_000, maxMs: 900_000 },
      recentDrift: [],
    },
  })
  const all = texts(panel).join(' ')
  for (const expected of ['时间感知', '新鲜', '12 秒', '注入 token', '480', '记录 UTC', '会话 Asia/Shanghai', 'after-compaction', 'group:88888=Asia/Tokyo(model_note)', '时间漂移 2 次']) {
    assert.ok(all.includes(expected), `时间卡应显示「${expected}」，实际：${all.slice(0, 300)}`)
  }
})

test('渲染内容：读数偏旧时明确警告（不让人以为它是新鲜的）', () => {
  const { exports } = loadClientModule()
  const panel = exports.describeQq({
    qq: {},
    time: {
      settings: { systemTimezone: 'UTC', conversationTimezone: 'Asia/Shanghai', displayTimezone: 'Asia/Shanghai', hour24: true },
      latest: { at: '2026-10-05T10:00:00.000Z', reason: 'turn-first', timezone: 'Asia/Shanghai', ageMs: 7_200_000, fresh: false },
      tokenCost: 0,
      readings: [],
      clocks: [],
      drift: { count: 0, avgMs: null, maxMs: null },
    },
  })
  const all = texts(panel).join(' ')
  assert.ok(all.includes('偏旧'), '过期的读数要说它旧')
  assert.ok(all.includes('可能拿到的是陈旧读数'), '要说清后果')
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





// ── 阶段 5：模型与路由页 ───────────────────────────────────────────────────

test('渲染内容：路由页（端点概览、角色映射、校验问题、实际后端不一致）', () => {
  const { exports } = loadClientModule()
  const panel = exports.describeRoutes({
    ok: true,
    roles: [
      {
        role: 'vision',
        purpose: '视觉桥接：必须用声明了 image 能力的模型',
        candidates: [{ rank: 0, provider: 'vlm', model: 'vl-7b', effort: null, enabled: true, note: '看图' }],
      },
      { role: 'embedding', purpose: '向量', candidates: [], gapLevel: 'optional', gapHint: '只有要用向量召回时才需要' },
    ],
    endpoints: [
      {
        id: 'ep-local',
        type: 'local',
        mode: 'resident',
        backend: 'cuda',
        baseUrl: 'http://127.0.0.1:8080/v1',
        deployTarget: 'local-docker',
        deployHost: null,
        models: [{ id: 'qwen' }],
        health: { ok: true, checkedAt: '2026-10-05T12:00:00.000Z', latencyMs: 12, effectiveBackend: 'cpu', note: '镜像回落到 CPU' },
      },
    ],
    overview: { total: 1, backendMismatch: [{ id: 'ep-local', declared: 'cuda', effective: 'cpu' }] },
    probe: [{ at: '2026-10-05T12:00:00.000Z', endpointId: 'ep-local', ok: true, latencyMs: 12, note: '延迟 12ms' }],
    stats: { total: 20, degradedRate: 0.2 },
    uncertain: { pending: 3 },
    devices: { renderNodes: ['/dev/dri/renderD128'], nvidia: false, rocm: false, intel: false, vulkan: true },
    issues: [{ endpoint: 'ep-local', field: 'backend', message: '目标机没有可用的 NVIDIA 设备', severity: 'error' }],
    tierOverride: { tier: 'L3', reason: '架构设计' },
  })
  const all = texts(panel).join(' ')
  for (const expected of [
    '模型与路由',
    '降级率',
    '手动切到 L3',
    '设备探测',
    '/dev/dri/renderD128',
    '校验问题',
    'NVIDIA',
    '实际生效后端',
    'ep-local',
    '镜像回落到 CPU',
    '视觉桥接',
    '需要时再配',
    '只有要用向量召回时才需要',
    '试跑记录',
    '12ms',
  ]) {
    assert.ok(all.includes(expected), `路由页应显示「${expected}」，实际：${all.slice(0, 400)}`)
  }
})

test('渲染内容：路由页没有端点时给出可执行的下一步（而不是空白）', () => {
  const { exports } = loadClientModule()
  const text = texts(exports.describeRoutes({ ok: true, roles: [], endpoints: [], overview: {}, stats: {}, devices: {}, issues: [], probe: [], uncertain: {}, tierOverride: null })).join(' ')
  assert.ok(text.includes('还没有登记任何推理端点'))
  assert.ok(text.includes('外挂自建'), '要告诉用户"不需要本地部署也能开始"')
  assert.ok(text.includes('自动判定'))
})

test('渲染内容：路由读取失败时如实报错（不装作没事）', () => {
  const { exports } = loadClientModule()
  const text = texts(exports.describeRoutes({ ok: false, error: 'HTTP 500' })).join(' ')
  assert.ok(text.includes('读取路由失败'))
  assert.ok(text.includes('HTTP 500'))
})

// ── 渲染契约（这一条是本阶段最贵的教训）────────────────────────────────────

/**
 * 用**符合 React 契约**的 jsx 桩渲染，断言面板真的有内容。
 *
 * 为什么必须单独有这条：面板原先的 `renderPanel` 写成 `jsx(type, props, ...kids)`，
 * 而 `react/jsx-runtime` 的签名是 `jsx(type, props, key)` —— **第三个参数是 key，不是子节点**。
 * 于是所有子节点被丢掉，浏览器里渲染出来是**一个空的 div**（用户看到"四个面板全空"）。
 * 而当时所有测试都是绿的：它们用 `panelText()` 读的是**本文件自己构造的树**，不是 React 看到的东西。
 *
 * 教训：**测"我构造了什么"不等于测"React 会渲染出什么"**。这个桩刻意不保留第三个参数。
 */
test('渲染契约：空元素（void tag）绝不能带 children —— React #137，整块面板会被吞掉', () => {
  const { exports } = loadClientModule()
  const h = (type: unknown, props: unknown): unknown => ({ type, props })

  // ① `node('input', {…})` 的 children 是 `[]`；React 判的是 `props.children != null`，
  //    空数组**不是** null ⇒ 抛 "input is a void element tag…"（生产版 = Minified React error #137）。
  //    真凶就是这里：「QQ 与后台」「模型与路由」各有一个 <input>，两块一起白屏。
  const bare = exports.renderPanel(h as never, { type: 'input', props: { value: 'x' }, children: [] }) as {
    props: Record<string, unknown>
  }
  assert.ok(!('children' in bare.props), 'input 的 props 里不能出现 children（空数组也算！）')

  // ② 真给了子节点就必须响亮失败，而不是渲染出一块白屏
  assert.throws(
    () => exports.renderPanel(h as never, { type: 'input', props: {}, children: ['文字'] }),
    /空元素 <input> 不能有子节点/,
  )

  // ③ 普通容器不受影响：有子节点照常进 props.children
  const box = exports.renderPanel(h as never, { type: 'div', props: {}, children: ['文字'] }) as {
    props: { children: unknown }
  }
  assert.equal(box.props.children, '文字')
})

test('渲染契约：子节点必须进 props.children（jsx 的第三参是 key，不是 children）', () => {
  const { exports } = loadClientModule()
  // 与 react/jsx-runtime 同签名：刻意忽略第三个参数
  const reactShapedJsx = (type: unknown, props: unknown): unknown => ({ type, props: (props ?? {}) as Record<string, unknown> })

  /** 按 React 语义取文本（只读 props.children）。 */
  const textOf = (element: unknown): string => {
    if (element === null || element === undefined) return ''
    if (typeof element === 'string') return element
    if (typeof element === 'number') return String(element)
    if (Array.isArray(element)) return element.map(textOf).join(' ')
    const children = (element as { props?: { children?: unknown } }).props?.children
    return textOf(children)
  }

  const snapshot = {
    state: {
      epoch: 1,
      revision: 3,
      activeCount: 2,
      fragmentCount: 1,
      activeTokens: 120,
      fragmentTokens: 40,
      renderedTokens: 160,
      renderedSha256: 'abc123',
    },
    entries: [{ windowOffset: 0, type: 'active', status: 'active', summary: '测试条目', tokenCount: 120, epoch: 1 }],
    compaction: [],
    runs: [],
  }

  const tree = exports.renderPanel(reactShapedJsx as never, exports.describePanel(snapshot)) as {
    type: unknown
    props: { children?: unknown }
  }
  assert.equal(tree.type, 'div')
  const childCount = Array.isArray(tree.props.children) ? tree.props.children.length : 1
  assert.ok(childCount > 1, `根元素必须有多个子节点（实际 ${String(childCount)}）—— 只有 1 个说明子节点被当成 key 丢掉了`)

  const text = textOf(tree)
  assert.ok(text.includes('测试条目'), `渲染文本里必须能看到条目内容，实际：${text.slice(0, 200)}`)
  assert.ok(text.includes('epoch'), '指标也要渲染出来')
})

test('渲染契约：四个面板的组件都**导出**了（否则测试够不到，浏览器里才暴露）', () => {
  const { exports } = loadClientModule()
  for (const name of ['MemoryPanel', 'QqPanel', 'PromptPanel', 'RoutesPanel'] as const) {
    assert.equal(typeof exports[name], 'function', `${name} 必须是导出且是函数（注册到槽位的就是它）`)
  }
})
