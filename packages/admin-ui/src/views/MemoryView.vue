<script setup lang="ts">
/**
 * 记忆 —— 三层记忆的观察面。
 *
 * 这一页要回答的问题（按重要性排序）：
 *  1. 现在**有多少**记忆、占多少 token（决定成本与上下文压力）；
 *  2. 有没有**卡住**的条目（碎片没沉降、世代没推进）；
 *  3. 具体某条记忆长什么样（摘要、来源、什么时候写的、被谁引用过）。
 *
 * 所以顺序是：计数 → token → 筛选后的条目表。
 * 「归档」单独计数但默认不显示——它们是历史，混在列表里只会稀释注意力。
 */
import { computed, ref } from 'vue'

import { api } from '../api/client.ts'
import type { MemoryEntryRow, MemoryOverview } from '../api/types.ts'
import AsyncSection from '../components/AsyncSection.vue'
import DataTable, { type TableColumn } from '../components/DataTable.vue'
import PanelCard from '../components/PanelCard.vue'
import StatCard from '../components/StatCard.vue'
import StatusBadge from '../components/StatusBadge.vue'
import { useAsyncData } from '../composables/useAsyncData.ts'
import { formatNumber, formatRelative, formatTokens } from '../utils/format.ts'

const state = useAsyncData<MemoryOverview>(() => api.get<MemoryOverview>('/memory'))

/** 状态筛选。默认"活跃 + 碎片"，因为归档属于历史。 */
const FILTERS = [
  { value: 'live', label: '活跃与碎片' },
  { value: 'active', label: '仅活跃' },
  { value: 'fragmented', label: '仅碎片' },
  { value: 'archived', label: '归档' },
  { value: 'all', label: '全部' },
] as const
const filter = ref<(typeof FILTERS)[number]['value']>('live')
const keyword = ref('')

const rows = computed(() => {
  const entries = state.data.value?.entries ?? []
  const byStatus = entries.filter((entry) => {
    if (filter.value === 'all') return true
    if (filter.value === 'live') return entry.status === 'active' || entry.status === 'fragmented'
    return entry.status === filter.value
  })
  const needle = keyword.value.trim().toLowerCase()
  if (needle === '') return byStatus
  return byStatus.filter(
    (entry) =>
      entry.summary.toLowerCase().includes(needle) ||
      entry.contentPreview.toLowerCase().includes(needle) ||
      (entry.sourceScope ?? '').toLowerCase().includes(needle),
  )
})

/** 状态 → 语义色。 */
function toneOf(status: string): 'ok' | 'warn' | 'muted' | 'info' {
  if (status === 'active') return 'ok'
  if (status === 'fragmented') return 'warn'
  if (status === 'archived') return 'muted'
  return 'info'
}

const columns: TableColumn<Record<string, unknown>>[] = [
  { key: 'summary', label: '摘要', primary: true },
  { key: 'createdAt', label: '写入', secondary: true, value: (row) => formatRelative(String(row['createdAt'])) },
  { key: 'status', label: '状态', narrow: true },
  { key: 'entryType', label: '类型', narrow: true },
  { key: 'tokenCount', label: 'token', numeric: true, narrow: true, value: (row) => formatNumber(Number(row['tokenCount'])) },
  { key: 'windowOffset', label: '窗口位', numeric: true, narrow: true },
  { key: 'compactionEpoch', label: '世代', numeric: true, narrow: true },
  { key: 'sourceScope', label: '来源', mono: true, narrow: true },
  {
    key: 'lastAccessedAt',
    label: '最后访问',
    narrow: true,
    value: (row) =>
      row['lastAccessedAt'] === undefined || row['lastAccessedAt'] === null
        ? '—'
        : formatRelative(String(row['lastAccessedAt'])),
  },
  { key: 'id', label: 'ID', mono: true },
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
            label="活跃条目"
            :value="formatNumber(state.data.value.counts.active)"
            :hint="`占 ${formatTokens(state.data.value.tokens.active)} token`"
            tone="ok"
            icon="memory"
          />
          <StatCard
            label="碎片条目"
            :value="formatNumber(state.data.value.counts.fragmented)"
            :hint="`占 ${formatTokens(state.data.value.tokens.fragment)} token`"
            :tone="state.data.value.counts.fragmented > 0 ? 'warn' : 'neutral'"
            icon="fragment"
          />
          <StatCard
            label="长期记忆"
            :value="formatNumber(state.data.value.counts.long)"
            hint="已沉降到冷层"
            icon="storage"
          />
          <StatCard
            label="压缩世代 / 修订号"
            :value="`${state.data.value.epoch} / ${state.data.value.revision}`"
            hint="世代变化说明发生过压缩"
          />
        </div>

        <PanelCard
          title="记忆条目"
          :subtitle="`共 ${formatNumber(state.data.value.counts.active + state.data.value.counts.fragmented + state.data.value.counts.archived)} 条，当前显示 ${formatNumber(rows.length)} 条`"
        >
          <template #actions>
            <div class="toolbar">
              <input v-model="keyword" type="search" placeholder="搜摘要 / 来源…" aria-label="搜索记忆条目" />
              <div class="segmented" role="radiogroup" aria-label="状态筛选">
                <button
                  v-for="option in FILTERS"
                  :key="option.value"
                  type="button"
                  role="radio"
                  :aria-checked="filter === option.value"
                  :data-active="filter === option.value"
                  @click="filter = option.value"
                >
                  {{ option.label }}
                </button>
              </div>
            </div>
          </template>

          <DataTable
            :columns="columns"
            :rows="rows"
            empty-text="还没有记忆条目。QQ 会话跑起来之后，对话摘要会写进这里；也可以用 DSH 会话里的插件面板手动触发一次压缩。"
          />

          <template #footer>
            <p class="muted legend">
              <StatusBadge tone="ok" dot>活跃</StatusBadge> 参与渲染，进模型上下文 ·
              <StatusBadge tone="warn" dot>碎片</StatusBadge> 已被压缩成摘要，等待沉降 ·
              <StatusBadge tone="muted" dot>归档</StatusBadge> 历史，不参与渲染
            </p>
          </template>
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

.legend {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  font-size: var(--t-xs);
}
</style>
