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

/** 指标卡的一格（`health` / `vitals` 共用同一个形状）。 */
interface Card {
  readonly label: string
  readonly value: string
  readonly tone: 'neutral' | 'ok' | 'warn' | 'err'
  readonly icon?: string
  readonly hint: string
}

/**
 * DSH 后端状态卡（★ 2026-10-09：这个字段**以前前端根本没显示**）。
 *
 * ## 为什么它必须在这一排、而且排第一
 *
 * 这一排回答的是"**现在要不要动手**"。而"DSH 挂了"是这里**唯一**一个
 * 面板上别处看不出来的故障：QQ 在收消息、库在写、图表在动，只有模型那一侧没在跑。
 * 数据链修好之前，这个字段在 gateway 那边被展开进了 `time` 对象里，
 * 前端连类型都没有 —— 于是"DSH 状态未知"永远显示，等于没做。
 *
 * ## 为什么是四态而不是两态
 *
 * `dsh === undefined`（服务端这一轮没给）、`reachable === undefined`（**没配 URL，
 * 无法判断**）、`reachable === false`（配了但连不上）、`reachable === true`。
 * 把"没配"和"连不上"合成一个，用户会去查一个根本不存在的东西
 * （`dsh-status.ts` 的模块注释里就是这么定性的）。
 */
function dshCard(dsh: Overview['dsh']): Card {
  if (dsh === undefined) {
    return {
      label: 'DSH 后端',
      value: '未知',
      tone: 'neutral',
      icon: 'external',
      hint: '这次总览没有带 DSH 状态（gateway 那一轮没探）',
    }
  }
  const where = dsh.url ?? '未配置 FORLIFE_DSH_URL'
  if (dsh.reachable === undefined) {
    return {
      label: 'DSH 后端',
      value: '未配置',
      tone: 'neutral',
      icon: 'external',
      hint: `${where} · 无法判断 DSH 是否在跑（**不是**"连不上"）`,
    }
  }
  if (!dsh.reachable) {
    const latency = dsh.latencyMs === undefined ? '' : ` · ${String(dsh.latencyMs)} ms`
    return {
      label: 'DSH 后端',
      value: '连不上',
      tone: 'err',
      icon: 'warning',
      hint: `${where}${latency} · 模型那一侧可能没在跑`,
    }
  }
  const latency = dsh.latencyMs === undefined ? '' : ` · ${String(dsh.latencyMs)} ms`
  return { label: 'DSH 后端', value: '在线', tone: 'ok', icon: 'external', hint: `${where}${latency}` }
}

/** 第一排：要不要现在动手。 */
const health = computed<Card[]>(() => {
  const d = data.value
  if (d === undefined) return []
  return [
    // ★ DSH 排第一：它挂了的时候，下面每一张卡看起来都还是正常的
    dshCard(d.dsh),
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

/**
 * 「窗口丢弃」卡的副标题：丢了几条、是不是撞到**条数**上限、以及两个预算。
 *
 * 为什么单独抽一个函数：这段有三个条件分支，塞进 `computed` 里就会变成
 * 模板字面量套模板字面量 —— 本仓约定**不嵌套反引号**（少看一个反引号就整段跑偏）。
 */
function windowDropHint(memory: Overview['memory']): string {
  const head = `${formatNumber(memory.windowDroppedEntries)} 条出窗`
  const byCount = memory.windowDroppedByCount > 0 ? `，其中 ${formatNumber(memory.windowDroppedByCount)} 条撞条数上限` : ''
  return `${head}${byCount} · 预算 ${formatTokens(memory.windowMaxTokens)} / ${formatNumber(memory.windowMaxCount)} 条`
}

/** 第二排：体检数据。 */
const vitals = computed(() => {
  const d = data.value
  if (d === undefined) return []
  const total = d.routing.total24h
  return [
    {
      // ★ 2026-10-09：「活跃 token」= **窗口口径**（真正进系统提示词的量）。
      // 之前这里读的是 `activeTokens`（**全表** SUM，真机 1,505k），
      // 而窗口实际只放进去一小段 —— 数字对不上时用户会以为窗口没生效。
      // 全表那个数**没删**，挪到副标题里：它是诊断口径，排障时要看的就是它。
      label: '活跃 token',
      value: formatTokens(d.memory.windowTokens),
      hint: `窗口内 ${formatNumber(d.memory.windowEntries)} 条 · 全表 ${formatTokens(d.memory.activeTokens)}`,
    },
    {
      // 新增（用户裁定 ④ 的"暴露窗口丢弃了多少"）：窗口丢了多少 token / 多少条。
      // tone 用 warn 而不是 err：丢弃是**正常**的容量管理，只有撞条数上限才是畸形信号
      // （那种情况副标题会写出来）。
      label: '窗口丢弃',
      value: formatTokens(d.memory.windowDroppedTokens),
      tone: d.memory.windowDroppedEntries > 0 ? ('warn' as const) : ('ok' as const),
      hint: windowDropHint(d.memory),
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
              <!-- ★ DSH 的细节：上面那张卡只给结论，这里给"是哪个地址、桥配没配"。 -->
              <div v-if="data.dsh">
                <dt>DSH 探测</dt>
                <dd>
                  {{ formatRelative(data.dsh.at) }}
                  <span class="muted"> · 唤醒桥 {{ data.dsh.wakeBridgeConfigured ? '已配置' : '未配置' }}</span>
                </dd>
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
