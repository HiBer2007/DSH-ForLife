<script setup lang="ts">
/**
 * 运行总览 —— 打开面板第一眼要看的东西。
 *
 * 排序原则：**先看"是不是还活着"，再看"花了多少"，最后看细节**。
 * 所以最上面一排是连接/队列/失败这类"要不要现在动手"的指标，
 * 下面才是记忆、压缩、路由这些需要下钻的块。
 *
 * 自动刷新 15 秒一次；切到后台标签页时停掉（手机省电，也不打扰服务端）。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

import { api } from '../api/client.ts'
import type { Overview } from '../api/types.ts'
import AppIcon from '../components/AppIcon.vue'
import AsyncSection from '../components/AsyncSection.vue'
import PanelCard from '../components/PanelCard.vue'
import StatCard from '../components/StatCard.vue'
import { useAsyncData } from '../composables/useAsyncData.ts'
import { formatBytes, formatDuration, formatNumber, formatPercent, formatRelative, formatTokens } from '../utils/format.ts'

const state = useAsyncData<Overview>(() => api.get<Overview>('/overview'))

const REFRESH_MS = 15_000
let timer: number | undefined

function startTimer(): void {
  stopTimer()
  timer = window.setInterval(() => {
    if (document.visibilityState === 'visible') void state.refresh()
  }, REFRESH_MS)
}
function stopTimer(): void {
  if (timer !== undefined) {
    window.clearInterval(timer)
    timer = undefined
  }
}

function onVisibility(): void {
  if (document.visibilityState === 'visible') {
    void state.refresh()
    startTimer()
  } else {
    stopTimer()
  }
}

onMounted(() => {
  startTimer()
  document.addEventListener('visibilitychange', onVisibility)
})
onBeforeUnmount(() => {
  stopTimer()
  document.removeEventListener('visibilitychange', onVisibility)
})

const data = computed(() => state.data.value)

/** 第一排：要不要现在动手。 */
const health = computed(() => {
  const d = data.value
  if (d === undefined) return []
  return [
    {
      label: 'QQ 连接',
      value: d.qq.connected ? '在线' : '离线',
      tone: d.qq.connected ? ('ok' as const) : ('err' as const),
      icon: 'chat',
      hint: d.qq.lastInboundAt === undefined ? '还没收到过消息' : `最后收到 ${formatRelative(d.qq.lastInboundAt)}`,
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
      label: '渲染 token',
      value: formatTokens(d.memory.renderedTokens),
      hint: `活跃 ${formatTokens(d.memory.activeTokens)} · 碎片 ${formatTokens(d.memory.fragmentTokens)}`,
    },
    {
      label: '记忆条目',
      value: formatNumber(d.memory.activeEntries + d.memory.fragmentEntries),
      hint: `活跃 ${formatNumber(d.memory.activeEntries)} · 碎片 ${formatNumber(d.memory.fragmentEntries)}`,
    },
    {
      label: '24h 降级率',
      value: total === 0 ? '—' : formatPercent(d.degraded24h / total),
      tone: total > 0 && d.degraded24h / total > 0.3 ? ('warn' as const) : ('neutral' as const),
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

        <!-- ③ 细节 -->
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
                  {{ data.memory.renderedTokens > 0 ? `${formatTokens(data.memory.renderedTokens)} tokens 已渲染` : '尚未渲染' }}
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
                <dd class="mono">
                  {{ data.build.version }} · node {{ data.build.node }} · 参数 {{ data.build.params }} 条
                </dd>
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
