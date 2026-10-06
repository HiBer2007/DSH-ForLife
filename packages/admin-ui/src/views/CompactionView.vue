<script setup lang="ts">
/**
 * 压缩 —— 「上下文被谁动过、动成什么样」的观察面。
 *
 * 这一页要回答的问题（按重要性排序）：
 *  1. 有没有**出事**的压缩（中止的事务、停在 started 没下文的）——唯一需要立刻动手的情况；
 *  2. 最近一次把短期窗口的 token 从多少压到多少（决定上下文余量与成本）；
 *  3. 每次事务走到哪一步、每条决策为什么被批或被拒。
 *
 * 所以顺序是：计数 → 事务时间线 → 决策日志。筛选只做"相位"：
 * 排查时人总是从"哪一次中止了 / 哪一次没跑完"进手，而不是先搜关键词。
 */
import { computed, ref } from 'vue'

import { api } from '../api/client.ts'
import type { CompactionOverview, CompactionPhase, CompactionRunView } from '../api/types-memory.ts'
import AsyncSection from '../components/AsyncSection.vue'
import DataTable, { type TableColumn } from '../components/DataTable.vue'
import PanelCard from '../components/PanelCard.vue'
import StatCard from '../components/StatCard.vue'
import StatusBadge from '../components/StatusBadge.vue'
import { useAsyncData } from '../composables/useAsyncData.ts'
import { formatDateTime, formatDuration, formatNumber, formatRelative, formatTokens } from '../utils/format.ts'

const state = useAsyncData<CompactionOverview>(() => api.get<CompactionOverview>('/compaction'))

const stats = computed(() => state.data.value?.stats)
const runs = computed<readonly CompactionRunView[]>(() => state.data.value?.runs ?? [])
const logRows = computed(() => state.data.value?.log ?? [])

/** 相位的展示名。库里的取值是英文（started/committed/aborted），界面上不给人看这个。 */
function phaseLabel(phase: CompactionPhase): string {
  if (phase === 'committed') return '已提交'
  if (phase === 'aborted') return '已中止'
  return '未完成'
}

/** 相位 → 语义色：提交=好，中止=坏，停在中途不是"坏"而是"没结论"——所以是 warn 不是 err。 */
function phaseTone(phase: CompactionPhase): 'ok' | 'warn' | 'err' {
  if (phase === 'committed') return 'ok'
  if (phase === 'aborted') return 'err'
  return 'warn'
}

/**
 * `epochFrom → epochTo` 文案。
 *
 * 判断用 `=== undefined` 而不是真值判断：**epoch 0 是合法值**，
 * `if (!run.epochTo)` 会把"第一次压缩的目标世代 0"显示成"没提交"（与服务端同一条坑）。
 */
function epochText(run: CompactionRunView): string {
  return run.epochTo === undefined ? `${run.epochFrom} → 未提交` : `${run.epochFrom} → ${run.epochTo}`
}

/**
 * 事务耗时（秒）。
 *
 * 两端都在且都能解析才给数：`started` 相位的 run 没有 `endedAt`，
 * 拿 `Date.now()` 顶替会显示一个每秒都在涨的假耗时。解析失败给 undefined 而不是 NaN，
 * 否则 `formatDuration` 会渲染出 "NaN 秒"。
 */
function durationSeconds(run: CompactionRunView): number | undefined {
  if (run.endedAt === undefined) return undefined
  const from = Date.parse(run.startedAt)
  const to = Date.parse(run.endedAt)
  if (Number.isNaN(from) || Number.isNaN(to)) return undefined
  return Math.max(0, (to - from) / 1000)
}

/** 停在 `started` 的事务数：服务端说这是报警信号，所以单独拎出来在页面顶部提示。 */
const startedCount = computed(() => stats.value?.started ?? 0)

/** 一次都没压缩过时，"最近一次"给一句话而不是一个"—"（后者不知道是没数据还是坏了）。 */
const lastAtValue = computed(() => {
  const at = stats.value?.lastAt
  return at === undefined ? '还没发生' : formatRelative(at)
})
const lastAtHint = computed(() => {
  const at = stats.value?.lastAt
  return at === undefined ? '一次压缩都还没触发过' : formatDateTime(at)
})

/** token 变化：两个读数各自可能缺席（没有日志时），缺席的那一侧由 formatTokens 显示成占位符。 */
const tokenBefore = computed(() => stats.value?.tokensBefore)
const tokenAfter = computed(() => stats.value?.tokensAfter)
const tokenValue = computed(() => {
  const before = tokenBefore.value
  const after = tokenAfter.value
  if (before === undefined && after === undefined) return '—'
  return `${formatTokens(before)} → ${formatTokens(after)}`
})
/**
 * 这两个数取自**最新一行日志**（与总览页同一口径），不取累计——累计对"窗口还剩多少"毫无意义。
 * 已知坑照实说：目前唯一的写入方把 `short_tokens_before` 写死成 0，
 * 全 0 读数是"写入方没填"，不是"压缩前上下文是空的"。
 */
const tokenHint = computed(() => {
  const before = tokenBefore.value
  const after = tokenAfter.value
  if (before === undefined && after === undefined) return '还没有决策日志，没有可对比的读数'
  if (before === 0 && after === 0) return '读数是 0：写入方目前还没填真实 token，不代表压缩前是空的'
  return '短期窗口 token，取自最近一行决策日志'
})

/** 相位筛选：默认全部。"出事的那几条"由顶部卡片和告警条负责，不靠默认筛选把它们藏起来。 */
const PHASES = [
  { value: 'all', label: '全部' },
  { value: 'committed', label: '已提交' },
  { value: 'aborted', label: '已中止' },
  { value: 'started', label: '未完成' },
] as const
const phaseFilter = ref<(typeof PHASES)[number]['value']>('all')

const runRows = computed<readonly CompactionRunView[]>(() => {
  const wanted = phaseFilter.value
  if (wanted === 'all') return runs.value
  return runs.value.filter((run) => run.phase === wanted)
})

/** 空状态要分两种：真的没压缩过，和"筛掉了"。混成一句话会让人以为库是空的。 */
const runEmptyText = computed(() =>
  phaseFilter.value === 'all'
    ? '压缩还没发生过。等短记忆累积到阈值（上下文压力到线），系统会自动触发一次压缩；届时这里会出现事务记录。'
    : '这个相位下还没有记录。切回「全部」能看到所有事务；顶部卡片的数字始终是全量口径，不受筛选影响。',
)

const runSubtitle = computed(
  () =>
    `共 ${formatNumber(stats.value?.committed ?? 0)} 次提交、${formatNumber(stats.value?.aborted ?? 0)} 次中止、` +
    `${formatNumber(startedCount.value)} 次未完成，按开始时间倒序（本页 ${formatNumber(runRows.value.length)} 条）`,
)

const logSubtitle = computed(() => `按时间倒序，最近 ${formatNumber(logRows.value.length)} 条裁决记录`)

/**
 * `approved` 是**三态**：true 批准 / false 拒绝 / 键缺席 = 库里没记录。
 * 把缺席渲染成"被拒绝"就是替库下结论（服务端特意用"省略键"表达"没记录"，见 types-memory.ts）。
 */
function approvalText(value: unknown): string {
  if (value === undefined) return '未记录'
  return value === true ? '已批准' : '被拒绝'
}

const logColumns: TableColumn<Record<string, unknown>>[] = [
  { key: 'timestamp', label: '时间', primary: true, value: (row) => formatDateTime(String(row['timestamp'])) },
  { key: 'requestedBy', label: '请求方', mono: true, narrow: true, secondary: true },
  { key: 'approved', label: '裁决', narrow: true, value: (row) => approvalText(row['approved']) },
  { key: 'reasonIfRejected', label: '拒绝原因' },
  // 卡片上用 k 缩写看量级，表格里给精确值看对比（两者差一个数量级的误读代价更大）
  { key: 'shortTokensBefore', label: '压缩前 token', numeric: true, narrow: true, value: (row) => formatNumber(Number(row['shortTokensBefore'])) },
  { key: 'keptInShortTokens', label: '保留 token', numeric: true, narrow: true, value: (row) => formatNumber(Number(row['keptInShortTokens'])) },
  { key: 'modelUsed', label: '模型', mono: true, narrow: true },
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
            label="已提交次数"
            :value="formatNumber(stats?.committed)"
            :tone="(stats?.committed ?? 0) > 0 ? 'ok' : 'neutral'"
            icon="check"
            hint="成功推进 epoch 的压缩事务"
          />
          <StatCard
            label="中止次数"
            :value="formatNumber(stats?.aborted)"
            :tone="startedCount > 0 ? 'err' : (stats?.aborted ?? 0) > 0 ? 'warn' : 'neutral'"
            icon="warning"
            :hint="startedCount > 0 ? `另有 ${formatNumber(startedCount)} 次停在未完成，见下方告警` : '失败并回滚的事务'"
          />
          <StatCard
            label="最近一次压缩"
            :value="lastAtValue"
            :hint="lastAtHint"
            icon="refresh"
            tone="brand"
          />
          <StatCard
            label="token 变化"
            :value="tokenValue"
            :hint="tokenHint"
            icon="compaction"
          />
        </div>

        <!--
          停在 started 的事务是**报警**而不是统计：上一次压缩没走完就到了重启，
          库里可能残留半写条目。这条提示只在真的出现时显示，平时不占视线。
        -->
        <p v-if="startedCount > 0" class="alarm" role="alert">
          <StatusBadge tone="warn" dot>未完成</StatusBadge>
          <span>
            有 {{ formatNumber(startedCount) }} 次压缩停在「未完成」就没下文了（多半是进程在事务中途重启，
            启动回滚没跑成）。先看下面的事务表：其中有活跃压缩事务时不要动库。
          </span>
        </p>

        <PanelCard title="压缩运行" :subtitle="runSubtitle">
          <template #actions>
            <div class="segmented" role="radiogroup" aria-label="按相位筛选">
              <button
                v-for="option in PHASES"
                :key="option.value"
                type="button"
                role="radio"
                :aria-checked="phaseFilter === option.value"
                :data-active="phaseFilter === option.value"
                @click="phaseFilter = option.value"
              >
                {{ option.label }}
              </button>
            </div>
          </template>

          <!--
            这一块**故意不用 DataTable**：DataTable 的单元格只渲染字符串，
            而相位必须是一个带语义色的 StatusBadge（"中止"要在一眼扫过时就跳出来）。
            手机端用同一份标记靠 CSS 把表格折成卡片（见 <style> 里的媒体查询），不复制模板。
          -->
          <table v-if="runRows.length > 0" class="runs">
            <thead>
              <tr>
                <th scope="col">相位</th>
                <th scope="col">epoch</th>
                <th scope="col">开始</th>
                <th scope="col">结束</th>
                <th scope="col" class="num">耗时</th>
                <th scope="col">错误</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="run in runRows" :key="run.id">
                <td data-label="相位">
                  <StatusBadge :tone="phaseTone(run.phase)" dot>{{ phaseLabel(run.phase) }}</StatusBadge>
                </td>
                <td data-label="epoch" class="mono">{{ epochText(run) }}</td>
                <td data-label="开始" :title="formatDateTime(run.startedAt)">{{ formatRelative(run.startedAt) }}</td>
                <td data-label="结束" :title="run.endedAt === undefined ? undefined : formatDateTime(run.endedAt)">
                  {{ run.endedAt === undefined ? '—' : formatRelative(run.endedAt) }}
                </td>
                <td data-label="耗时" class="num">{{ formatDuration(durationSeconds(run)) }}</td>
                <td data-label="错误" class="err-cell">{{ run.error ?? '—' }}</td>
              </tr>
            </tbody>
          </table>
          <p v-else class="empty">{{ runEmptyText }}</p>
        </PanelCard>

        <PanelCard title="压缩决策日志" :subtitle="logSubtitle">
          <DataTable
            :columns="logColumns"
            :rows="logRows"
            empty-text="还没有压缩决策记录。模型调用 request_compaction 或系统按上下文压力触发之后，这里会留下每次裁决的结果（批准 / 拒绝 / 未记录）与当时的 token 读数。"
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

.alarm {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--s-2);
  padding: var(--s-3) var(--s-4);
  background: var(--c-warn-soft);
  color: var(--c-warn);
  border-radius: var(--r-md);
  font-size: var(--t-sm);
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

/* 桌面：与 DataTable 的表格同一套度量（内边距/边框/字号），两块表放在一页里不会像两个系统 */
.runs {
  width: 100%;
  border-collapse: collapse;
  font-size: var(--t-sm);
}
.runs th,
.runs td {
  padding: 8px var(--s-2);
  text-align: left;
  border-bottom: 1px solid var(--c-border);
  vertical-align: top;
}
.runs th {
  position: sticky;
  top: 0;
  z-index: 1;
  background: var(--c-surface);
  color: var(--c-text-3);
  font-size: var(--t-xs);
  font-weight: 600;
  white-space: nowrap;
}
.runs tbody tr:hover {
  background: var(--c-surface-2);
}
.runs td {
  color: var(--c-text-2);
  max-width: 32ch;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.runs .num {
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.runs .mono {
  font-family: var(--font-mono);
  font-size: 0.92em;
}
/* 错误文本是这一页最该被读到的一列，给它比其它列更多的宽度与换行 */
.runs .err-cell {
  max-width: 44ch;
  white-space: normal;
  overflow-wrap: anywhere;
}

.empty {
  padding: var(--s-6) 0;
  text-align: center;
  color: var(--c-text-3);
  font-size: var(--t-sm);
}

/* 手机端：表头去掉，每行折成一张卡片，单元格用 data-label 补回列名 */
@media (max-width: 720px) {
  .runs,
  .runs tbody,
  .runs tr,
  .runs td {
    display: block;
    width: auto;
  }
  .runs thead {
    display: none;
  }
  .runs tr {
    margin-bottom: var(--s-2);
    padding: var(--s-3);
    background: var(--c-surface-2);
    border-radius: var(--r-md);
  }
  .runs tbody tr:hover {
    background: var(--c-surface-2);
  }
  .runs td {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--s-3);
    max-width: none;
    padding: 2px 0;
    border-bottom: none;
    white-space: normal;
    text-align: right;
  }
  .runs td::before {
    content: attr(data-label);
    flex: none;
    color: var(--c-text-3);
    font-size: var(--t-xs);
  }
  .runs .err-cell {
    max-width: none;
  }
}
</style>
