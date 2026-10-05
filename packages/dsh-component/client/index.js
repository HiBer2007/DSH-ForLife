/**
 * 记忆面板的客户端插件（浏览器侧）—— **单文件，无构建步骤**。
 *
 * ## 加载契约（从已发布客户端包实测得出，不是猜的）
 *
 * ```js
 * window.__ModuleLoader__.load({
 *   id: '<包名>',
 *   factory: (require) => { ...; exports.apply = apply; return module.exports }
 * })
 * ```
 *
 * `require('react')` / `require('react/jsx-runtime')` 由**宿主**解析，
 * 所以这份手写文件就是最终产物（用 `jsx()` 调用而不是 JSX，省掉打包器）。
 *
 * ## 注册契约
 *
 * `ctx.slots.inject(key, () => ctx.slots.register({...}, Component))` ——
 * 必须先 `inject` 等槽位被**声明**；直接 register 到未声明的槽会抛错
 * （`SlotCore.register` 的 load-time validation：registering into an undeclared slot throws）。
 *
 * 槽位选择 `settings.section`（kind=list / scope=root），与 `dsh-client-ui-settings-models`
 * 这类官方设置页走同一个位子。
 *
 * ## 为什么把纯逻辑也放在这个文件里
 *
 * 宿主侧的自定义 `require` 只解析**已注册**的模块，跨文件 require 我们自己的模块行不通；
 * 而拆成"构建期打包"又与"零构建"的目标冲突。所以保持单文件，
 * 并把纯函数（`describePanel` / `renderPanel` / `panelText`）挂到 `module.exports` 上，
 * 让 Node 测试能通过一个假的 `__ModuleLoader__` 捕获到它们 —— **测的就是要发布的那份文件**。
 *
 * @module forlife-memory/client
 */

window.__ModuleLoader__.load({
  id: 'forlife-memory',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports

    const React = require('react')
    const { jsx } = require('react/jsx-runtime')

    // ── 纯渲染层（不依赖 React；测试直接断言它画了什么）─────────────────────

    const styles = {
      wrap: { display: 'flex', flexDirection: 'column', gap: '16px', padding: '4px 0' },
      card: { border: '1px solid var(--dsh-border, #3333)', borderRadius: '8px', padding: '12px' },
      row: { display: 'flex', gap: '16px', flexWrap: 'wrap' },
      metric: { display: 'flex', flexDirection: 'column', minWidth: '96px' },
      metricLabel: { fontSize: '12px', opacity: 0.7 },
      metricValue: { fontSize: '18px', fontWeight: 600 },
      mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '12px', wordBreak: 'break-all' },
      table: { width: '100%', borderCollapse: 'collapse', fontSize: '13px' },
      th: { textAlign: 'left', padding: '6px 8px', borderBottom: '1px solid var(--dsh-border, #3333)', opacity: 0.7, fontWeight: 500 },
      td: { padding: '6px 8px', borderBottom: '1px solid var(--dsh-border, #2222)', verticalAlign: 'top' },
      badge: { display: 'inline-block', padding: '1px 6px', borderRadius: '10px', fontSize: '11px', border: '1px solid currentColor', opacity: 0.8 },
      warn: { color: '#d97706' },
      err: { color: '#dc2626' },
      muted: { opacity: 0.6 },
    }

    /** 构造一个结构节点（与 React 元素树同构，但只是数据）。 */
    function node(type, props, children) {
      return { type, props, children: children || [] }
    }

    /** 单个指标块。 */
    function metric(label, value) {
      return node('div', { style: styles.metric }, [
        node('div', { style: styles.metricLabel }, [label]),
        node('div', { style: styles.metricValue }, [value === undefined ? '—' : String(value)]),
      ])
    }

    /** 条目表。 */
    function entriesTable(entries) {
      if (entries.length === 0) {
        return node('div', { style: styles.card }, [node('div', { style: styles.muted }, ['当前 epoch 下还没有记忆条目。'])])
      }
      const rows = entries.map((entry) =>
        node('tr', {}, [
          node('td', { style: styles.td }, [String(entry.windowOffset)]),
          node('td', { style: styles.td }, [
            node('span', { style: Object.assign({}, styles.badge, { color: entry.type === 'fragment' ? '#d97706' : '#2563eb' }) }, [
              entry.type === 'fragment' ? '碎片' : '活跃',
            ]),
          ]),
          node('td', { style: styles.td }, [entry.type === 'fragment' ? (entry.hint || entry.summary) : entry.summary]),
          node('td', { style: styles.td }, [String(entry.tokenCount)]),
          node('td', { style: styles.td }, [node('span', { style: styles.muted }, [entry.sourceScope || '—'])]),
          node('td', { style: styles.td }, [
            node('span', { style: styles.mono }, [String(entry.createdAt || '').slice(0, 19).replace('T', ' ')]),
          ]),
        ]),
      )
      return node('div', { style: styles.card }, [
        node('div', { style: styles.metricLabel }, [`条目（${entries.length} 条 · epoch ${entries[0] ? entries[0].epoch : '?'}）`]),
        node('table', { style: styles.table }, [
          node('thead', {}, [
            node('tr', {}, [
              node('th', { style: styles.th }, ['#']),
              node('th', { style: styles.th }, ['类型']),
              node('th', { style: styles.th }, ['摘要 / 碎片提示']),
              node('th', { style: styles.th }, ['token']),
              node('th', { style: styles.th }, ['来源']),
              node('th', { style: styles.th }, ['创建（UTC）']),
            ]),
          ]),
          node('tbody', {}, rows),
        ]),
      ])
    }

    /** 压缩历史：事务视角（阶段 2 起有数据）。 */
    function compactionTable(log, runs) {
      if (log.length === 0 && runs.length === 0) {
        return node('div', { style: styles.card }, [
          node('div', { style: styles.muted }, ['还没有压缩记录。压缩会在上下文压力达到阈值、或模型主动请求时发生。']),
        ])
      }
      const phaseColor = { committed: '#16a34a', aborted: '#dc2626', started: '#d97706' }
      const rows = runs.map((run) =>
        node('tr', {}, [
          node('td', { style: styles.td }, [
            node('span', { style: Object.assign({}, styles.badge, { color: phaseColor[run.phase] || '#666' }) }, [
              run.phase === 'committed' ? '已提交' : run.phase === 'aborted' ? '已回滚' : '进行中',
            ]),
          ]),
          node('td', { style: styles.td }, [`${run.epochFrom} → ${run.epochTo === null ? '?' : run.epochTo}`]),
          node('td', { style: styles.td }, [
            node('span', { style: styles.mono }, [String(run.startedAt || '').slice(0, 19).replace('T', ' ')]),
          ]),
          node('td', { style: styles.td }, [run.sessionId || '—']),
          node('td', { style: styles.td }, [node('span', { style: run.error ? styles.err : styles.muted }, [run.error || '—'])]),
        ]),
      )
      return node('div', { style: styles.card }, [
        node('div', { style: styles.metricLabel }, [`压缩历史（${runs.length} 次事务 · ${log.length} 条协议日志）`]),
        node('table', { style: styles.table }, [
          node('thead', {}, [
            node('tr', {}, [
              node('th', { style: styles.th }, ['状态']),
              node('th', { style: styles.th }, ['epoch']),
              node('th', { style: styles.th }, ['开始（UTC）']),
              node('th', { style: styles.th }, ['会话']),
              node('th', { style: styles.th }, ['失败/回滚原因']),
            ]),
          ]),
          node('tbody', {}, rows),
        ]),
      ])
    }

    /**
     * 把数据快照描述成一棵结构树。
     * @param {object} snapshot - `{ state, entries, compaction, error }`。
     * @returns {object} 结构树。
     */
    function describePanel(snapshot) {
      const state = snapshot.state || {}
      const entries = snapshot.entries || []
      const violations = state.violations || []

      const children = [
        node('div', { style: styles.card }, [
          node('div', { style: styles.row }, [
            metric('epoch', state.epoch),
            metric('修订号', state.revision),
            metric('活跃条目', state.activeCount),
            metric('碎片', state.fragmentCount),
            metric('活跃 token', state.activeTokens),
            metric('碎片 token', state.fragmentTokens),
            metric('渲染 token', state.renderedTokens),
          ]),
          state.renderedSha256 === undefined
            ? node('div', { style: styles.muted }, ['（尚无渲染指纹）'])
            : node('div', {}, [
                node('div', { style: styles.metricLabel }, ['提示词前缀指纹（sha256）']),
                node('div', { style: styles.mono }, [state.renderedSha256]),
              ]),
          state.dbPath === undefined ? node('div', {}, []) : node('div', { style: styles.mono }, [state.dbPath]),
        ]),
      ]

      if (snapshot.error !== undefined) {
        children.push(node('div', { style: styles.err }, [`读取失败：${snapshot.error}`]))
      }
      if (violations.length > 0) {
        children.push(
          node('div', { style: styles.card }, [
            node('div', { style: styles.warn }, [`${violations.length} 处约束违反（渲染方只报告，不擅自改数据）`]),
          ].concat(violations.map((v) => node('div', { style: styles.mono }, [v])))),
        )
      }

      children.push(entriesTable(entries))
      children.push(compactionTable(snapshot.compaction || [], snapshot.runs || []))
      return node('div', { style: styles.wrap }, children)
    }

    /**
     * 结构树 → 宿主 React 元素。
     * @param {Function} h - 造元素函数（宿主传 `jsx`）。
     * @param {object} panel - `describePanel` 的产物。
     * @returns {unknown} React 元素。
     */
    function renderPanel(h, panel) {
      const kids = panel.children.map((child) => (typeof child === 'string' ? child : renderPanel(h, child)))
      return h(panel.type, panel.props, ...kids)
    }

    /** 结构树 → 纯文本（便于断言与肉眼对账）。 */
    function panelText(panel) {
      const own = panel.children.filter((c) => typeof c === 'string')
      const nested = panel.children.filter((c) => typeof c !== 'string').map(panelText)
      return own.concat(nested).join(' ')
    }

    // ── 取数 ────────────────────────────────────────────────────────────────

    const API_BASE = '/api/forlife'

    /**
     * 取一份面板数据快照。
     * @param {AbortSignal} [signal] - 取消信号。
     * @returns {Promise<object>} 快照（失败时带 `error` 字段，不抛）。
     */
    async function fetchSnapshot(signal) {
      const snapshot = {}
      const get = async (path) => {
        const response = await fetch(API_BASE + path, { signal })
        if (!response.ok) throw new Error(`${path} → HTTP ${response.status}`)
        return response.json()
      }
      try {
        const [state, entries, compaction] = await Promise.all([
          get('/state'),
          get('/entries'),
          get('/compaction?limit=10'),
        ])
        snapshot.state = state
        snapshot.entries = entries.entries || []
        snapshot.compaction = compaction.log || []
        snapshot.runs = compaction.runs || []
      } catch (error) {
        snapshot.error = String(error && error.message ? error.message : error)
      }
      return snapshot
    }

    // ── 面板组件 ────────────────────────────────────────────────────────────

    /** 面板容器：负责取数；画什么完全交给纯函数。 */
    function MemoryPanel() {
      const [snapshot, setSnapshot] = React.useState({})
      const [loading, setLoading] = React.useState(true)

      React.useEffect(() => {
        const controller = new AbortController()
        let alive = true
        const load = async () => {
          const next = await fetchSnapshot(controller.signal)
          if (alive) {
            setSnapshot(next)
            setLoading(false)
          }
        }
        void load()
        const timer = setInterval(() => void load(), 5000)
        return () => {
          alive = false
          clearInterval(timer)
          controller.abort()
        }
      }, [])

      if (loading) return jsx('div', { style: { opacity: 0.6 }, children: '正在读取记忆状态…' })
      return renderPanel(jsx, describePanel(snapshot))
    }

    /**
     * 安装面板（宿主调用）。
     * @param {object} ctx - 浏览器侧 cordis 上下文。
     */
    function apply(ctx) {
      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          { name: 'settings.section', id: 'forlife-memory', order: 60, label: '记忆' },
          MemoryPanel,
        ),
      )
    }

    /**
     * 客户端**服务**依赖（不是包名！）。
     *
     * 官方模板（`dsh-agent-preset/skills/cordis-plugin-development/templates/decoration/client.js`）
     * 返回的就是 `inject: ['slots']`。包级依赖写在 package.json 的 `dsh.client.inject` 里，
     * 两者不是一回事 —— 写错会导致 `apply` 永远不被调用。
     */
    const inject = ['slots']

    exports.apply = apply
    exports.inject = inject
    exports.MemoryPanel = MemoryPanel
    exports.fetchSnapshot = fetchSnapshot
    exports.describePanel = describePanel
    exports.renderPanel = renderPanel
    exports.panelText = panelText
    return module.exports
  },
})

