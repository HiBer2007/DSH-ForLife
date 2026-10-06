<script setup lang="ts">
/**
 * 路由与端点 —— 回答一个问题：**这条消息会被哪个模型处理，为什么**。
 *
 * 版面顺序就是回答这个问题的顺序：
 *  ① 统计卡：端点在不在、24 小时有没有跑过（先确认这套东西是活的）；
 *  ② 模型分配：role → 有序候选。这是"会被哪个模型处理"的答案本身（rank 越小越优先）；
 *  ③ 推理端点：候选背后真正连得上的进程/容器，被选中的 provider/model 最终落在其中一行；
 *  ④ 24h 分布：按 tier 与 source 计数 —— 回答"为什么"（守卫、评分器还是启发式判的档）；
 *  ⑤ 路由日志：逐条决策的证据（置信度、升降级、切换原因）；
 *  ⑥ 不确定样本：判不准的那些案例，等复盘。
 *
 * 两处**绝不能合并显示**的语义（合并就会让人去修没坏的东西）：
 *  - `healthOk === undefined` 是"从未探测过"，不等于 `false`（探测了、不健康）；
 *  - `effectiveBackend !== backend` 是静默回落（配置写 GPU、实际跑 CPU），必须显眼提示。
 */
import { computed, ref } from 'vue'

import { api } from '../api/client.ts'
import type { RoutingEndpoint, RoutingLogEntry, RoutingOverview, RoutingRole, UncertainCaseOverview } from '../api/types-routing.ts'
import AppIcon from '../components/AppIcon.vue'
import AsyncSection from '../components/AsyncSection.vue'
import DataTable, { type TableColumn } from '../components/DataTable.vue'
import PanelCard from '../components/PanelCard.vue'
import StatCard from '../components/StatCard.vue'
import StatusBadge from '../components/StatusBadge.vue'
import { useAsyncData } from '../composables/useAsyncData.ts'
import { formatNumber, formatPercent, formatRelative } from '../utils/format.ts'

/** 服务端 `queryRouting` 的日志默认条数上限（没传 logLimit 时就是这个数）。 */
const LOG_LIMIT = 50
/** 不确定样本的固定条数（`UNCERTAIN_LIMIT`，服务端不开放参数）。 */
const UNCERTAIN_LIMIT = 30

const state = useAsyncData<RoutingOverview>(() => api.get<RoutingOverview>('/routing'))
const data = computed(() => state.data.value)

/** 只留真正有值的字符串：`undefined` 与空串都算"没有"（空串在等宽列里看起来像有值，最误导）。 */
function defined(parts: readonly (string | undefined)[]): string[] {
  return parts.filter((part): part is string => part !== undefined && part !== '')
}

/* ── ① 统计卡 ─────────────────────────────────────────────────────────── */

const endpoints = computed<readonly RoutingEndpoint[]>(() => data.value?.endpoints ?? [])
const roles = computed<readonly RoutingRole[]>(() => data.value?.roles ?? [])
const log = computed<readonly RoutingLogEntry[]>(() => data.value?.log ?? [])
const uncertain = computed<readonly UncertainCaseOverview[]>(() => data.value?.uncertain ?? [])

/**
 * 端点健康的三态计数。
 *
 * "从未探测"必须单独数出来：服务端的 `stats.healthy` 只数 `health_ok = 1`，
 * 光看它无法区分"其余是探测失败"还是"其余压根没测过"。
 */
const health = computed(() => {
  let bad = 0
  let never = 0
  for (const endpoint of endpoints.value) {
    if (endpoint.healthOk === undefined) never += 1
    else if (!endpoint.healthOk) bad += 1
  }
  return { bad, never }
})

const healthTone = computed<'neutral' | 'ok' | 'warn' | 'err'>(() => {
  // 一个端点都没登记谈不上"不健康"，别用红色吓人
  if (endpoints.value.length === 0) return 'neutral'
  if (health.value.bad > 0) return 'err'
  // 有没探测过的：不确定，提示但不报警
  if (health.value.never > 0) return 'warn'
  return 'ok'
})

const degraded24h = computed(() => data.value?.stats.degraded24h ?? 0)
const total24h = computed(() => data.value?.stats.total24h ?? 0)
/** 分母为 0 时不给比率：`0/0` 显示成 "0.0%" 会被读成"降级率很低"，而其实是"没跑过"。 */
const degradeHint = computed(() =>
  total24h.value === 0 ? '这 24 小时没有路由记录' : `降级率 ${formatPercent(degraded24h.value / total24h.value)}`,
)
const degradeTone = computed<'neutral' | 'warn'>(() =>
  total24h.value > 0 && degraded24h.value / total24h.value > 0.3 ? 'warn' : 'neutral',
)

/* ── ② 模型分配 ───────────────────────────────────────────────────────── */

/** 组标题右侧的说明：把 rank 语义与启用数摆在一起，停用光靠颜色是看不出数量的。 */
function roleSummary(role: RoutingRole): string {
  const enabled = role.candidates.filter((candidate) => candidate.enabled).length
  const base = `rank 越小越优先 · 共 ${role.candidates.length} 个候选，启用 ${enabled} 个`
  return enabled === 0 ? `${base}（全部停用）` : base
}

/* ── ③ 推理端点 ───────────────────────────────────────────────────────── */

/**
 * **实际生效后端与登记后端不一致**的端点。
 *
 * 单独拎出来是因为这件事在表格里只有一格，很容易被扫过去，但它意味着
 * "你以为在用 GPU，其实在跑 CPU" —— 性能问题的根源常常就在这。
 */
const silentFallbacks = computed(() =>
  endpoints.value.filter(
    (endpoint) => endpoint.effectiveBackend !== undefined && endpoint.effectiveBackend !== endpoint.backend,
  ),
)

/**
 * 健康三态。`undefined` 必须自成一档：它表示 `health_ok IS NULL`，即**从未探测过**；
 * 和 `false` 一起显示成"不健康"，用户就会去修一个可能根本没坏的东西。
 */
function healthLabel(ok: boolean | undefined): string {
  if (ok === undefined) return '从未探测'
  return ok ? '健康' : '不健康'
}

function effectiveLabel(endpoint: RoutingEndpoint): string {
  // 缺席 = 没有记录（探测没跑或后端没上报），**不等于**与登记一致
  if (endpoint.effectiveBackend === undefined) return '—'
  return endpoint.effectiveBackend === endpoint.backend
    ? endpoint.effectiveBackend
    : `${endpoint.effectiveBackend}（静默回落）`
}

function endpointRow(endpoint: RoutingEndpoint): Record<string, unknown> {
  const deploy = defined([endpoint.deployTarget, endpoint.deployHost])
  return {
    id: endpoint.id,
    type: endpoint.type,
    mode: endpoint.mode,
    backend: endpoint.backend,
    baseUrl: endpoint.baseUrl,
    deploy: deploy.length === 0 ? '—' : deploy.join(' · '),
    // 空模型列表是"这个端点没登记模型"，与"端点不可用"不是一回事，要写出来
    models: endpoint.models.length === 0 ? '未登记模型' : endpoint.models.map((model) => model.id).join(', '),
    health: healthLabel(endpoint.healthOk),
    latency: endpoint.healthLatencyMs === undefined ? '—' : `${formatNumber(endpoint.healthLatencyMs)} ms`,
    effectiveBackend: effectiveLabel(endpoint),
    enabled: endpoint.enabled ? '启用' : '已停用',
    healthNote: endpoint.healthNote ?? '—',
    updatedAt: formatRelative(endpoint.updatedAt),
  }
}

const endpointRows = computed<Record<string, unknown>[]>(() => endpoints.value.map(endpointRow))

const endpointColumns: TableColumn<Record<string, unknown>>[] = [
  { key: 'id', label: '端点', primary: true, mono: true },
  { key: 'type', label: '类型', narrow: true },
  { key: 'mode', label: '模式', narrow: true },
  { key: 'backend', label: '登记后端', narrow: true, mono: true },
  { key: 'baseUrl', label: 'baseUrl', mono: true },
  { key: 'deploy', label: '部署目标 / 主机' },
  { key: 'models', label: '模型', mono: true },
  { key: 'health', label: '健康', narrow: true },
  { key: 'latency', label: '健康延迟', narrow: true, numeric: true },
  { key: 'effectiveBackend', label: '实际生效', narrow: true, mono: true },
  { key: 'enabled', label: '启用', narrow: true },
  { key: 'healthNote', label: '健康备注' },
  { key: 'updatedAt', label: '更新', secondary: true },
]

/* ── ④ 24h 分布 ───────────────────────────────────────────────────────── */

interface BarRow {
  readonly label: string
  readonly count: number
  readonly width: number
  readonly share: string
}

/**
 * 计数组 → 条形数据。
 *
 * 宽度按**组内最大值**归一（不是按总数）：像 vision 这种偶尔才用一次的档位，
 * 按总数算会变成发丝一样的一条线，等于没画；按最大值归一比的是"谁更多"。
 */
function toBars(items: readonly { readonly label: string; readonly count: number }[], total: number): BarRow[] {
  let max = 0
  for (const item of items) max = Math.max(max, item.count)
  return items.map((item) => ({
    label: item.label,
    count: item.count,
    // 有计数就至少给 4% 宽：一条 1 像素的条子和"没有"在视觉上分不开
    width: max === 0 || item.count === 0 ? 0 : Math.max(4, Math.round((item.count / max) * 100)),
    share: total === 0 ? '—' : formatPercent(item.count / total),
  }))
}

const tierBars = computed(() =>
  toBars(
    (data.value?.stats.byTier ?? []).map((row) => ({ label: row.tier, count: row.count })),
    total24h.value,
  ),
)
const sourceBars = computed(() =>
  toBars(
    (data.value?.stats.bySource ?? []).map((row) => ({ label: row.source, count: row.count })),
    total24h.value,
  ),
)

/* ── ⑤ 路由日志 ───────────────────────────────────────────────────────── */

const LOG_FILTERS = [
  { value: 'all', label: '全部' },
  { value: 'degraded', label: '仅降级' },
  { value: 'switched', label: '仅切换' },
  { value: 'escalated', label: '仅升级' },
] as const
const logFilter = ref<(typeof LOG_FILTERS)[number]['value']>('all')
const logKeyword = ref('')

/** 搜索范围就是表里看得见的文本：搜得到的东西一定能在行里找到，避免"命中却看不出为什么"。 */
function logSearchText(entry: RoutingLogEntry): string {
  return defined([entry.tier, entry.source, entry.rule, entry.degradeReason, entry.provider, entry.model, entry.switchReason])
    .join(' ')
    .toLowerCase()
}

const visibleLog = computed(() => {
  const picked = log.value.filter((entry) => {
    if (logFilter.value === 'degraded') return entry.degraded
    if (logFilter.value === 'switched') return entry.switched
    if (logFilter.value === 'escalated') return entry.escalated
    return true
  })
  const needle = logKeyword.value.trim().toLowerCase()
  if (needle === '') return picked
  return picked.filter((entry) => logSearchText(entry).includes(needle))
})

function logRow(entry: RoutingLogEntry): Record<string, unknown> {
  return {
    at: formatRelative(entry.at),
    tier: entry.tier,
    source: entry.source,
    rule: entry.rule ?? '—',
    confidence: formatPercent(entry.confidence),
    escalated: entry.escalated ? '是' : '否',
    degraded: entry.degraded ? '是' : '否',
    degradeReason: entry.degradeReason ?? '—',
    latency: `${formatNumber(entry.latencyMs)} ms`,
    // 只给了一半也要能看出是哪一半缺，别把 provider/model 拼成一个含混的字符串
    target: `${entry.provider ?? '—'} / ${entry.model ?? '—'}`,
    switched: entry.switched ? '是' : '否',
    switchReason: entry.switchReason ?? '—',
  }
}

const logRows = computed<Record<string, unknown>[]>(() => visibleLog.value.map(logRow))

/**
 * 只在"没筛选且条数顶到上限"时提示还有更多 —— 筛选后的 50 条是筛选的结果，
 * 对它说"只显示最近 50 条"会让人以为漏了数据。
 */
const logTruncated = computed(
  () => logFilter.value === 'all' && logKeyword.value.trim() === '' && log.value.length >= LOG_LIMIT,
)

const logColumns: TableColumn<Record<string, unknown>>[] = [
  { key: 'at', label: '时间', secondary: true },
  { key: 'tier', label: 'tier', narrow: true },
  { key: 'source', label: '来源', narrow: true },
  { key: 'rule', label: '规则', narrow: true, mono: true },
  { key: 'confidence', label: '置信度', narrow: true, numeric: true },
  { key: 'escalated', label: '升级', narrow: true },
  { key: 'degraded', label: '降级', narrow: true },
  { key: 'degradeReason', label: '降级原因' },
  { key: 'latency', label: '延迟', narrow: true, numeric: true },
  { key: 'target', label: 'provider / model', primary: true, mono: true },
  { key: 'switched', label: '切换', narrow: true },
  { key: 'switchReason', label: '切换原因' },
]

/* ── ⑥ 不确定样本 ─────────────────────────────────────────────────────── */

/** 只翻译认识的两种状态；将来加了新状态就照原样显示，不假装认识它。 */
function statusLabel(status: string): string {
  if (status === 'pending') return '待复盘'
  if (status === 'reviewed') return '已复盘'
  return status
}

function uncertainRow(item: UncertainCaseOverview): Record<string, unknown> {
  return {
    at: formatRelative(item.at),
    textExcerpt: item.textExcerpt,
    tier: item.tier,
    confidence: formatPercent(item.confidence),
    backend: item.backend ?? '—',
    status: statusLabel(item.status),
    suggestion: item.suggestion ?? '—',
  }
}

const uncertainRows = computed<Record<string, unknown>[]>(() => uncertain.value.map(uncertainRow))

const uncertainColumns: TableColumn<Record<string, unknown>>[] = [
  { key: 'at', label: '时间', secondary: true },
  { key: 'textExcerpt', label: '文本片段', primary: true },
  { key: 'tier', label: 'tier', narrow: true },
  { key: 'confidence', label: '置信度', narrow: true, numeric: true },
  { key: 'backend', label: '后端', narrow: true, mono: true },
  { key: 'status', label: '状态', narrow: true },
  { key: 'suggestion', label: '建议' },
]
</script>

<template>
  <div class="page">
    <AsyncSection
      :loading="state.loading.value"
      :error="state.error.value"
      :updated-at="state.updatedAt.value"
      :skeleton-rows="6"
      @retry="state.refresh()"
    >
      <template v-if="data">
        <!-- ① 先看这套东西是不是活的 -->
        <div class="grid grid-4">
          <StatCard
            label="端点总数"
            :value="formatNumber(data.stats.endpoints)"
            hint="含已停用：停用不是不存在，还要看得见并打开"
            icon="endpoint"
          />
          <StatCard
            label="健康端点"
            :value="formatNumber(data.stats.healthy)"
            :hint="`从未探测 ${formatNumber(health.never)} · 不健康 ${formatNumber(health.bad)}`"
            :tone="healthTone"
            icon="check"
          />
          <StatCard
            label="24h 路由次数"
            :value="formatNumber(data.stats.total24h)"
            hint="每次选模型写一行日志"
            icon="routing"
          />
          <StatCard
            label="24h 降级次数"
            :value="formatNumber(data.stats.degraded24h)"
            :hint="degradeHint"
            :tone="degradeTone"
            icon="warning"
          />
        </div>

        <!-- ② 会被哪个模型处理 -->
        <section class="block">
          <div class="block-head">
            <h3>模型分配</h3>
            <p class="muted">
              每个 role 是一组<strong>有序</strong>候选：<strong>rank 越小越优先</strong>，先试 rank 最小的那个；超时、限流或用不了时按
              rank 依次往下换 —— 这就是「自动降级」的全部依据（库里 <span class="mono">(role, rank)</span> 唯一，排序变了降级顺序就变了）。
              标着「已停用」的候选不参与选择。顺序用服务端给的（已按 role 排序），前端不再重排。
            </p>
          </div>

          <p v-if="roles.length === 0" class="empty-note muted">
            <span class="mono">model_routes</span> 里一行都没有 —— 还没有为任何 role 登记候选模型。这是"还没配"，不是"坏了"：
            一旦真的要选模型，路由会因为没有候选而失败。先从插件面板的「路由」入口把 L1 / L2 / L3 配上（视觉与嵌入要先指定能跑它们的端点）。
          </p>

          <div v-else class="grid grid-2">
            <PanelCard v-for="role in roles" :key="role.role" :title="role.role" :subtitle="roleSummary(role)">
              <p v-if="!role.candidates.some((candidate) => candidate.enabled)" class="warn-line">
                <StatusBadge tone="warn" dot>注意</StatusBadge>
                <span>这个 role 的候选全被停用了，路由到它会直接失败。</span>
              </p>
              <ul class="candidates">
                <li
                  v-for="candidate in role.candidates"
                  :key="`${role.role}-${candidate.rank}`"
                  :data-disabled="!candidate.enabled"
                >
                  <div class="cand-line">
                    <span class="rank mono">rank {{ candidate.rank }}</span>
                    <span class="cand-model mono">{{ candidate.provider }} / {{ candidate.model }}</span>
                  </div>
                  <div class="cand-meta">
                    <StatusBadge :tone="candidate.enabled ? 'ok' : 'muted'" dot>
                      {{ candidate.enabled ? '启用' : '已停用' }}
                    </StatusBadge>
                    <!-- 缺席显示"—"：没设推理强度时各端点有自己的默认值，猜一个填上去就是假数据 -->
                    <StatusBadge :tone="candidate.effort === undefined ? 'muted' : 'info'" mono>
                      推理强度 {{ candidate.effort ?? '—' }}
                    </StatusBadge>
                  </div>
                  <p v-if="candidate.note !== undefined" class="cand-note muted">{{ candidate.note }}</p>
                </li>
              </ul>
            </PanelCard>
          </div>
        </section>

        <!-- ③ 候选背后真正连得上的东西 -->
        <PanelCard
          title="推理端点"
          :subtitle="`inference_endpoints 共 ${formatNumber(endpoints.length)} 行（含已停用，按类型与 id 排序）`"
        >
          <p v-if="silentFallbacks.length > 0" class="alert" role="status">
            <AppIcon name="warning" :size="16" />
            <span>
              有 {{ silentFallbacks.length }} 个端点的「实际生效后端」与登记的不一致 —— 配置写的是一个后端、真正在跑的是另一个（静默回落），
              性能问题常常就出在这里：
              <span class="mono">
                {{ silentFallbacks.map((item) => `${item.id}：${item.backend} → ${item.effectiveBackend}`).join('；') }}
              </span>
            </span>
          </p>

          <DataTable
            :columns="endpointColumns"
            :rows="endpointRows"
            empty-text="inference_endpoints 是 0 行 —— 还没有登记任何推理端点。这一页其余部分照常显示，因为「一个都没登记」本身就是结论：现在没有可路由的后端。用部署流程或端点面板登记一个（本地 docker / 远程 ssh 都行）之后，这里就会出现那一行。"
          />

          <template #footer>
            <p class="muted legend">
              <StatusBadge tone="ok" dot>健康</StatusBadge> 最近一次探测通过 ·
              <StatusBadge tone="err" dot>不健康</StatusBadge> 探测过但失败（<span class="mono">health_ok = 0</span>） ·
              <StatusBadge tone="muted" dot>从未探测</StatusBadge> <span class="mono">health_ok IS NULL</span>：没测过，
              <strong>不是坏消息</strong>，别照着它去修端点
            </p>
          </template>
        </PanelCard>

        <!-- ④ 为什么：按 tier / source 的分布 -->
        <PanelCard
          title="24h 分布"
          :subtitle="`最近 24 小时共 ${formatNumber(total24h)} 次决策；条宽按组内最大值归一，行末百分比 = 该组占 24h 总数的比例`"
        >
          <div class="bars-wrap">
            <div class="bars-block">
              <h4>按 tier（最后落在哪一档）</h4>
              <p v-if="tierBars.length === 0" class="empty-note muted">
                最近 24 小时没有路由记录。统计就是按 <span class="mono">routing_log.at</span> 过滤再分组，
                0 条 = 这段时间没有消息走过路由，不是统计坏了。
              </p>
              <ul v-else class="bars">
                <li v-for="bar in tierBars" :key="bar.label">
                  <span class="bar-label mono">{{ bar.label }}</span>
                  <span class="bar-track">
                    <span class="bar-fill" data-kind="tier" :style="{ width: `${bar.width}%` }" />
                  </span>
                  <span class="bar-count">{{ formatNumber(bar.count) }}</span>
                  <span class="bar-share muted">{{ bar.share }}</span>
                </li>
              </ul>
            </div>

            <div class="bars-block">
              <h4>按 source（谁判的档）</h4>
              <p v-if="sourceBars.length === 0" class="empty-note muted">
                最近 24 小时没有路由记录。<span class="mono">guard</span> 是守卫规则、<span class="mono">scorer</span> 是评分器、
                <span class="mono">heuristic</span> 是启发式兜底 —— 一条都没有，说明这段时间没发生过判定。
              </p>
              <ul v-else class="bars">
                <li v-for="bar in sourceBars" :key="bar.label">
                  <span class="bar-label mono">{{ bar.label }}</span>
                  <span class="bar-track">
                    <span class="bar-fill" data-kind="source" :style="{ width: `${bar.width}%` }" />
                  </span>
                  <span class="bar-count">{{ formatNumber(bar.count) }}</span>
                  <span class="bar-share muted">{{ bar.share }}</span>
                </li>
              </ul>
            </div>
          </div>
        </PanelCard>

        <!-- ⑤ 逐条证据 -->
        <PanelCard title="路由日志" :subtitle="`按时间倒序，当前显示 ${formatNumber(logRows.length)} 条`">
          <template #actions>
            <div class="toolbar">
              <input v-model="logKeyword" type="search" placeholder="搜规则 / 原因 / provider…" aria-label="搜索路由日志" />
              <div class="segmented" role="radiogroup" aria-label="日志筛选">
                <button
                  v-for="option in LOG_FILTERS"
                  :key="option.value"
                  type="button"
                  role="radio"
                  :aria-checked="logFilter === option.value"
                  :data-active="logFilter === option.value"
                  @click="logFilter = option.value"
                >
                  {{ option.label }}
                </button>
              </div>
            </div>
          </template>

          <DataTable
            :columns="logColumns"
            :rows="logRows"
            :limit="logTruncated ? LOG_LIMIT : 0"
            empty-text="routing_log 是 0 行 —— 还没有任何一条消息走过路由决策。日志是每次选模型时写一行，所以 0 行说明「还没跑过」，不是采集坏了。让 QQ 收一条消息，或在 DSH 会话里手动触发一次模型调用，这里就会出现记录。"
          />

          <template #footer>
            <p class="muted legend">
              「升级」= 判定后往上抬了档 · 「降级」= 主选不可用、按 rank 往下换了模型或端点 ·
              「切换」= provider/model 与上一次不同。时间列是相对时间；长文本被列宽截断时，悬停可看到完整内容。
            </p>
          </template>
        </PanelCard>

        <!-- ⑥ 需要人看的少数 -->
        <PanelCard title="不确定样本" :subtitle="`最近 ${formatNumber(uncertain.length)} 条（服务端固定取 ${UNCERTAIN_LIMIT} 条）`">
          <DataTable
            :columns="uncertainColumns"
            :rows="uncertainRows"
            :limit="UNCERTAIN_LIMIT"
            empty-text="还没有不确定样本。只有评分器给出的置信度落在阈值之间、且是新出现的消息才会记一条（刻意不实时调用大模型复盘，那会拖慢响应）；0 行说明还没遇到过这种消息，或者评分器压根没跑过 —— 不是查询出错。"
          />
        </PanelCard>
      </template>
    </AsyncSection>
  </div>
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
  grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
}

/* ── 分区标题 ─────────────────────────────────────────────── */
.block {
  display: flex;
  flex-direction: column;
  gap: var(--s-3);
}
.block-head h3 {
  font-size: var(--t-md);
  font-weight: 600;
}
.block-head p {
  margin-top: 2px;
  max-width: 92ch;
  font-size: var(--t-xs);
  line-height: 1.7;
}

/* ── 候选列表 ─────────────────────────────────────────────── */
.candidates {
  display: flex;
  flex-direction: column;
  gap: var(--s-2);
}
.candidates > li {
  padding: var(--s-2) var(--s-3);
  background: var(--c-surface-2);
  border-left: 3px solid var(--c-brand);
  border-radius: var(--r-md);
}
/* 停用项压暗，但徽标上仍写着「已停用」—— 不能只靠颜色表达状态 */
.candidates > li[data-disabled='true'] {
  border-left-color: var(--c-border-strong);
  opacity: 0.62;
}
.cand-line {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--s-2);
}
.rank {
  flex: none;
  color: var(--c-text-3);
  font-size: var(--t-xs);
}
.cand-model {
  min-width: 0;
  color: var(--c-text);
  font-weight: 600;
  overflow-wrap: anywhere;
}
.cand-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--s-2);
  margin-top: 6px;
}
.cand-note {
  margin-top: 4px;
  font-size: var(--t-xs);
  line-height: 1.5;
}
.warn-line {
  display: flex;
  align-items: center;
  gap: var(--s-2);
  margin-bottom: var(--s-3);
  color: var(--c-warn);
  font-size: var(--t-xs);
}

/* ── 静默回落提示 ─────────────────────────────────────────── */
.alert {
  display: flex;
  align-items: flex-start;
  gap: var(--s-2);
  margin-bottom: var(--s-3);
  padding: var(--s-3);
  background: var(--c-err-soft);
  color: var(--c-err);
  border-radius: var(--r-md);
  font-size: var(--t-xs);
  line-height: 1.7;
}

/* ── 24h 分布条 ───────────────────────────────────────────── */
.bars-wrap {
  display: grid;
  gap: var(--s-4);
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
}
.bars-block {
  min-width: 0;
}
.bars-block h4 {
  margin-bottom: var(--s-2);
  color: var(--c-text-2);
  font-size: var(--t-xs);
  font-weight: 600;
}
.bars {
  display: flex;
  flex-direction: column;
  gap: var(--s-2);
}
.bars > li {
  display: grid;
  grid-template-columns: minmax(52px, auto) 1fr auto auto;
  align-items: center;
  gap: var(--s-2);
}
.bar-label {
  color: var(--c-text-2);
  font-size: var(--t-xs);
}
.bar-track {
  height: 8px;
  background: var(--c-surface-2);
  border-radius: var(--r-full);
  overflow: hidden;
}
.bar-fill {
  display: block;
  height: 100%;
  border-radius: var(--r-full);
  background: var(--c-1);
}
/* 两组用不同色阶区分：颜色只是辅助，组标题已经写明是什么 */
.bar-fill[data-kind='source'] {
  background: var(--c-3);
}
.bar-count {
  color: var(--c-text-2);
  font-size: var(--t-xs);
  font-variant-numeric: tabular-nums;
}
.bar-share {
  min-width: 46px;
  font-size: var(--t-xs);
  text-align: right;
  font-variant-numeric: tabular-nums;
}

/* ── 工具栏（筛选） ───────────────────────────────────────── */
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

/* ── 说明文字 ─────────────────────────────────────────────── */
.empty-note {
  padding: var(--s-3) 0;
  font-size: var(--t-xs);
  line-height: 1.7;
}
.legend {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  font-size: var(--t-xs);
  line-height: 1.7;
}
.mono {
  font-family: var(--font-mono);
  font-size: 0.92em;
}
</style>
