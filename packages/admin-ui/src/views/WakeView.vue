<script setup lang="ts">
/**
 * 唤醒 —— "什么时候会主动说话"的观察面。
 *
 * 这一页首要回答的问题**不是**"有哪些规则"，而是"**这条消息为什么没触发回复**"。
 * 所以顺序是：规则的规模（总数 / 启用 / 被覆盖）→ 按会话类型分组的条件矩阵
 * （概率与作用域一眼可见）→ 判定留痕。
 *
 * 真正回答"为什么没醒"的是**留痕**，不是规则表：一条 skip 留痕会写明是规则停用、
 * 概率未命中、静默期、频率限制还是预算不足；规则表只说明"配了什么"。
 */
import { useContextMenu, type ContextMenuItem } from '../composables/useContextMenu.ts'
import { computed, reactive, ref } from 'vue'

import { api } from '../api/client.ts'
import type { WakeEventItem, WakeGroup, WakeOverview } from '../api/types-wake.ts'
import AsyncSection from '../components/AsyncSection.vue'
import ContextMenu from '../components/ContextMenu.vue'
import DataTable, { type TableColumn } from '../components/DataTable.vue'
import PanelCard from '../components/PanelCard.vue'
import StatCard from '../components/StatCard.vue'
import StatusBadge from '../components/StatusBadge.vue'
import { useAsyncData } from '../composables/useAsyncData.ts'
import { formatDateTime, formatDuration, formatNumber, formatPercent, formatRelative } from '../utils/format.ts'

/**
 * 编辑与右键菜单。
 *
 * 两个刻意的做法：
 *  - **菜单动作与页面按钮调用同一个函数**（都走 openEdit / toggleRule）。
 *    分成两套的话，菜单里改了 A、按钮里改了 B，最后没人知道哪个是对的。
 *  - 菜单项里带上"当前状态"作为 hint（如"当前已启用"），
 *    这样菜单本身就说明了它会对什么生效，不用先去看表格。
 */
const { state: menuState, onContextMenu, touchHandlers, close: closeMenu, clampToViewport } = useContextMenu()

const editing = ref<Record<string, unknown> | null>(null)
const saving = ref(false)
const saveError = ref('')
const form = reactive({ enabled: false, probability: 0, minIntervalSeconds: 0, dailyLimit: 0 })

function ruleKey(row: Record<string, unknown>): string {
  return `${String(row['scope'])}/${String(row['condition'])}`
}

/** 打开编辑弹层（菜单与按钮共用）。 */
function openEdit(row: Record<string, unknown>): void {
  editing.value = row
  saveError.value = ''
  form.enabled = row['enabled'] === true
  form.probability = Number(row['probability'])
  form.minIntervalSeconds = Math.round(Number(row['minIntervalMs']) / 1000)
  form.dailyLimit = Number(row['dailyLimit'])
}

/** 快速切换启用（菜单与按钮共用）。 */
async function toggleRule(row: Record<string, unknown>): Promise<void> {
  await postRule(row, { enabled: row['enabled'] !== true })
}

/** 真正落库。 */
async function postRule(row: Record<string, unknown>, patch: Record<string, unknown>): Promise<void> {
  saving.value = true
  saveError.value = ''
  try {
    await api.post('/wake-rule', { scope: row['scope'], condition: row['condition'], ...patch })
    editing.value = null
    state.refresh()
  } catch (error) {
    // **必须显示错误**：静默失败会让用户以为保存成功了
    saveError.value = error instanceof Error ? error.message : String(error)
  } finally {
    saving.value = false
  }
}

async function saveRule(): Promise<void> {
  if (editing.value === null) return
  await postRule(editing.value, {
    enabled: form.enabled,
    probability: form.probability,
    minIntervalMs: Math.max(0, Math.round(form.minIntervalSeconds * 1000)),
    dailyLimit: form.dailyLimit,
  })
}

/** 右键/长按菜单项（与按钮共用同一批函数）。 */
function ruleMenuItems(row: Record<string, unknown>): ContextMenuItem[] {
  const enabled = row['enabled'] === true
  return [
    { key: 'edit', label: '编辑…', hint: '改概率/间隔/日限', run: () => openEdit(row) },
    {
      key: 'toggle',
      label: enabled ? '停用' : '启用',
      hint: enabled ? '当前已启用' : '当前已停用',
      run: () => toggleRule(row),
    },
    {
      key: 'copy',
      label: '复制条件名',
      run: () => {
        void navigator.clipboard?.writeText(String(row['condition']))
      },
    },
  ]
}

const state = useAsyncData<WakeOverview>(() => api.get<WakeOverview>('/wake'))

interface StatItem {
  readonly label: string
  readonly value: string
  readonly hint: string
  readonly tone: 'neutral' | 'ok' | 'warn'
  readonly icon: string
}

/**
 * 顶部统计。
 *
 * 第三个数字（被覆盖的）是排查入口：作用域不是 `*` 的规则只对某一个会话生效，
 * "为什么这个群不响应"的答案往往就在那几条里 —— 先看数量，再去规则明细按作用域找。
 */
const stats = computed<StatItem[]>(() => {
  const data = state.data.value
  if (data === undefined) return []
  const skipped = data.events.filter((event) => event.decision === 'skip').length
  return [
    {
      label: '规则总数',
      value: formatNumber(data.stats.total),
      hint: '按 (作用域, 条件) 逐条计数',
      tone: 'neutral',
      icon: 'routing',
    },
    {
      label: '已启用',
      value: formatNumber(data.stats.enabled),
      hint: `停用 ${formatNumber(data.stats.total - data.stats.enabled)} 条`,
      tone: data.stats.total > 0 && data.stats.enabled === 0 ? 'warn' : 'ok',
      icon: 'check',
    },
    {
      label: '被覆盖的',
      value: formatNumber(data.stats.overridden),
      hint: '作用域不是 * 的规则，只对那个会话生效',
      tone: 'neutral',
      icon: 'lock',
    },
    {
      label: '判定留痕',
      value: formatNumber(data.events.length),
      hint: `本页取回 ${formatNumber(skipped)} 条未唤醒`,
      tone: 'neutral',
      icon: 'logs',
    },
  ]
})

/** 四个会话类型分组。服务端固定返回四个（空组也保留），所以这里不担心"这一块今天不存在"。 */
const groups = computed<readonly WakeGroup[]>(() => state.data.value?.groups ?? [])

/** 分组副标题：条件数 + 启用数（空组显示 0，而不是把面板藏掉）。 */
function groupSubtitle(group: WakeGroup): string {
  const enabled = group.rules.filter((rule) => rule.enabled).length
  return `${formatNumber(group.rules.length)} 个条件 · ${formatNumber(enabled)} 个启用`
}

/** 概率是 0-100 的整数；越界或 NaN 一律夹回合法区间，别让服务端的脏值决定布局。 */
function probabilityWidth(probability: number): string {
  const value = Number.isFinite(probability) ? Math.min(100, Math.max(0, probability)) : 0
  return `${value}%`
}

/** 概率文案（库里是 0-100，`formatPercent` 要的是 0-1）。 */
function probabilityText(probability: number): string {
  return formatPercent(probability / 100, 0)
}

/**
 * 判定原因 → 给人看的一句话。
 *
 * `reason` 在库里是**开放集合**（建表注释列了 disabled | probability | quiet_hours |
 * rate_limit | budget | matched）。这里只翻译认识的取值，其余原样显示 ——
 * 硬编码清单漏掉一个，新原因在面板上就会变成一句看不懂的英文，而不是一句错话。
 * 原始取值始终跟在中文后面（等宽小字），翻译不会掩盖真相。
 */
const REASON_LABELS: Record<string, string> = {
  matched: '条件命中：这一轮会主动说话',
  disabled: '规则被停用：这条条件当前不生效',
  probability: '概率未命中：触发概率这次没抽中',
  quiet_hours: '处于静默期：静默截止之前不打扰',
  rate_limit: '触发太频繁：撞上最小间隔或当日上限',
  budget: '预算不足：这一轮不让它说话',
}
function reasonLabel(reason: string): string {
  return REASON_LABELS[reason] ?? reason
}

/** 留痕的本地筛选。默认"全部"，但排障时最常用的其实是"未唤醒"（找 skip）。 */
const DECISION_FILTERS = [
  { value: 'all', label: '全部' },
  { value: 'skip', label: '未唤醒' },
  { value: 'wake', label: '已唤醒' },
] as const
const decisionFilter = ref<(typeof DECISION_FILTERS)[number]['value']>('all')
const keyword = ref('')

const events = computed<readonly WakeEventItem[]>(() => {
  const list = state.data.value?.events ?? []
  const needle = keyword.value.trim().toLowerCase()
  return list.filter((event) => {
    if (decisionFilter.value !== 'all' && event.decision !== decisionFilter.value) return false
    if (needle === '') return true
    // 中文解释也参与搜索：人记得住的是"静默期"，记不住 `quiet_hours`
    return (
      event.scope.toLowerCase().includes(needle) ||
      event.condition.toLowerCase().includes(needle) ||
      event.reason.toLowerCase().includes(needle) ||
      reasonLabel(event.reason).toLowerCase().includes(needle) ||
      (event.conversationKey ?? '').toLowerCase().includes(needle)
    )
  })
})

/** 服务端这次到底给没给留痕 —— 用来区分"还没有记录"和"被筛没了"（两者要说不同的话）。 */
const hasAnyEvent = computed(() => (state.data.value?.events.length ?? 0) > 0)

/**
 * 先只铺出最近这些条。
 *
 * 留痕按时间倒序，要查的几乎总在最上面几条（"刚刚这条为什么没醒"）；一次铺 100 条，
 * 在手机上要滑很久才能到底。展开只是本地渲染开关，不改取数、也不隐藏条数。
 */
const COLLAPSED_EVENT_COUNT = 30
const expanded = ref(false)
const visibleEvents = computed<readonly WakeEventItem[]>(() =>
  expanded.value ? events.value : events.value.slice(0, COLLAPSED_EVENT_COUNT),
)
const hiddenEventCount = computed(() => events.value.length - visibleEvents.value.length)

/**
 * 表格行必须是 `Record<string, unknown>`（DataTable 要按任意列 key 取值）。
 * 接口类型是 interface，没有隐式索引签名，所以展开成匿名对象再传。
 */
const ruleRows = computed<Record<string, unknown>[]>(() => (state.data.value?.rules ?? []).map((rule) => ({ ...rule })))

const ruleColumns: TableColumn<Record<string, unknown>>[] = [
  { key: 'scope', label: '作用域', primary: true, mono: true },
  { key: 'condition', label: '条件', secondary: true, mono: true },
  { key: 'enabled', label: '启用', narrow: true, value: (row) => (row['enabled'] === true ? '启用' : '停用') },
  {
    key: 'probability',
    label: '概率',
    numeric: true,
    narrow: true,
    value: (row) => formatPercent(Number(row['probability']) / 100, 0),
  },
  {
    key: 'minIntervalMs',
    label: '最小间隔',
    narrow: true,
    value: (row) => formatDuration(Number(row['minIntervalMs']) / 1000),
  },
  {
    key: 'dailyLimit',
    label: '日限',
    numeric: true,
    narrow: true,
    // 0 是"不限"（建表注释钉死的语义），显示成 "0" 会被读成"一次也不许"
    value: (row) => (Number(row['dailyLimit']) === 0 ? '不限' : formatNumber(Number(row['dailyLimit']))),
  },
  {
    key: 'quietUntil',
    label: '静默期',
    narrow: true,
    // 静默截止是**未来**时间，用相对时间会被 formatRelative 说成"刚刚"
    value: (row) => formatDateTime(typeof row['quietUntil'] === 'string' ? row['quietUntil'] : undefined),
  },
]
</script>

<template>
  <div class="page">
    <AsyncSection
      :loading="state.loading.value"
      :error="state.error.value"
      :updated-at="state.updatedAt.value"
      :skeleton-rows="5"
      @retry="state.refresh()"
    >
      <template v-if="state.data.value">
        <div class="grid grid-4">
          <StatCard
            v-for="item in stats"
            :key="item.label"
            :label="item.label"
            :value="item.value"
            :hint="item.hint"
            :tone="item.tone"
            :icon="item.icon"
          />
        </div>

        <!-- ① 按会话类型分组：先看"哪一类会话下配了哪些条件、什么概率" -->
        <div v-if="groups.length > 0" class="grid grid-2">
          <PanelCard
            v-for="group in groups"
            :key="group.group"
            :title="group.group"
            :subtitle="groupSubtitle(group)"
          >
            <ul v-if="group.rules.length > 0" class="rules">
              <li v-for="rule in group.rules" :key="rule.condition" class="rule">
                <div class="rule-top">
                  <span class="rule-cond mono">{{ rule.condition }}</span>
                  <StatusBadge :tone="rule.enabled ? 'ok' : 'muted'" dot>
                    {{ rule.enabled ? '启用' : '停用' }}
                  </StatusBadge>
                  <span class="rule-pct">{{ probabilityText(rule.probability) }}</span>
                </div>
                <div
                  class="bar"
                  :data-enabled="rule.enabled"
                  role="progressbar"
                  aria-valuemin="0"
                  aria-valuemax="100"
                  :aria-valuenow="rule.probability"
                  :aria-label="`触发概率 ${probabilityText(rule.probability)}`"
                >
                  <span :style="{ width: probabilityWidth(rule.probability) }" />
                </div>
                <p class="muted rule-scopes">
                  作用域 <span class="mono">{{ rule.scopes.join('、') }}</span>
                </p>
              </li>
            </ul>
            <p v-else class="empty-note">这一组还没有任何规则。</p>
          </PanelCard>
        </div>

        <PanelCard v-else title="按会话类型分组">
          <p class="empty-note">
            服务端没有返回任何会话类型分组 —— 连四个固定分组（私聊 / 临时会话 / 群聊 / 不分会话类型）都不在，
            这通常说明查询出错或库版本不对，而不是"唤醒功能没配"。
          </p>
        </PanelCard>

        <!-- ② 规则明细：分组里放不下的字段（最小间隔、日限、静默期）在这里 -->
        <PanelCard
          title="唤醒规则明细"
          :subtitle="`共 ${formatNumber(ruleRows.length)} 条（作用域 × 条件）· 右键或长按可操作`"
        >
          <p v-if="ruleRows.length === 0" class="rules-empty">
            还没有唤醒规则。一条规则都没有时，任何消息都不会触发主动回复 ——
            去网关写规则，或先看它是不是连库都没连上。
          </p>

          <ul v-else class="rules">
            <li
              v-for="row in ruleRows"
              :key="ruleKey(row)"
              class="rule"
              :data-disabled="row['enabled'] !== true"
              @contextmenu="onContextMenu($event, ruleMenuItems(row), row)"
              v-on="touchHandlers(ruleMenuItems(row), row)"
            >
              <div class="rule-head">
                <span class="mono rule-scope">{{ row['scope'] }}</span>
                <span class="mono rule-cond">{{ row['condition'] }}</span>
                <StatusBadge :tone="row['enabled'] === true ? 'ok' : 'muted'" dot>
                  {{ row['enabled'] === true ? '启用' : '停用' }}
                </StatusBadge>
              </div>
              <div class="rule-facts">
                <span>概率 {{ formatPercent(Number(row['probability']) / 100, 0) }}</span>
                <span>最小间隔 {{ formatDuration(Number(row['minIntervalMs']) / 1000) }}</span>
                <span>日限 {{ Number(row['dailyLimit']) === 0 ? '不限' : formatNumber(Number(row['dailyLimit'])) }}</span>
              </div>
              <button type="button" class="rule-edit" @click="openEdit(row)">编辑</button>
            </li>
          </ul>

          <template #footer>
            <p class="muted legend">
              作用域 <span class="mono">*</span> 是全局默认；<span class="mono">private:ID</span> /
              <span class="mono">group:ID</span> 只对那一个会话生效 —— 也就是顶部「被覆盖的」那一格数出来的东西。
            </p>
          </template>
        </PanelCard>

        <!-- ③ 留痕：这里才有"为什么没醒"的答案 -->
        <PanelCard
          title="唤醒留痕"
          subtitle="每次判定都留一行（服务端按时间倒序返回最近一批）；排查要找的原因在这里，不在规则表里"
        >
          <template #actions>
            <div class="toolbar">
              <input v-model="keyword" type="search" placeholder="搜作用域 / 条件 / 原因…" aria-label="搜索唤醒留痕" />
              <div class="segmented" role="radiogroup" aria-label="按判定筛选">
                <button
                  v-for="option in DECISION_FILTERS"
                  :key="option.value"
                  type="button"
                  role="radio"
                  :aria-checked="decisionFilter === option.value"
                  :data-active="decisionFilter === option.value"
                  @click="decisionFilter = option.value"
                >
                  {{ option.label }}
                </button>
              </div>
            </div>
          </template>

          <!--
            留痕用自定义列表而不是 DataTable：判定结果必须带语义色（wake = ok / skip = muted），
            而 DataTable 的单元格只渲染文本、不接受组件。顺带把「原因」的中文解释放进同一行。
          -->
          <ul v-if="events.length > 0" class="events">
            <li v-for="event in visibleEvents" :key="event.id" class="event" :data-decision="event.decision">
              <div class="event-top">
                <StatusBadge :tone="event.decision === 'wake' ? 'ok' : 'muted'" dot mono>
                  {{ event.decision }}
                </StatusBadge>
                <span class="mono event-cond">{{ event.condition }}</span>
                <span class="mono event-scope">{{ event.scope }}</span>
                <time class="muted event-when" :datetime="event.at">{{ formatRelative(event.at) }}</time>
              </div>
              <p class="event-reason">
                {{ reasonLabel(event.reason) }}
                <span class="mono raw">{{ event.reason }}</span>
              </p>
              <p v-if="event.conversationKey" class="muted mono event-conv">会话 {{ event.conversationKey }}</p>
            </li>
          </ul>

          <div v-if="events.length > COLLAPSED_EVENT_COUNT" class="more-row">
            <button type="button" @click="expanded = !expanded">
              {{ expanded ? `收起，只看最近 ${COLLAPSED_EVENT_COUNT} 条` : `还有 ${formatNumber(hiddenEventCount)} 条更早的留痕，展开` }}
            </button>
          </div>

          <p v-if="events.length === 0 && hasAnyEvent" class="empty-note">
            当前筛选下没有匹配的留痕。清空关键词或切回「全部」，就能看到这次取回的其余记录。
          </p>

          <p v-else class="empty-note">
            还没有唤醒留痕；等有消息进来才会有记录 —— 每条消息的每次判定都会在这里留一行。
            留痕里的 <span class="mono">skip</span> 不代表出错：它是"这次没唤醒"的正常结论，
            原因就写在同一行（规则停用 / 概率未命中 / 静默期 / 频率限制 / 预算不足）。
          </p>

          <template #footer>
            <p class="muted legend">
              <StatusBadge tone="ok" dot mono>wake</StatusBadge> 条件命中，这一轮会主动说话 ·
              <StatusBadge tone="muted" dot mono>skip</StatusBadge> 没唤醒（原因见该行说明），不是错误
            </p>
          </template>
        </PanelCard>
      </template>
    </AsyncSection>
  </div>

      <!-- 编辑弹层：后端接口已通（POST /api/admin/wake-rule） -->
      <div v-if="editing !== null" class="edit-mask" @click.self="editing = null">
        <div class="edit-box" role="dialog" aria-modal="true" aria-label="编辑唤醒规则">
          <h3 class="edit-title">编辑唤醒规则</h3>
          <p class="mono edit-subject">{{ editing.scope }} / {{ editing.condition }}</p>

          <label class="edit-field">
            <span>启用</span>
            <input v-model="form.enabled" type="checkbox" />
          </label>
          <label class="edit-field">
            <span>概率（%）</span>
            <input v-model.number="form.probability" type="number" min="0" max="100" />
          </label>
          <label class="edit-field">
            <span>最小间隔（秒）</span>
            <input v-model.number="form.minIntervalSeconds" type="number" min="0" />
          </label>
          <label class="edit-field">
            <span>日限（0 = 不限）</span>
            <input v-model.number="form.dailyLimit" type="number" min="0" />
          </label>

          <p v-if="saveError !== ''" class="edit-error">{{ saveError }}</p>
          <p class="edit-hint muted">
            作用域 <span class="mono">*</span> 就是**全局默认** —— 改这里会影响所有会话。
          </p>

          <div class="edit-actions">
            <button type="button" class="btn" @click="editing = null">取消</button>
            <button type="button" class="btn primary" :disabled="saving" @click="saveRule()">
              {{ saving ? '保存中…' : '保存' }}
            </button>
          </div>
        </div>
      </div>

      <ContextMenu :state="menuState" :on-close="closeMenu" :on-clamp="clampToViewport" />
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: var(--s-4);
  max-width: var(--w-content-max);
}

.grid {
  display: grid;
  gap: var(--s-3);
}
.grid-4 {
  grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
}
.grid-2 {
  grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
}

/* ── 分组里的条件行 ─────────────────────────────────────────── */
.rules {
  display: flex;
  flex-direction: column;
  gap: var(--s-3);
  list-style: none;
}
.rule {
  min-width: 0;
}
.rule-top {
  display: flex;
  align-items: center;
  gap: var(--s-2);
}
.rule-cond {
  flex: 1;
  min-width: 0;
  color: var(--c-text);
  font-size: var(--t-sm);
  overflow-wrap: anywhere;
}
.rule-pct {
  flex: none;
  color: var(--c-text-2);
  font-size: var(--t-xs);
  font-variant-numeric: tabular-nums;
}
.rule-scopes {
  margin-top: 4px;
  font-size: var(--t-xs);
  overflow-wrap: anywhere;
}

.bar {
  height: 6px;
  margin-top: 6px;
  background: var(--c-surface-3);
  border-radius: var(--r-full);
  overflow: hidden;
}
.bar > span {
  display: block;
  height: 100%;
  background: var(--c-brand);
  border-radius: inherit;
}
/* 停用的规则把进度条压成灰色：它当前根本不参与判定 */
.bar[data-enabled='false'] > span {
  background: var(--c-text-3);
}

/* ── 留痕 ───────────────────────────────────────────────────── */
.events {
  display: flex;
  flex-direction: column;
  gap: var(--s-2);
  list-style: none;
}
.event {
  min-width: 0;
  padding: var(--s-3);
  background: var(--c-surface-2);
  border-left: 3px solid var(--c-border-strong);
  border-radius: var(--r-md);
}
.event[data-decision='wake'] {
  border-left-color: var(--c-ok);
}
.event[data-decision='skip'] {
  border-left-color: var(--c-text-3);
}
.event-top {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--s-2);
  min-width: 0;
}
.event-cond {
  color: var(--c-text);
  font-size: var(--t-sm);
  overflow-wrap: anywhere;
}
.event-scope {
  color: var(--c-text-2);
  font-size: var(--t-xs);
  overflow-wrap: anywhere;
}
.event-when {
  margin-left: auto;
  flex: none;
  font-size: var(--t-xs);
}
.event-reason {
  margin-top: 6px;
  color: var(--c-text-2);
  font-size: var(--t-sm);
}
.raw {
  margin-left: 4px;
  color: var(--c-text-3);
  font-size: 0.92em;
}
.event-conv {
  margin-top: 2px;
  font-size: var(--t-xs);
  overflow-wrap: anywhere;
}

.more-row {
  display: flex;
  justify-content: center;
  margin-top: var(--s-3);
}
.more-row button {
  min-height: 32px;
  padding: 0 var(--s-4);
  background: var(--c-surface-2);
  border: 1px solid var(--c-border);
  border-radius: var(--r-full);
  color: var(--c-text-2);
  cursor: pointer;
  font-size: var(--t-xs);
}
.more-row button:hover {
  background: var(--c-surface-3);
  color: var(--c-text);
}

/* ── 工具栏（与记忆页同一套写法，手机上是两行）─────────────── */
.toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--s-2);
}
.toolbar input {
  min-height: 32px;
  min-width: 160px;
  padding: 0 var(--s-3);
  background: var(--c-bg);
  border: 1px solid var(--c-border-strong);
  border-radius: var(--r-md);
  color: var(--c-text);
  font-size: var(--t-sm);
  outline: none;
}
.toolbar input:focus {
  border-color: var(--c-brand);
  box-shadow: 0 0 0 3px var(--c-brand-soft);
}

.segmented {
  display: inline-flex;
  gap: 2px;
  padding: 2px;
  background: var(--c-surface-2);
  border-radius: var(--r-md);
}
.segmented button {
  min-height: 28px;
  padding: 0 var(--s-3);
  border: none;
  border-radius: var(--r-sm);
  background: transparent;
  color: var(--c-text-3);
  cursor: pointer;
  font-size: var(--t-xs);
}
.segmented button:hover {
  color: var(--c-text);
}
.segmented button[data-active='true'] {
  background: var(--c-surface);
  color: var(--c-text);
  box-shadow: var(--sh-1);
}

.empty-note {
  max-width: 62ch;
  margin: 0 auto;
  padding: var(--s-4) 0;
  color: var(--c-text-3);
  font-size: var(--t-sm);
  line-height: var(--lh-base);
  text-align: center;
}

.legend {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  font-size: var(--t-xs);
}

.rules {
  display: flex;
  flex-direction: column;
  gap: 2px;
  list-style: none;
}
.rule {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--s-3);
  min-height: var(--touch-min, 44px);
  padding: var(--s-2) var(--s-3);
  border-radius: var(--r-sm);
  cursor: context-menu;
}
.rule:hover {
  background: var(--c-surface-2);
}
.rule[data-disabled='true'] .rule-cond {
  color: var(--c-text-3);
}
.rule-head {
  display: flex;
  align-items: center;
  gap: var(--s-2);
  min-width: 0;
}
.rule-scope {
  color: var(--c-text-3);
  font-size: var(--t-xs);
}
.rule-cond {
  color: var(--c-text);
  font-size: var(--t-sm);
}
.rule-facts {
  display: flex;
  flex-wrap: wrap;
  gap: var(--s-3);
  margin-left: auto;
  color: var(--c-text-3);
  font-size: var(--t-xs);
}
.rule-edit {
  min-height: 28px;
  padding: 0 var(--s-3);
  border: 1px solid var(--c-border-strong);
  border-radius: var(--r-sm);
  background: transparent;
  color: var(--c-text-2);
  font-size: var(--t-xs);
  cursor: pointer;
}
.rule-edit:hover {
  border-color: var(--c-brand);
  color: var(--c-brand);
}
.rules-empty {
  padding: var(--s-5) 0;
  color: var(--c-text-3);
  font-size: var(--t-sm);
  line-height: 1.8;
  text-align: center;
}

.edit-mask {
  position: fixed;
  inset: 0;
  z-index: 900;
  display: grid;
  place-items: center;
  padding: var(--s-4);
  background: rgb(0 0 0 / 45%);
}
.edit-box {
  width: min(420px, 100%);
  max-height: 88vh;
  overflow: auto;
  padding: var(--s-5);
  background: var(--c-surface);
  border: 1px solid var(--c-border-strong);
  border-radius: var(--r-lg);
  box-shadow: var(--sh-2, 0 12px 32px rgb(0 0 0 / 24%));
}
.edit-title {
  font-size: var(--t-md);
}
.edit-subject {
  margin-top: 4px;
  color: var(--c-text-3);
  font-size: var(--t-xs);
}
.edit-field {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--s-3);
  margin-top: var(--s-3);
  font-size: var(--t-sm);
}
.edit-field input[type='number'] {
  width: 110px;
  min-height: 34px;
  padding: 0 var(--s-2);
  background: var(--c-bg);
  border: 1px solid var(--c-border-strong);
  border-radius: var(--r-sm);
  color: var(--c-text);
  text-align: right;
}
.edit-error {
  margin-top: var(--s-3);
  color: var(--c-err, #d9534f);
  font-size: var(--t-xs);
}
.edit-hint {
  margin-top: var(--s-3);
  font-size: var(--t-xs);
  line-height: 1.7;
}
.edit-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--s-2);
  margin-top: var(--s-4);
}
.btn {
  min-height: var(--touch-min, 44px);
  padding: 0 var(--s-4);
  border: 1px solid var(--c-border-strong);
  border-radius: var(--r-md);
  background: transparent;
  color: var(--c-text);
  cursor: pointer;
}
.btn.primary {
  border-color: transparent;
  background: var(--c-brand);
  color: #fff;
}
.btn:disabled {
  opacity: 0.6;
  cursor: default;
}
</style>
