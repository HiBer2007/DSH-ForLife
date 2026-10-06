<script setup lang="ts">
/**
 * 表情库 —— 看这个机器人"认得哪些表情"。
 *
 * 三个刻意的决定：
 *  1. **图片经我们自己的接口取**（`/api/admin/sticker-file?id=…`），不是给文件路径：
 *     直接引路径要么得把目录暴露成静态资源（等于公开整个库），要么浏览器根本读不到。
 *  2. **区分"我们的"与"学来的"**：学来的默认不主动转发，这一点必须在界面上看得见，
 *     否则你会在某天发现机器人发了一张你没收藏过的图，却不知道为什么。
 *  3. **空库时说明"怎么才会有"**，而不是画一个空网格。
 */
import { computed, ref } from 'vue'

import { api } from '../api/client.ts'
import type { StickersOverview } from '../api/types-stickers.ts'
import AsyncSection from '../components/AsyncSection.vue'
import PanelCard from '../components/PanelCard.vue'
import StatCard from '../components/StatCard.vue'
import StatusBadge from '../components/StatusBadge.vue'
import { useAsyncData } from '../composables/useAsyncData.ts'
import { formatBytes, formatNumber, formatRelative } from '../utils/format.ts'

const state = useAsyncData<StickersOverview>(() => api.get<StickersOverview>('/stickers'))

/** 筛选：全部 / 我们的 / 学来的 / 还没描述。 */
const FILTERS = [
  { value: 'all', label: '全部' },
  { value: 'ours', label: '我们的' },
  { value: 'learned', label: '学来的' },
  { value: 'undescribed', label: '还没描述' },
] as const
const filter = ref<(typeof FILTERS)[number]['value']>('all')
const keyword = ref('')

const cards = computed(() => {
  const all = state.data.value?.stickers ?? []
  const byFilter = all.filter((card) => {
    if (filter.value === 'ours') return card.ours
    if (filter.value === 'learned') return !card.ours
    if (filter.value === 'undescribed') return card.description === undefined
    return true
  })
  const needle = keyword.value.trim().toLowerCase()
  if (needle === '') return byFilter
  return byFilter.filter(
    (card) =>
      (card.description ?? '').toLowerCase().includes(needle) ||
      card.emotionTags.some((tag) => tag.toLowerCase().includes(needle)) ||
      card.scopes.some((scope) => scope.toLowerCase().includes(needle)),
  )
})

/** 图片来源：同源、带 cookie（img 标签会自动带）。 */
function imageUrl(id: string): string {
  return `/api/admin/sticker-file?id=${encodeURIComponent(id)}`
}

function sourceLabel(source: string): string {
  switch (source) {
    case 'manual':
      return '手动导入'
    case 'search':
      return '联网抓取'
    case 'self-made':
      return '自造'
    case 'learned':
      return '学来的'
    default:
      return source
  }
}
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
          <StatCard label="库内表情" :value="formatNumber(state.data.value.stats.total)" icon="media" />
          <StatCard
            label="我们的 / 学来的"
            :value="`${formatNumber(state.data.value.stats.ours)} / ${formatNumber(state.data.value.stats.learned)}`"
            hint="学来的默认不主动转发"
          />
          <StatCard
            label="已有描述"
            :value="`${formatNumber(state.data.value.stats.described)} / ${formatNumber(state.data.value.stats.total)}`"
            :tone="state.data.value.stats.described < state.data.value.stats.total ? 'warn' : 'ok'"
            hint="没有描述时检索只能靠标签"
          />
          <StatCard
            label="被拒绝"
            :value="formatNumber(state.data.value.stats.rejected)"
            :tone="state.data.value.stats.rejected > 0 ? 'warn' : 'neutral'"
            hint="白名单外/超大/非法类型，已留证据行"
          />
        </div>

        <PanelCard title="表情库" :subtitle="`显示 ${formatNumber(cards.length)} / ${formatNumber(state.data.value.stats.total)} 张`">
          <template #actions>
            <div class="toolbar">
              <input v-model="keyword" type="search" placeholder="搜描述 / 标签 / 会话…" aria-label="搜索表情" />
              <div class="segmented" role="radiogroup" aria-label="筛选">
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

          <p v-if="cards.length === 0" class="empty">
            {{
              state.data.value.stats.total === 0
                ? '表情库还是空的。它会在这些时候自动积累：你手动导入图片、机器人联网抓取表情、或者别人在群里发了新表情（学来的，默认不主动转发）。'
                : '没有匹配的表情。'
            }}
          </p>

          <ul v-else class="cards">
            <li v-for="card in cards" :key="card.id">
              <div class="thumb">
                <img v-if="card.previewable" :src="imageUrl(card.id)" :alt="card.description ?? card.sha256.slice(0, 8)" loading="lazy" />
                <span v-else class="no-preview">不可预览<br /><small>{{ card.mime }}</small></span>
              </div>
              <div class="meta">
                <div class="badges">
                  <StatusBadge :tone="card.ours ? 'ok' : 'warn'" dot>{{ card.ours ? '我们的' : '学来的' }}</StatusBadge>
                  <StatusBadge tone="muted">{{ sourceLabel(card.source) }}</StatusBadge>
                  <StatusBadge v-if="card.description === undefined" tone="err">无描述</StatusBadge>
                </div>
                <p class="desc">{{ card.description ?? '（还没有描述）' }}</p>
                <p v-if="card.emotionTags.length > 0" class="tags">
                  <span v-for="tag in card.emotionTags" :key="tag">{{ tag }}</span>
                </p>
                <p class="facts">
                  用过 {{ formatNumber(card.useCount) }} 次 ·
                  {{ card.lastUsedAt ? formatRelative(card.lastUsedAt) : '从未使用' }} ·
                  {{ formatBytes(card.sizeBytes) }}
                </p>
                <p v-if="card.scopes.length > 0" class="facts mono">见过：{{ card.scopes.join('、') }}</p>
                <p class="facts mono">{{ card.sha256.slice(0, 16) }}…</p>
              </div>
            </li>
          </ul>

          <template #footer>
            <p class="muted note">{{ state.data.value.notes.vision }}</p>
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
  min-width: 150px;
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
.segmented button[data-active='true'] {
  background: var(--c-surface);
  color: var(--c-text);
  box-shadow: var(--sh-1);
}

.empty {
  padding: var(--s-6) 0;
  text-align: center;
  color: var(--c-text-3);
  font-size: var(--t-sm);
  line-height: 1.8;
}

.cards {
  display: grid;
  gap: var(--s-3);
  grid-template-columns: repeat(auto-fill, minmax(230px, 1fr));
  list-style: none;
}
.cards > li {
  display: flex;
  flex-direction: column;
  gap: var(--s-2);
  padding: var(--s-3);
  border: 1px solid var(--c-border);
  border-radius: var(--r-md);
  background: var(--c-surface);
}

.thumb {
  display: grid;
  place-items: center;
  height: 120px;
  overflow: hidden;
  background: var(--c-surface-2);
  border-radius: var(--r-sm);
}
.thumb img {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
}
.no-preview {
  color: var(--c-text-3);
  font-size: var(--t-xs);
  text-align: center;
}

.meta {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.badges {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.desc {
  color: var(--c-text);
  font-size: var(--t-sm);
  line-height: 1.6;
}
.tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.tags span {
  padding: 0 6px;
  border-radius: var(--r-full);
  background: var(--c-surface-2);
  color: var(--c-text-2);
  font-size: var(--t-xs);
}
.facts {
  color: var(--c-text-3);
  font-size: var(--t-xs);
  overflow-wrap: anywhere;
}
.note {
  font-size: var(--t-xs);
  line-height: 1.7;
}
</style>
