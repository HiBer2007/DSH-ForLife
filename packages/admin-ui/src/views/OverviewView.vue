<script setup lang="ts">
/**
 * 运行总览 —— 打开面板第一眼要看的东西。
 *
 * 排序原则：**先看"是不是还活着"，再看"花了多少"，最后看细节**。
 * 所以最上面一排是连接/队列/失败这类"要不要现在动手"的指标，
 * 下面才是记忆、压缩、路由这些需要下钻的块。
 *
 * ## 刷新（两块数据**都要自己动**）
 *
 *  - 指标卡（`/overview`）**15 秒**一次：这一排回答的是"现在要不要动手"，必须新鲜；
 *  - 运行图表（`/series`）**60 秒**一次：它是**按小时**聚合的，15 秒刷一次只是白打接口，
 *    但**一次都不刷就是一张静止的照片**（这里原来就栽在这一条上：手写的定时器只刷了
 *    `/overview`，图表从打开页面起再也没动过）。
 *
 * 节奏与可见性判断都交给 `useAsyncData` 的 `pollMs`（见 `poll-schedule.ts`）：
 * 切到后台标签页会**停掉定时器**，切回来**立刻补一次**，失败会**退避**。
 */
import { computed, ref, watch } from 'vue'

import { api } from '../api/client.ts'
import type { Overview, SeriesPayload } from '../api/types.ts'
import AppIcon from '../components/AppIcon.vue'
import AsyncSection from '../components/AsyncSection.vue'
import PanelCard from '../components/PanelCard.vue'
import StatCard from '../components/StatCard.vue'
import TimeSeriesChart from '../components/TimeSeriesChart.vue'
import { useAsyncData } from '../composables/useAsyncData.ts'
import { formatBytes, formatDuration, formatNumber, formatPercent, formatRelative, formatTokens } from '../utils/format.ts'

const state = useAsyncData<Overview>(() => api.get<Overview>('/overview'), { pollMs: 15_000 })

/** 图表的时间范围（小时）。默认 24 小时：日常最常看的一段。 */
const RANGES = [
  { value: 24, label: '24 小时' },
  { value: 72, label: '3 天' },
  { value: 168, label: '7 天' },
] as const
const seriesHours = ref<number>(24)
const series = useAsyncData<SeriesPayload>(() => api.get<SeriesPayload>('/series', { hours: seriesHours.value }), {
  pollMs: 60_000,
})
watch(seriesHours, () => void series.refresh())

/** 图表用到的序列（写成 computed 免得模板里塞一堆数组字面量）。 */
const chartSeries = computed(() => {
  const m = series.data.value?.metrics
  if (m === undefined) return undefined
  return {
    traffic: [
      { name: '入站消息', values: m.messages, tone: 1 },
      { name: '轮次', values: m.turns, tone: 3 },
    ],
    routing: [
      { name: '路由决策', values: m.routing, tone: 1 },
      { name: '其中降级', values: m.degraded, tone: 5 },
    ],
    tokens: [{ name: '提示词 token', values: m.promptTokens, tone: 2 }],
    cache: [{ name: '缓存命中率', values: m.cacheHitRate, tone: 3 }],
    outbox: [
      { name: '已确认发送', values: m.outboxSent, tone: 3 },
      { name: '发送失败', values: m.outboxFailed, tone: 5 },
    ],
  }
})

const data = computed(() => state.data.value)

/** 第一排：要不要现在动手。 */
const health = computed(() => {
  const d = data.value
  if (d === undefined) return []
  return [
    {
      label: 'QQ 连接',
      // undefined = 本服务没接管连接（不知道），不能当成"离线"来吓人
      value: d.qq.connected === undefined ? '未接管' : d.qq.connected ? '在线' : '离线',
      tone: d.qq.connected === undefined ? ('neutral' as const) : d.qq.connected ? ('ok' as const) : ('err' as const),
      icon: 'chat',
      hint:
        d.qq.lastInboundAt === undefined
          ? '还没收到过消息'
          : `最后收到 ${formatRelative(d.qq.lastInboundAt)}（${formatNumber(d.qq.sessions)} 个会话）`,
    },
    {
      label: '待处理消息',
      value: formatNumber(d.qq.queueDepth + d.qq.pendingItems),
      tone: d.qq.queueDepth + d.qq.pendingItems > 20 ? ('warn' as const) : ('neutral' as const),
      icon: 'overview',
      hint: `队列 ${formatNumber(d.qq.queueDepth)} · 待读 ${formatNumber(d.qq.pendingItems)}`,
    },
    {
      label: '发送积压',
      value: formatNumber(d.qq.outboxPending),
      tone: d.qq.outboxPending > 0 ? ('warn' as const) : ('neutral' as const),
      icon: 'external',
      hint: '发不出去的消息，点进会话页可重发',
    },
    {
      label: '压缩失败',
      value: formatNumber(d.compaction.failedRuns),
      tone: d.compaction.failedRuns > 0 ? ('err' as const) : ('ok' as const),
      icon: 'compaction',
      hint: `累计压缩 ${formatNumber(d.compaction.runs)} 次`,
    },
  ]
})

/** 第二排：体检数据。 */
const vitals = computed(() => {
  const d = data.value
  if (d === undefined) return []
  const total = d.routing.total24h
  return [
    {
      label: '活跃 token',
      value: formatTokens(d.memory.activeTokens),
      hint: `碎片 ${formatTokens(d.memory.fragmentTokens)}`,
    },
    {
      label: '记忆条目',
      value: formatNumber(d.memory.activeEntries + d.memory.fragmentEntries),
      hint: `活跃 ${formatNumber(d.memory.activeEntries)} · 碎片 ${formatNumber(d.memory.fragmentEntries)} · 长期 ${formatNumber(d.memory.longEntries)}`,
    },
    {
      label: '24h 降级率',
      value: total === 0 ? '—' : formatPercent(d.routing.degraded24h / total),
      tone: total > 0 && d.routing.degraded24h / total > 0.3 ? ('warn' as const) : ('neutral' as const),
      hint: `共 ${formatNumber(total)} 次路由`,
    },
    {
      label: '端点',
      value: `${formatNumber(d.routing.healthyEndpoints)}/${formatNumber(d.routing.endpoints)}`,
      tone: d.routing.endpoints > 0 && d.routing.healthyEndpoints === 0 ? ('err' as const) : ('neutral' as const),
      hint: '健康 / 已登记',
    },
  ]
})

const dbLine = computed(() => {
  const d = data.value
  if (d === undefined) return ''
  return `${d.db.path} · 主库 ${formatBytes(d.db.sizeBytes)} · WAL ${formatBytes(d.db.walBytes)}`
})
</script>

<template>
  <div class="overview">
    <AsyncSection
      :loading="state.loading.value"
      :error="state.error.value"
      :updated-at="state.updatedAt.value"
      :skeleton-rows="6"
      @retry="state.refresh()"
    >
      <template v-if="data">
        <!-- ① 要不要现在动手 -->
        <div class="grid grid-4">
          <StatCard
            v-for="item in health"
            :key="item.label"
            :label="item.label"
            :value="item.value"
            :hint="item.hint"
            :tone="item.tone"
            :icon="item.icon"
          />
        </div>

        <!-- ② 体检数据 -->
        <div class="grid grid-4">
          <StatCard
            v-for="item in vitals"
            :key="item.label"
            :label="item.label"
            :value="item.value"
            :hint="item.hint"
            :tone="item.tone"
          />
        </div>

        <!-- ③ 运行图表：先看趋势，再看明细 -->
        <PanelCard title="运行图表" :subtitle="`按小时聚合，最近 ${seriesHours} 小时（空桶也画出来，不会把「没消息」画成「连续有消息」）`">
          <template #actions>
            <div class="range" role="radiogroup" aria-label="时间范围">
              <button
                v-for="option in RANGES"
                :key="option.value"
                type="button"
                role="radio"
                :aria-checked="seriesHours === option.value"
                :data-active="seriesHours === option.value"
                @click="seriesHours = option.value"
              >
                {{ option.label }}
              </button>
            </div>
          </template>

          <AsyncSection
            :loading="series.loading.value"
            :error="series.error.value"
            :updated-at="series.updatedAt.value"
            :skeleton-rows="4"
            @retry="series.refresh()"
          >
            <div v-if="chartSeries && series.data.value" class="charts">
              <div class="chart-block">
                <h4>消息与轮次</h4>
                <TimeSeriesChart
                  :buckets="series.data.value.buckets"
                  :series="chartSeries.traffic"
                  kind="bar"
                  unit="count"
                  :height="150"
                />
              </div>

              <div class="chart-block">
                <h4>路由与降级</h4>
                <TimeSeriesChart
                  :buckets="series.data.value.buckets"
                  :series="chartSeries.routing"
                  kind="area"
                  unit="count"
                  :height="150"
                />
              </div>

              <div class="chart-block">
                <h4>提示词 token</h4>
                <TimeSeriesChart
                  :buckets="series.data.value.buckets"
                  :series="chartSeries.tokens"
                  kind="area"
                  unit="tokens"
                  :height="150"
                />
              </div>

              <div class="chart-block">
                <h4>缓存命中率</h4>
                <TimeSeriesChart
                  :buckets="series.data.value.buckets"
                  :series="chartSeries.cache"
                  kind="area"
                  unit="percent"
                  :height="150"
                />
              </div>

              <div class="chart-block wide">
                <h4>出站发送</h4>
                <TimeSeriesChart
                  :buckets="series.data.value.buckets"
                  :series="chartSeries.outbox"
                  kind="bar"
                  unit="count"
                  :height="130"
                />
              </div>
            </div>
          </AsyncSection>
        </PanelCard>

        <!-- ④ 细节 -->
        <div class="grid grid-2">
          <PanelCard title="记忆" subtitle="三层记忆的当前状态">
            <dl class="kv">
              <div>
                <dt>epoch / 修订号</dt>
                <dd>{{ data.memory.epoch }} / {{ data.memory.revision }}</dd>
              </div>
              <div>
                <dt>最后写入</dt>
                <dd>{{ formatRelative(data.memory.lastWriteAt) }}</dd>
              </div>
              <div>
                <dt>前缀指纹</dt>
                <dd class="mono">
                  修订号 {{ data.memory.revision }} · 压缩世代 {{ data.memory.epoch }}
                </dd>
              </div>
            </dl>
          </PanelCard>

          <PanelCard title="压缩" subtitle="上下文压缩引擎">
            <dl class="kv">
              <div>
                <dt>最近一次</dt>
                <dd>
                  {{ formatRelative(data.compaction.lastAt) }}
                  <span v-if="data.compaction.lastStatus" class="tag" :data-tone="data.compaction.lastStatus === 'committed' ? 'ok' : 'warn'">
                    {{ data.compaction.lastStatus }}
                  </span>
                </dd>
              </div>
              <div>
                <dt>token 变化</dt>
                <dd>
                  <template v-if="data.compaction.tokensBefore !== undefined && data.compaction.tokensAfter !== undefined">
                    {{ formatTokens(data.compaction.tokensBefore) }} → {{ formatTokens(data.compaction.tokensAfter) }}
                  </template>
                  <template v-else>—</template>
                </dd>
              </div>
            </dl>
          </PanelCard>

          <PanelCard title="路由" subtitle="模型分级路由">
            <dl class="kv">
              <div>
                <dt>最近切换</dt>
                <dd>{{ formatRelative(data.routing.lastSwitchAt) }}</dd>
              </div>
              <div>
                <dt>不确定样本</dt>
                <dd>
                  {{ formatNumber(data.routing.uncertainPending) }}
                  <span class="muted"> 待处理</span>
                </dd>
              </div>
            </dl>
          </PanelCard>

          <PanelCard title="时间与服务" subtitle="时间感知与运行时">
            <dl class="kv">
              <div>
                <dt>权威时区</dt>
                <dd>{{ data.time.authorityTz }}</dd>
              </div>
              <div>
                <dt>时钟漂移</dt>
                <dd>{{ data.time.driftMs === undefined ? '—' : `${data.time.driftMs} ms` }}</dd>
              </div>
              <div>
                <dt>已运行</dt>
                <dd>{{ formatDuration(data.build.uptimeSec) }}</dd>
              </div>
              <div>
                <dt>版本</dt>
                <dd class="mono">schema v{{ data.build.schemaVersion }} · node {{ data.build.node }}</dd>
              </div>
            </dl>
          </PanelCard>
        </div>

        <p class="muted db-line">
          <AppIcon name="storage" :size="14" />
          <span class="mono">{{ dbLine }}</span>
        </p>
      </template>
    </AsyncSection>
  </div>
</template>

<style scoped>
.overview {
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

.kv {
  display: flex;
  flex-direction: column;
  gap: var(--s-2);
}

/* ── 运行图表 ─────────────────────────────────────────────── */
.range {
  display: inline-flex;
  gap: 2px;
  padding: 2px;
  background: var(--c-surface-2);
  border-radius: var(--r-md);
}
.range button {
  min-height: 28px;
  padding: 0 var(--s-3);
  border: none;
  border-radius: var(--r-sm);
  background: transparent;
  color: var(--c-text-3);
  cursor: pointer;
  font-size: var(--t-xs);
  transition: background var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease);
}
.range button:hover {
  color: var(--c-text);
}
.range button[data-active='true'] {
  background: var(--c-surface);
  color: var(--c-text);
  box-shadow: var(--sh-1);
}

.charts {
  display: grid;
  gap: var(--s-4);
  grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
}
.chart-block {
  min-width: 0;
}
.chart-block.wide {
  grid-column: 1 / -1;
}
.chart-block h4 {
  margin-bottom: var(--s-2);
  color: var(--c-text-2);
  font-size: var(--t-xs);
  font-weight: 600;
}
.kv > div {
  display: flex;
  align-items: baseline;
  gap: var(--s-3);
  justify-content: space-between;
}
.kv dt {
  flex: none;
  color: var(--c-text-3);
  font-size: var(--t-xs);
}
.kv dd {
  min-width: 0;
  text-align: right;
  color: var(--c-text-2);
  font-variant-numeric: tabular-nums;
  word-break: break-all;
}

.tag {
  margin-left: var(--s-2);
  padding: 0 6px;
  border-radius: var(--r-full);
  background: var(--c-surface-2);
  font-size: 10px;
}
.tag[data-tone='ok'] {
  background: var(--c-ok-soft);
  color: var(--c-ok);
}
.tag[data-tone='warn'] {
  background: var(--c-warn-soft);
  color: var(--c-warn);
}

.db-line {
  display: flex;
  align-items: center;
  gap: var(--s-2);
  font-size: var(--t-xs);
  word-break: break-all;
}
</style>
