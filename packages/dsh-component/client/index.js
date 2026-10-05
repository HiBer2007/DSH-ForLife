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
      button: {
        padding: '3px 10px',
        borderRadius: '6px',
        border: '1px solid var(--dsh-border, #3336)',
        background: 'transparent',
        color: 'inherit',
        fontSize: '12px',
        cursor: 'pointer',
      },
      textarea: {
        width: '100%',
        minHeight: '64px',
        padding: '8px',
        borderRadius: '6px',
        border: '1px solid var(--dsh-border, #3336)',
        background: 'transparent',
        color: 'inherit',
        fontFamily: 'inherit',
        fontSize: '13px',
        resize: 'vertical',
      },
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
      // **children 必须放进 props**：`jsx(type, props, key)` 的第三个参数是 **key**，
      // 不是子节点。我第一版写成了 `h(type, props, ...kids)` —— 所有子节点都被当成 key
      // 丢掉，渲染出来是一个**空的 div**，而面板自己的测试（读的是本文件构造的树）
      // 一直是绿的。所以下面还留了一条"必须走 React 的契约"的测试盯着这件事。
      return h(panel.type, Object.assign({}, panel.props, { children: kids.length === 1 ? kids[0] : kids }))
    }

    /** 结构树 → 纯文本（便于断言与肉眼对账）。 */
    function panelText(panel) {
      const own = panel.children.filter((c) => typeof c === 'string')
      const nested = panel.children.filter((c) => typeof c !== 'string').map(panelText)
      return own.concat(nested).join(' ')
    }

    // ── QQ 与后台（阶段 3）──────────────────────────────────────────────────
    //
    // 设计取舍：这一块**不做"漂亮仪表盘"**，只回答四个排障问题：
    //   ① 现在积压了什么（队列 + 待读池）
    //   ② 它什么时候醒过、花了多少（轮次时间线）
    //   ③ 为什么没醒（唤醒规则的当前值 + 判定留痕）
    //   ④ 我要跟它说话（唯一的人类直发输入框）

    /** 一张状态徽标。 */
    function statusBadge(text, tone) {
      const color = tone === 'bad' ? '#dc2626' : tone === 'warn' ? '#d97706' : tone === 'good' ? '#16a34a' : '#2563eb'
      return node('span', { style: Object.assign({}, styles.badge, { color }) }, [text])
    }

    /** 出站队列表。 */
    function queueTable(rows, stats) {
      const s = stats || {}
      const head = node('div', { style: styles.metricLabel }, [
        `出站队列：待发 ${s.pending || 0} · 发送中 ${s.sending || 0} · 已确认 ${s.sent || 0} · 失败 ${s.failed || 0}`,
      ])
      if (!rows || rows.length === 0) {
        return node('div', { style: styles.card }, [head, node('div', { style: styles.muted }, ['队列是空的。'])])
      }
      const body = rows.map((row) =>
        node('tr', {}, [
          node('td', { style: styles.td }, [statusBadge(row.status, row.status === 'failed' ? 'bad' : row.status === 'sent' ? 'good' : 'warn')]),
          node('td', { style: styles.td }, [row.conversation, node('span', { style: styles.muted }, [` · ${row.conversationKind === 'group' ? '群' : '私聊'}`])]),
          node('td', { style: styles.td }, [row.kind]),
          node('td', { style: styles.td }, [row.source || '—']),
          node('td', { style: styles.td }, [String(row.attempt || 0)]),
          node('td', { style: styles.td }, [row.error ? node('span', { style: styles.err }, [row.error]) : node('span', { style: styles.muted }, ['—'])]),
          node('td', { style: styles.td }, [node('span', { style: styles.mono }, [String(row.sentAt || '').slice(11, 19)])]),
        ]),
      )
      return node('div', { style: styles.card }, [
        head,
        node('table', { style: styles.table }, [
          node('thead', {}, [
            node('tr', {}, ['状态', '会话', '类型', '来源', '重试', '错误', '时间'].map((t) => node('th', { style: styles.th }, [t]))),
          ]),
          node('tbody', {}, body),
        ]),
      ])
    }

    /** 轮次时间线。 */
    function turnsTable(turns) {
      if (!turns || turns.length === 0) {
        return node('div', { style: styles.card }, [node('div', { style: styles.muted }, ['还没有轮次记录。'])])
      }
      const body = turns.map((turn) =>
        node('tr', {}, [
          node('td', { style: styles.td }, [
            statusBadge(
              turn.status === 'done' ? '完成' : turn.status === 'running' ? '进行中' : turn.status === 'deferred' ? '挂起' : '失败',
              turn.status === 'failed' ? 'bad' : turn.status === 'deferred' ? 'warn' : turn.status === 'done' ? 'good' : undefined,
            ),
          ]),
          node('td', { style: styles.td }, [turn.conversation]),
          node('td', { style: styles.td }, [`${turn.tokensIn || 0} / ${turn.tokensOut || 0}`]),
          node('td', { style: styles.td }, [String(turn.toolCalls || 0)]),
          node('td', { style: styles.td }, [turn.deferReason ? node('span', { style: styles.warn }, [turn.deferReason]) : node('span', { style: styles.muted }, ['—'])]),
          node('td', { style: styles.td }, [turn.error ? node('span', { style: styles.err }, [turn.error]) : node('span', { style: styles.muted }, ['—'])]),
          node('td', { style: styles.td }, [node('span', { style: styles.mono }, [String(turn.startedAt || '').slice(11, 19)])]),
        ]),
      )
      return node('div', { style: styles.card }, [
        node('div', { style: styles.metricLabel }, [`最近轮次（${turns.length} 条 · token 为 输入/输出）`]),
        node('table', { style: styles.table }, [
          node('thead', {}, [
            node('tr', {}, ['状态', '会话', 'token', '工具', '挂起原因', '错误', '开始'].map((t) => node('th', { style: styles.th }, [t]))),
          ]),
          node('tbody', {}, body),
        ]),
      ])
    }

    /** 唤醒规则表（带开关与概率输入）。 */
    function wakeRulesTable(rules, onPatch) {
      if (!rules || rules.length === 0) {
        return node('div', { style: styles.card }, [node('div', { style: styles.muted }, ['没有唤醒规则。'])])
      }
      const body = rules.map((rule) =>
        node('tr', {}, [
          node('td', { style: styles.td }, [rule.condition]),
          node('td', { style: styles.td }, [
            rule.enabled === false ? statusBadge('关闭', 'warn') : statusBadge(`${rule.probability}%`, rule.probability >= 100 ? 'good' : undefined),
          ]),
          node('td', { style: styles.td }, [
            node(
              'button',
              {
                style: Object.assign({}, styles.button, { marginRight: '6px' }),
                onClick: () => onPatch && onPatch(rule.scope || '*', rule.condition, { enabled: rule.enabled === false }),
              },
              [rule.enabled === false ? '开启' : '关闭'],
            ),
            node(
              'button',
              { style: styles.button, onClick: () => onPatch && onPatch(rule.scope || '*', rule.condition, { probability: rule.probability >= 100 ? 50 : 100 }) },
              [rule.probability >= 100 ? '降到 50%' : '提到 100%'],
            ),
          ]),
          node('td', { style: styles.td }, [rule.dailyLimit ? `每天 ${rule.dailyLimit} 次` : '不限']),
          node('td', { style: styles.td }, [node('span', { style: styles.muted }, [rule.updatedBy || 'system'])]),
        ]),
      )
      return node('div', { style: styles.card }, [
        node('div', { style: styles.metricLabel }, ['唤醒规则（每个条件互相独立；改动会留痕并报告给模型）']),
        node('table', { style: styles.table }, [
          node('thead', {}, [node('tr', {}, ['条件', '当前', '调整', '限额', '最后修改'].map((t) => node('th', { style: styles.th }, [t])))]),
          node('tbody', {}, body),
        ]),
      ])
    }

    /** 待读池。 */
    function pendingTable(items, stats) {
      const unread = stats && stats.unread !== undefined ? stats.unread : (items || []).length
      if (!items || items.length === 0) {
        return node('div', { style: styles.card }, [node('div', { style: styles.muted }, [`待读池：0 条未读（它没有错过任何东西）。`])])
      }
      return node('div', { style: styles.card }, [
        node('div', { style: styles.metricLabel }, [`待读池：${unread} 条未读（没唤醒它，但它能自己读到）`]),
      ].concat(
        items.slice(0, 20).map((item) =>
          node('div', { style: styles.mono }, [`[${String(item.at || '').slice(11, 19)}] ${item.sender_name || item.sender_id || '?'}：${item.summary}`]),
        ),
      ))
    }

    /** 后台对话（**唯一的人类直发入口**）。 */
    function adminChatBox(messages, state) {
      const draft = state && state.draft !== undefined ? state.draft : ''
      const onDraft = state && state.onDraft
      const onSend = state && state.onSend
      const busy = state && state.busy
      const list = (messages || []).map((message) =>
        node('div', { style: { marginBottom: '6px' } }, [
          node('span', { style: Object.assign({}, styles.badge, { marginRight: '6px' }) }, [message.role === 'human' ? `我（${message.actor || 'admin'}）` : '它']),
          node('span', {}, [message.text]),
          message.error ? node('span', { style: styles.err }, [` （${message.error}）`]) : node('span', {}, []),
          message.handled === false ? node('span', { style: styles.muted }, [' · 等待它看到']) : node('span', {}, []),
        ]),
      )
      return node('div', { style: styles.card }, [
        node('div', { style: styles.metricLabel }, ['后台对话（这是唯一能直接对它说人话的地方；它不会被当成 QQ 消息）']),
        node('div', { style: { maxHeight: '260px', overflowY: 'auto', margin: '8px 0' } }, list.length > 0 ? list : [node('div', { style: styles.muted }, ['还没有对话。']) ]),
        node('textarea', {
          style: styles.textarea,
          value: draft,
          placeholder: '输入要说给它听的话，回车发送…',
          onChange: (event) => onDraft && onDraft(event.target.value),
          onKeyDown: (event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              if (onSend) onSend()
            }
          },
        }),
        node('div', { style: { marginTop: '8px', display: 'flex', gap: '8px', alignItems: 'center' } }, [
          node('button', { style: styles.button, onClick: () => onSend && onSend(), disabled: busy }, [busy ? '发送中…' : '发送']),
          busy ? node('span', { style: styles.muted }, ['已入队，等网关交给模型…']) : node('span', {}, []),
        ]),
      ])
    }

    /**
     * 把 QQ 快照描述成结构树。
     * @param {object} snapshot - `{ qq, queue, turns, rules, pending, chat, error }`。
     * @param {object} [ui] - 交互回调（草稿、发送、改规则）。
     * @returns {object} 结构树。
     */
    function describeQq(snapshot, ui) {
      const qq = snapshot.qq || {}
      const transport = qq.transport || {}
      const outbox = qq.outbox || {}
      const children = [
        node('div', { style: styles.card }, [
          node('div', { style: styles.row }, [
            metric('会话', qq.sessions),
            metric('入站总数', qq.inbound),
            metric('未处理入站', qq.inboundPending),
            metric('进行中轮次', qq.turnsRunning),
            metric('挂起轮次', qq.turnsDeferred),
            metric('待发', outbox.pending),
            metric('失败', outbox.failed),
            metric('未读待读', qq.pendingUnread),
          ]),
          node('div', { style: styles.muted }, [
            transport.connectedEvidence
              ? `QQ 端近期有往来（最后入站 ${String(transport.lastInboundAt || '—').slice(0, 19)}）`
              : '⚠️ 近期没有任何 QQ 往来：要么还没登录，要么网关没在跑',
          ]),
        ]),
      ]
      if (snapshot.error !== undefined) {
        children.push(node('div', { style: styles.err }, [`读取失败：${snapshot.error}`]))
      }
      children.push(timeCard(snapshot.time))
      children.push(adminChatBox(snapshot.chat || [], ui))
      children.push(queueTable(snapshot.queue || [], snapshot.queueStats))
      children.push(turnsTable(snapshot.turns || []))
      children.push(wakeRulesTable(snapshot.rules || [], ui && ui.onPatchRule))
      children.push(pendingTable(snapshot.pending || [], snapshot.pendingStats))
      return node('div', { style: styles.wrap }, children)
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

    // ── 取数（QQ 与后台）────────────────────────────────────────────────────

    /**
     * 取一份 QQ 与后台的数据快照。
     * @param {AbortSignal} [signal] - 取消信号。
     * @returns {Promise<object>} 快照（失败时带 `error`，不抛）。
     */
    async function fetchQqSnapshot(signal) {
      const snapshot = {}
      const get = async (path) => {
        const response = await fetch(API_BASE + path, { signal })
        if (!response.ok) throw new Error(`${path} → HTTP ${response.status}`)
        return response.json()
      }
      try {
        const [qq, queue, turns, rules, pending, chat, time] = await Promise.all([
          get('/qq/state'),
          get('/qq/queue?limit=30'),
          get('/qq/turns?limit=30'),
          get('/qq/wake-rules?scope=*'),
          get('/qq/pending?limit=20'),
          get('/admin/chat?limit=50'),
          get('/time'),
        ])
        snapshot.time = time
        snapshot.qq = qq
        snapshot.queue = queue.rows || []
        snapshot.queueStats = queue.stats || {}
        snapshot.turns = turns.turns || []
        snapshot.rules = rules.rules || []
        snapshot.pending = pending.items || []
        snapshot.pendingStats = pending.stats || {}
        snapshot.chat = chat.messages || []
      } catch (error) {
        snapshot.error = String(error && error.message ? error.message : error)
      }
      return snapshot
    }

    /**
     * 往后台对话发一条消息（**唯一的人类直发通道**）。
     * @param {string} text - 正文。
     * @param {string} [actor] - 管理员标识。
     * @returns {Promise<object>} 接口返回。
     */
    async function postAdminMessage(text, actor) {
      const response = await fetch(API_BASE + '/admin/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text, actor: actor || 'admin' }),
      })
      return response.json()
    }

    /**
     * 改一条唤醒规则。
     * @param {string} scope - 作用域。
     * @param {string} condition - 条件。
     * @param {object} patch - 要改的字段。
     * @returns {Promise<object>} 接口返回。
     */
    async function patchWakeRule(scope, condition, patch) {
      const response = await fetch(API_BASE + '/qq/wake-rules', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(Object.assign({ scope, condition }, patch)),
      })
      return response.json()
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

    // ── 提示词（阶段 4）────────────────────────────────────────────────────
    //
    // 这一块的设计目标只有一个：让人**敢改**。
    // 提示词是最容易改坏的东西（它直接决定模型怎么说话），所以界面上必须始终看得见
    // 三件事：现在是什么、改完会变成什么、改坏了怎么回去。

    /** 时间感知卡（阶段 4）：最新读数年龄、注入成本、漂移。 */
    function timeCard(time) {
      if (!time) return node('div', {}, [])
      const latest = time.latest
      const settings = time.settings || {}
      const drift = time.drift || {}
      const children = [
        node('div', { style: styles.metricLabel }, ['时间感知']),
        node('div', { style: styles.row }, [
          metric('最新读数', latest ? (latest.fresh ? '新鲜' : '偏旧') : '无'),
          metric('年龄', latest ? `${Math.round((latest.ageMs || 0) / 1000)} 秒` : '—'),
          metric('注入次数', (time.readings || []).length ? time.readings.length : (time.byReason || []).reduce((n, r) => n + (r.count || 0), 0)),
          metric('注入 token', time.tokenCost),
          metric('时间漂移', drift.count ? `${drift.count} 次` : '0 次'),
        ]),
        node('div', { style: styles.muted }, [
          `时区：记录 ${settings.systemTimezone}｜会话 ${settings.conversationTimezone}｜展示 ${settings.displayTimezone}（${settings.hour24 ? '24' : '12'} 小时制）`,
        ]),
      ]
      if (latest) {
        children.push(
          node('div', { style: styles.mono }, [
            `最近一次读数：${String(latest.at).slice(11, 19)} UTC｜原因 ${latest.reason}｜时区 ${latest.timezone}`,
          ]),
        )
        if (!latest.fresh) {
          children.push(node('div', { style: styles.warn }, ['⚠️ 最新读数已偏旧 —— 若模型刚回答过时间问题，可能拿到的是陈旧读数。']))
        }
      } else {
        children.push(node('div', { style: styles.muted }, ['还没有时间读数（跑过一轮真实对话后才有）。']))
      }
      if (drift.count) {
        children.push(
          node('div', { style: drift.maxMs && drift.maxMs > 3_600_000 ? styles.err : styles.warn }, [
            `时间漂移 ${drift.count} 次，平均 ${Math.round((drift.avgMs || 0) / 1000)} 秒、最大 ${Math.round((drift.maxMs || 0) / 1000)} 秒`,
          ]),
        )
      }
      if ((time.clocks || []).length > 0) {
        children.push(
          node('div', { style: styles.mono }, [
            `按会话时区：${(time.clocks || []).map((c) => `${c.scope}=${c.timezone}(${c.source})`).join('，')}`,
          ]),
        )
      }
      return node('div', { style: styles.card }, children)
    }
    /** 一个槽位的编辑器。 */
    function promptEditor(title, slug, text, ui, meta) {
      const onDraft = ui && ui.onDraft
      const onPreview = ui && ui.onPreview
      const onSave = ui && ui.onSave
      const busy = ui && ui.busy
      const dirty = ui && ui.dirty && ui.dirty[slug] === true
      return node('div', { style: styles.card }, [
        node('div', { style: styles.row }, [
          node('div', { style: styles.metricLabel }, [title]),
          node('span', {}, [slug === 'p1-system' ? node('span', { style: styles.muted }, ['（决定它是谁、边界在哪）']) : node('span', { style: styles.muted }, ['（决定它怎么说话）'])]),
        ]),
        node('div', { style: styles.row }, [
          metric('当前 token', meta && meta.tokenCount),
          metric('生效版本', meta && meta.revisions),
          metric('未保存改动', dirty ? '有' : '无'),
        ]),
        node('textarea', {
          style: Object.assign({}, styles.textarea, { minHeight: '220px' }),
          value: text || '',
          onChange: (event) => onDraft && onDraft(slug, event.target.value),
          spellcheck: false,
        }),
        node('div', { style: { marginTop: '8px', display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } }, [
          node('button', { style: styles.button, disabled: busy, onClick: () => onPreview && onPreview(slug) }, ['预览']),
          node('button', { style: Object.assign({}, styles.button, { fontWeight: 600 }), disabled: busy, onClick: () => onSave && onSave(slug) }, [busy ? '处理中…' : '保存并生效']),
          dirty
            ? node('span', { style: styles.warn }, ['有未保存改动 —— 保存将使**下一轮**前缀变化（一次缓存未命中），之后恢复稳定。'])
            : node('span', { style: styles.muted }, ['当前内容已生效。']),
        ]),
      ])
    }

    /** 预览卡：最终拼装结果 + diff。 */
    function promptPreviewCard(preview) {
      if (!preview) {
        return node('div', { style: styles.card }, [node('div', { style: styles.muted }, ['点「预览」看看最终拼装结果与改动差异。'])])
      }
      if (preview.error !== undefined) {
        return node('div', { style: styles.card }, [node('div', { style: styles.err }, [`预览失败：${preview.error}`])])
      }
      const errors = (preview.errors || []).map((e) => node('div', { style: styles.err }, [`✗ ${e}`]))
      const warnings = (preview.warnings || []).map((wn) => node('div', { style: styles.warn }, [`! ${wn}`]))
      return node('div', { style: styles.card }, [
        node('div', { style: styles.metricLabel }, [
          `预览（${preview.slug}）｜token ${preview.tokenCount}${preview.tokenDelta ? `（${preview.tokenDelta > 0 ? '+' : ''}${preview.tokenDelta}）` : ''}｜` +
            (preview.willChange ? '会改变前缀 ⇒ 一次缓存未命中' : '与当前生效版本一致 ⇒ 不会造成未命中'),
        ]),
      ]
        .concat(errors)
        .concat(warnings)
        .concat(
          (preview.diff || []).length === 0
            ? [node('div', { style: styles.muted }, ['没有差异。'])]
            : [node('div', { style: { maxHeight: '220px', overflowY: 'auto', marginTop: '6px' } }, (preview.diff || []).map((line) =>
                node('div', {
                  style: Object.assign({}, styles.mono, {
                    color: line.kind === 'added' ? '#16a34a' : line.kind === 'removed' ? '#dc2626' : undefined,
                    opacity: line.kind === 'same' ? 0.75 : 1,
                  }),
                }, [`${line.kind === 'added' ? '+ ' : line.kind === 'removed' ? '- ' : '  '}${line.text}`]),
              ))],
        )
        .concat([
          node('div', { style: styles.metricLabel }, ['最终拼装结果（变量已替换）']),
          node('div', { style: Object.assign({}, styles.mono, { whiteSpace: 'pre-wrap', maxHeight: '240px', overflowY: 'auto' }) }, [preview.rendered || '']),
        ]))
    }

    /** 历史版本卡（带一键回滚）。 */
    function promptHistoryCard(revisions, ui) {
      if (!revisions || revisions.length === 0) {
        return node('div', { style: styles.card }, [node('div', { style: styles.muted }, ['还没有历史版本。'])])
      }
      const onRollback = ui && ui.onRollback
      return node('div', { style: styles.card }, [
        node('div', { style: styles.metricLabel }, [`历史版本（${revisions.length} 版，回滚同样会造成一次缓存未命中）`]),
        node('table', { style: styles.table }, [
          node('thead', {}, [node('tr', {}, ['状态', '时间', '改的人', 'token', '摘要', '操作'].map((t) => node('th', { style: styles.th }, [t])))]),
          node('tbody', {}, revisions.map((r) =>
            node('tr', {}, [
              node('td', { style: styles.td }, [r.active ? statusBadge('生效中', 'good') : statusBadge('历史', undefined)]),
              node('td', { style: styles.td }, [node('span', { style: styles.mono }, [String(r.createdAt || '').slice(0, 19).replace('T', ' ')])]),
              node('td', { style: styles.td }, [r.createdBy || '—']),
              node('td', { style: styles.td }, [String(r.tokenCount)]),
              node('td', { style: styles.td }, [node('span', { style: styles.muted }, [String(r.excerpt || '')])]),
              node('td', { style: styles.td }, [
                r.active ? node('span', { style: styles.muted }, ['—']) : node('button', { style: styles.button, onClick: () => onRollback && onRollback(r.id) }, ['回滚到这版']),
              ]),
            ]),
          )),
        ]),
      ])
    }

    /** 变量白名单卡（写提示词时对着看，避免写出未知变量）。 */
    function promptVariablesCard(variables) {
      const list = variables || []
      return node('div', { style: styles.card }, [
        node('div', { style: styles.metricLabel }, ['可用变量（写 {{名字}} 会被替换成实际值）']),
      ].concat(
        list.map((v) =>
          node('div', { style: styles.mono }, [
            node('span', { style: Object.assign({}, styles.badge, { marginRight: '6px', color: v.dynamic ? '#d97706' : '#2563eb' }) }, [v.dynamic ? '动态' : '稳定']),
            `{{${v.name}}} —— ${v.description}`,
            v.dynamic ? node('span', { style: styles.warn }, ['（不能用在稳定前缀里：会让每轮前缀都变）']) : node('span', {}, []),
          ]),
        ),
      ))
    }

    /**
     * 把提示词快照描述成结构树。
     * @param {object} snapshot - `{ prompts, revisions, variables, preview, drafts, dirty }`。
     * @param {object} [ui] - 交互回调。
     * @returns {object} 结构树。
     */
    /** 「模型与路由」页（阶段 5）：聚合模型列表 + 角色映射 + 校验 + 试跑。 */
    function describeRoutes(snapshot) {
      if (!snapshot || snapshot.ok === false) {
        return node('div', { style: styles.err }, [`读取路由失败：${(snapshot && snapshot.error) || '未知错误'}`])
      }
      const children = []
      const overview = snapshot.overview || {}
      const stats = snapshot.stats || {}
      const devices = snapshot.devices || {}
      const issues = snapshot.issues || []
      const override = snapshot.tierOverride

      children.push(
        node('div', { style: styles.card }, [
          node('div', { style: styles.metricLabel }, ['模型与路由']),
          node('div', { style: styles.row }, [
            metric('端点', overview.total || 0),
            metric('近 24h 决策', stats.total || 0),
            metric('降级率', `${Math.round((stats.degradedRate || 0) * 100)}%`),
            metric('待复盘案例', (snapshot.uncertain || {}).pending || 0),
          ]),
          node('div', { style: styles.muted }, [
            override
              ? `当前档位被**手动切到 ${override.tier}**（${override.reason}）—— 换模型会作废上下文缓存，不需要了请撤销`
              : '当前档位由自动判定（守卫 → 评分器 → 启发式）',
          ]),
          node('div', { style: styles.mono }, [
            `设备探测：渲染节点 ${(devices.renderNodes || []).join(',') || '无'}｜NVIDIA ${devices.nvidia ? '有' : '无'}｜ROCm ${devices.rocm ? '有' : '无'}｜Intel ${devices.intel ? '有' : '无'}｜Vulkan ${devices.vulkan ? '有' : '无'}`,
          ]),
        ]),
      )

      if (issues.length > 0) {
        children.push(
          node('div', { style: styles.card }, [
            node('div', { style: styles.metricLabel }, [`校验问题（${issues.length}）`]),
            node('div', { style: styles.muted }, ['这些是"保存即报错"的规则提前算出来的 —— 不必等到点了保存才知道。']),
            ...issues.slice(0, 8).map((issue) =>
              node('div', { style: issue.severity === 'error' ? styles.err : styles.warn }, [
                `[${issue.endpoint}] ${issue.field}：${issue.message}`,
              ]),
            ),
          ]),
        )
      }

      if ((overview.backendMismatch || []).length > 0) {
        children.push(
          node('div', { style: styles.card }, [
            node('div', { style: styles.metricLabel }, ['实际生效后端 ≠ 声明后端']),
            node('div', { style: styles.warn }, [
              '这些端点声明的加速后端没有真的生效（常见原因：镜像静默回落到 CPU）。面板显示"cuda 加速中"而实际在慢跑，是必须被看见的。',
            ]),
            ...overview.backendMismatch.map((item) =>
              node('div', { style: styles.mono }, [`${item.id}：声明 ${item.declared} → 实际 ${item.effective}`]),
            ),
          ]),
        )
      }

      for (const role of snapshot.roles || []) {
        children.push(
          node('div', { style: styles.card }, [
            node('div', { style: styles.metricLabel }, [`${role.role}${role.purpose ? ` —— ${role.purpose}` : ''}`]),
            role.candidates.length === 0
              ? node('div', { style: role.gapLevel === 'required' ? styles.warn : styles.muted }, [
                  role.gapLevel === 'required'
                    ? `还没配置候选模型 —— ${role.gapHint || '会影响主对话路由'}`
                    : `需要时再配：${role.gapHint || '目前用不到它'}`,
                ])
              : node(
                  'div',
                  {},
                  role.candidates.map((candidate, index) =>
                    node('div', { style: candidate.enabled ? styles.mono : styles.muted }, [
                      `${index === 0 ? '主选' : `备选${index}`}：${candidate.provider}/${candidate.model}${candidate.effort ? `（${candidate.effort}）` : ''}${candidate.enabled ? '' : ' [已关闭]'}${candidate.note ? ` — ${candidate.note}` : ''}`,
                    ]),
                  ),
                ),
          ]),
        )
      }

      const endpoints = snapshot.endpoints || []
      if (endpoints.length > 0) {
        children.push(node('div', { style: styles.metricLabel }, ['端点']))
        for (const endpoint of endpoints) {
          const health = endpoint.health || {}
          const rows = [
            node('div', { style: styles.mono }, [`${endpoint.type}｜${endpoint.mode}｜后端 ${endpoint.backend}｜${endpoint.baseUrl}`]),
            node('div', { style: styles.muted }, [
              `部署目标 ${endpoint.deployTarget || '未登记'}${endpoint.deployHost ? ` @ ${endpoint.deployHost}` : ''}｜模型 ${(endpoint.models || []).length} 个`,
            ]),
          ]
          if (health.checkedAt) {
            rows.push(
              node('div', { style: health.ok ? styles.mono : styles.err }, [
                `健康 ${health.ok ? '正常' : '异常'}${health.latencyMs !== undefined && health.latencyMs !== null ? `｜${health.latencyMs}ms` : ''}${health.note ? `｜${health.note}` : ''}`,
              ]),
            )
          } else {
            rows.push(node('div', { style: styles.muted }, ['还没试跑过 —— 点"试一次"能看到真实延迟']))
          }
          if (health.effectiveBackend && health.effectiveBackend !== endpoint.backend) {
            rows.push(node('div', { style: styles.warn }, [`实际生效后端是 ${health.effectiveBackend}（声明的是 ${endpoint.backend}）`]))
          }
          children.push(node('div', { style: styles.card }, [node('div', { style: styles.metricLabel }, [endpoint.id]), ...rows]))
        }
      } else {
        children.push(
          node('div', { style: styles.card }, [
            node('div', { style: styles.muted }, [
              '还没有登记任何推理端点。评分器、视觉桥接、嵌入都需要端点 —— 可以先登记一个"外挂自建"（不需要本地部署）。',
            ]),
          ]),
        )
      }

      const probes = snapshot.probe || []
      if (probes.length > 0) {
        children.push(
          node('div', { style: styles.card }, [
            node('div', { style: styles.metricLabel }, ['试跑记录']),
            ...probes.slice(0, 5).map((probe) =>
              node('div', { style: probe.ok ? styles.mono : styles.err }, [
                `${String(probe.at).slice(11, 19)} UTC｜${probe.endpointId}｜${probe.ok ? `${probe.latencyMs}ms` : '失败'}${probe.note ? `｜${probe.note}` : ''}`,
              ]),
            ),
          ]),
        )
      }

      return node('div', {}, children)
    }

    function describePrompts(snapshot, ui) {
      const slugs = snapshot.prompts || []
      const find = (slug) => slugs.find((s) => s.slug === slug) || {}
      const drafts = (ui && ui.drafts) || {}
      const dirty = (ui && ui.dirty) || {}
      const children = [
        node('div', { style: styles.card }, [
          node('div', { style: styles.row }, [
            metric('P1 token', find('p1-system').tokenCount),
            metric('P2 token', find('p2-style').tokenCount),
            metric('覆盖数', (snapshot.overrides || []).length),
            metric('历史版本', slugs.reduce((sum, s) => sum + (s.revisions || 0), 0)),
          ]),
          node('div', { style: styles.muted }, [
            '提示词改动**下一轮生效**（无需重启）。未保存改动与已保存版本之间的差别，可以用「预览」看清。',
          ]),
        ]),
      ]
      if (snapshot.error !== undefined) {
        children.push(node('div', { style: styles.err }, [`读取失败：${snapshot.error}`]))
      }
      if (ui && ui.notice) children.push(node('div', { style: styles.card }, [node('div', { style: styles.muted }, [ui.notice])]))

      children.push(promptEditor('P1 系统提示词', 'p1-system', drafts['p1-system'], Object.assign({ dirty }, ui), find('p1-system')))
      children.push(promptEditor('P2 回答风格', 'p2-style', drafts['p2-style'], Object.assign({ dirty }, ui), find('p2-style')))
      children.push(promptPreviewCard(snapshot.preview))
      children.push(promptHistoryCard(snapshot.revisions, ui))
      children.push(promptVariablesCard(snapshot.variables))
      return node('div', { style: styles.wrap }, children)
    }
    // ── 取数（提示词）──────────────────────────────────────────────────────

    /**
     * 取一份提示词快照（含两个槽位、历史版本、变量白名单）。
     * @param {AbortSignal} [signal] - 取消信号。
     * @returns {Promise<object>} 快照（失败时带 `error`，不抛）。
     */
    /**
     * 取路由快照。
     *
     * 前端只做"展示 + 发意图"，不做判断：校验规则在服务端（保存即报错），
     * 前端再算一遍会出现"两边规则不一致"这种最难查的问题。
     */
    async function fetchRoutesSnapshot(signal) {
      try {
        const response = await fetch(API_BASE + '/routes', { signal })
        if (!response.ok) throw new Error(`/routes → HTTP ${response.status}`)
        return await response.json()
      } catch (error) {
        return { ok: false, error: String(error) }
      }
    }

    async function fetchPromptSnapshot(signal) {
      const snapshot = {}
      const get = async (path) => {
        const response = await fetch(API_BASE + path, { signal })
        if (!response.ok) throw new Error(`${path} → HTTP ${response.status}`)
        return response.json()
      }
      try {
        const [prompts, p1, p2] = await Promise.all([
          get('/prompts'),
          get('/prompts/revisions?slug=p1-system&limit=20'),
          get('/prompts/revisions?slug=p2-style&limit=20'),
        ])
        snapshot.prompts = prompts.slugs || []
        snapshot.variables = prompts.variables || []
        snapshot.overrides = prompts.overrides || []
        snapshot.revisions = [...(p1.revisions || []), ...(p2.revisions || [])].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
        snapshot.activeText = Object.fromEntries((prompts.slugs || []).map((s) => [s.slug, s.text || '']))
      } catch (error) {
        snapshot.error = String(error && error.message ? error.message : error)
      }
      return snapshot
    }

    /**
     * 预览一份提示词（返回最终拼装结果、diff、token 与缓存影响）。
     * @param {string} slug - 槽位。
     * @param {string} text - 文本。
     * @returns {Promise<object>} 预览结果。
     */
    async function previewPrompt(slug, text) {
      const response = await fetch(API_BASE + '/prompts/preview', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ slug, text }),
      })
      const body = await response.json()
      return Object.assign({ slug }, body)
    }

    /**
     * 保存一份提示词。
     * @param {string} slug - 槽位。
     * @param {string} text - 文本。
     * @returns {Promise<object>} 接口返回。
     */
    async function savePrompt(slug, text) {
      const response = await fetch(API_BASE + '/prompts', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ slug, text }),
      })
      return response.json()
    }

    /**
     * 回滚到一个历史版本。
     * @param {string} revisionId - 版本 id。
     * @returns {Promise<object>} 接口返回。
     */
    async function rollbackPromptRevision(revisionId) {
      const response = await fetch(API_BASE + '/prompts/rollback', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ revisionId }),
      })
      return response.json()
    }
    /** 提示词面板：编辑 P1/P2、预览、保存、回滚。 */
    /** 「模型与路由」页组件：只做展示与"发意图"，判断都在服务端。 */
    function RoutesPanel() {
      const [snapshot, setSnapshot] = React.useState({})
      const [loading, setLoading] = React.useState(true)
      const [busy, setBusy] = React.useState('')
      const [notice, setNotice] = React.useState('')

      const load = React.useCallback(async () => {
        setLoading(true)
        setSnapshot(await fetchRoutesSnapshot())
        setLoading(false)
      }, [])

      React.useEffect(() => {
        void load()
      }, [load])

      const send = React.useCallback(
        async (path, body) => {
          setBusy(path)
          setNotice('')
          try {
            const response = await fetch(API_BASE + path, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(body),
            })
            const result = await response.json()
            setNotice(result && result.ok ? '完成' : `未完成：${(result && (result.error || result.note)) || '未知原因'}`)
            await load()
          } catch (error) {
            setNotice(`请求失败：${String(error)}`)
          } finally {
            setBusy('')
          }
        },
        [load],
      )

      if (loading) return node('div', { style: styles.muted }, ['加载中…'])

      const children = [describeRoutes(snapshot)]
      if (notice) children.push(node('div', { style: styles.muted }, [notice]))

      const endpoints = snapshot.endpoints || []
      if (endpoints.length > 0) {
        children.push(
          node('div', { style: styles.card }, [
            node('div', { style: styles.metricLabel }, ['端点操作']),
            node('div', { style: styles.muted }, [
              '试跑 = 真发一次请求（记录真实延迟）；模式切换对容器端点需要容器执行器，没接上时会**明确失败**而不是假装成功。',
            ]),
            ...endpoints.slice(0, 6).flatMap((endpoint) =>
              node('div', { style: styles.row }, [
                node('span', { style: styles.mono }, [endpoint.id]),
                node(
                  'button',
                  {
                    disabled: busy !== '',
                    onClick: () => void send('/routes/probe', { endpointId: endpoint.id }),
                  },
                  ['试一次'],
                ),
                node(
                  'button',
                  {
                    disabled: busy !== '',
                    onClick: () => void send('/routes/mode', { endpointId: endpoint.id, mode: 'resident', reason: '面板手动切换为常驻' }),
                  },
                  ['常驻'],
                ),
                node(
                  'button',
                  {
                    disabled: busy !== '',
                    onClick: () => void send('/routes/mode', { endpointId: endpoint.id, mode: 'on-demand', reason: '面板手动切换为按需' }),
                  },
                  ['按需'],
                ),
              ]),
            ),
          ]),
        )
      }

      return node('div', {}, children)
    }

    function PromptPanel() {
      const [snapshot, setSnapshot] = React.useState({})
      const [loading, setLoading] = React.useState(true)
      const [drafts, setDrafts] = React.useState({})
      const [dirty, setDirty] = React.useState({})
      const [preview, setPreview] = React.useState(undefined)
      const [busy, setBusy] = React.useState(false)
      const [notice, setNotice] = React.useState('')

      const load = React.useCallback(async () => {
        const next = await fetchPromptSnapshot()
        setSnapshot(next)
        // 首次加载与保存后：草稿对齐到服务端的生效内容
        const texts = next.activeText || {}
        setDrafts((current) => {
          const merged = Object.assign({}, current)
          for (const slug of ['p1-system', 'p2-style']) {
            if (merged[slug] === undefined && texts[slug] !== undefined) merged[slug] = texts[slug]
          }
          return merged
        })
        setLoading(false)
        return next
      }, [])

      React.useEffect(() => {
        void load()
      }, [load])

      const onDraft = React.useCallback((slug, text) => {
        setDrafts((current) => Object.assign({}, current, { [slug]: text }))
        setDirty((current) => Object.assign({}, current, { [slug]: true }))
      }, [])

      const onPreview = React.useCallback(async (slug) => {
        setBusy(true)
        try {
          setPreview(await previewPrompt(slug, drafts[slug] || ''))
        } finally {
          setBusy(false)
        }
      }, [drafts])

      const onSave = React.useCallback(async (slug) => {
        setBusy(true)
        try {
          const result = await savePrompt(slug, drafts[slug] || '')
          if (result.ok === false) {
            setNotice(`保存被拒：${(result.errors || [result.error]).join('；')}`)
            setPreview(Object.assign({ slug }, result, { errors: result.errors || [result.error] }))
            return
          }
          setDirty((current) => Object.assign({}, current, { [slug]: false }))
          setNotice(result.changed === false ? String(result.note || '内容未变，没有产生新版本。') : `${slug} 已保存，下一轮生效。${result.cacheNote || ''}`)
          const next = await load()
          setDrafts((current) => Object.assign({}, current, { [slug]: (next.activeText || {})[slug] || current[slug] }))
        } finally {
          setBusy(false)
        }
      }, [drafts, load])

      const onRollback = React.useCallback(async (revisionId) => {
        setBusy(true)
        try {
          const result = await rollbackPromptRevision(revisionId)
          setNotice(result.ok === false ? `回滚失败：${result.error}` : `已回滚，下一轮生效。${result.cacheNote || ''}`)
          const next = await load()
          setDrafts({ 'p1-system': (next.activeText || {})['p1-system'] || '', 'p2-style': (next.activeText || {})['p2-style'] || '' })
          setDirty({})
        } finally {
          setBusy(false)
        }
      }, [load])

      if (loading) return jsx('div', { style: { opacity: 0.6 }, children: '正在读取提示词…' })
      return renderPanel(jsx, describePrompts(snapshot, { drafts, dirty, preview, busy, notice, onDraft, onPreview, onSave, onRollback }))
    }
    /** QQ 与后台面板：取数 + 交互（改规则、发消息）。 */
    function QqPanel() {
      const [snapshot, setSnapshot] = React.useState({})
      const [loading, setLoading] = React.useState(true)
      const [draft, setDraft] = React.useState('')
      const [busy, setBusy] = React.useState(false)

      const reload = React.useCallback(async () => {
        const next = await fetchQqSnapshot()
        setSnapshot(next)
        setLoading(false)
      }, [])

      React.useEffect(() => {
        let alive = true
        const load = async () => {
          const next = await fetchQqSnapshot()
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
        }
      }, [])

      const send = React.useCallback(async () => {
        const text = draft.trim()
        if (text === '') return
        setBusy(true)
        try {
          await postAdminMessage(text, 'admin')
          setDraft('')
          await reload()
        } finally {
          setBusy(false)
        }
      }, [draft, reload])

      const onPatchRule = React.useCallback(
        async (scope, condition, patch) => {
          await patchWakeRule(scope, condition, patch)
          await reload()
        },
        [reload],
      )

      if (loading) return jsx('div', { style: { opacity: 0.6 }, children: '正在读取 QQ 网关状态…' })
      return renderPanel(jsx, describeQq(snapshot, { draft, onDraft: setDraft, onSend: send, busy, onPatchRule }))
    }

    /**
     * 安装面板（宿主调用）。
     *
     * 注册**两个**设置区块：「记忆」看记忆本体，「QQ 与后台」看网关与人类直发通道。
     * 刻意不塞进一个区块：这两块的使用场景不同（一个是理解它记得什么，
     * 一个是排障与跟它说话），混在一起两边都难用。
     *
     * @param {object} ctx - 浏览器侧 cordis 上下文。
     */
    function apply(ctx) {
      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          { name: 'settings.section', id: 'forlife-memory', order: 60, label: '记忆' },
          MemoryPanel,
        ),
      )
      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          { name: 'settings.section', id: 'forlife-qq', order: 61, label: 'QQ 与后台' },
          QqPanel,
        ),
      )
      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          { name: 'settings.section', id: 'forlife-prompts', order: 62, label: '提示词' },
          PromptPanel,
        ),
      )
      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          { name: 'settings.section', id: 'forlife-routes', order: 63, label: '模型与路由' },
          RoutesPanel,
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
    exports.QqPanel = QqPanel
    exports.fetchQqSnapshot = fetchQqSnapshot
    exports.describeQq = describeQq
    exports.postAdminMessage = postAdminMessage
    exports.patchWakeRule = patchWakeRule
    exports.PromptPanel = PromptPanel
    exports.RoutesPanel = RoutesPanel
    exports.fetchPromptSnapshot = fetchPromptSnapshot
    exports.describePrompts = describePrompts
    exports.describeRoutes = describeRoutes
    exports.fetchRoutesSnapshot = fetchRoutesSnapshot
    exports.previewPrompt = previewPrompt
    exports.savePrompt = savePrompt
    exports.rollbackPromptRevision = rollbackPromptRevision
    return module.exports
  },
})





