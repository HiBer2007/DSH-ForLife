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
import { useContextMenu, type ContextMenuItem } from '../composables/useContextMenu.ts'
import { computed, ref, reactive } from 'vue'

import { api } from '../api/client.ts'
import type { MemoryEntryRow, MemoryOverview } from '../api/types.ts'
import AsyncSection from '../components/AsyncSection.vue'
import ContextMenu from '../components/ContextMenu.vue'
import DataTable, { type TableColumn } from '../components/DataTable.vue'
import PanelCard from '../components/PanelCard.vue'
import StatCard from '../components/StatCard.vue'
import StatusBadge from '../components/StatusBadge.vue'
import { useAsyncData } from '../composables/useAsyncData.ts'
import { formatNumber, formatRelative, formatTokens } from '../utils/format.ts'

/**
 * 记忆编辑。
 *
 * 菜单动作与页面按钮调用**同一批函数**（openEdit / toggleArchive）。
 * 归档用**一个接口两个方向**（archive / restore），因为它们是同一个动作的两面 ——
 * 分成两个接口会让前端要先判断该调哪个。
 */
const { state: menuState, onContextMenu, touchHandlers, close: closeMenu, clampToViewport } = useContextMenu()

const editing = ref<Record<string, unknown> | null>(null)
const saving = ref(false)
const saveError = ref('')
const form = reactive({ summary: '', content: '', entities: '' })

function openEdit(row: Record<string, unknown>): void {
  editing.value = row
  saveError.value = ''
  form.summary = String(row['summary'] ?? '')
  form.content = String(row['content'] ?? row['summary'] ?? '')
  form.entities = Array.isArray(row['entities']) ? (row['entities'] as string[]).join(', ') : ''
}

async function postMemory(path: string, body: Record<string, unknown>): Promise<void> {
  saving.value = true
  saveError.value = ''
  try {
    await api.post(path, body)
    editing.value = null
    state.refresh()
  } catch (error) {
    // **必须显示错误**：静默失败会让人以为保存成功了
    saveError.value = error instanceof Error ? error.message : String(error)
  } finally {
    saving.value = false
  }
}

async function save(): Promise<void> {
  if (editing.value === null) return
  await postMemory('/memory-entry', {
    id: editing.value['id'],
    summary: form.summary,
    content: form.content,
    entities: form.entities.split(/[,，、]+/).map((e) => e.trim()).filter((e) => e !== ''),
  })
}

async function toggleArchive(row: Record<string, unknown>): Promise<void> {
  await postMemory('/memory-archive', { id: row['id'], restore: row['status'] === 'archived' })
}

function statusLabel(status: unknown): string {
  if (status === 'active') return '活跃'
  if (status === 'fragmented') return '碎片'
  if (status === 'archived') return '归档'
  return String(status)
}

function statusTone(status: unknown): 'ok' | 'warn' | 'muted' {
  if (status === 'active') return 'ok'
  if (status === 'fragmented') return 'warn'
  return 'muted'
}

function memoryMenuItems(row: Record<string, unknown>): ContextMenuItem[] {
  const archived = row['status'] === 'archived'
  return [
    { key: 'edit', label: '编辑…', hint: statusLabel(row['status']), run: () => openEdit(row) },
    {
      key: 'archive',
      label: archived ? '恢复' : '归档',
      hint: archived ? '归档中' : '不是真删，可恢复',
      danger: !archived,
      run: () => toggleArchive(row),
    },
    { key: 'copy', label: '复制 id', run: () => void navigator.clipboard?.writeText(String(row['id'])) },
  ]
}

/**
 * 模板要按下标取字段（row['status']），而 `MemoryEntryRow` 是**具名接口、没有索引签名** ——
 * 直接把 rows 交给模板会报 "Index signature for type 'string' is missing"。
 * 所以在这里做一次显式转换，把"任意键取值"这件事限制在这一行里，
 * 而不是去给接口加索引签名（那等于放弃类型检查）。
 */
const memRows = computed<Record<string, unknown>[]>(() => rows.value as unknown as Record<string, unknown>[])

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

          <p v-if="memRows.length === 0" class="mem-empty">
            还没有记忆条目。QQ 会话跑起来之后，对话摘要会写进这里；
            也可以用 DSH 会话里的插件面板手动触发一次压缩。
          </p>

          <ul v-else class="mem-list">
            <li
              v-for="row in memRows"
              :key="String(row['id'])"
              class="mem-row"
              :data-status="String(row['status'])"
              @contextmenu="onContextMenu($event, memoryMenuItems(row), row)"
              v-on="touchHandlers(memoryMenuItems(row), row)"
            >
              <div class="mem-head">
                <StatusBadge :tone="statusTone(row['status'])" dot>{{ statusLabel(row['status']) }}</StatusBadge>
                <span class="mono mem-id">{{ String(row['id']).slice(0, 14) }}…</span>
                <span class="mem-time">{{ formatRelative(String(row['createdAt'] ?? '')) }}</span>
              </div>
              <p class="mem-summary">{{ row['summary'] }}</p>
              <div class="mem-actions">
                <button type="button" class="mini" @click="openEdit(row)">编辑</button>
                <button
                  type="button"
                  class="mini"
                  :class="{ danger: row['status'] !== 'archived' }"
                  @click="toggleArchive(row)"
                >
                  {{ row['status'] === 'archived' ? '恢复' : '归档' }}
                </button>
              </div>
            </li>
          </ul>

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

    <div v-if="editing !== null" class="edit-mask" @click.self="editing = null">
      <div class="edit-box" role="dialog" aria-modal="true" aria-label="编辑记忆">
        <h3 class="edit-title">编辑记忆</h3>
        <p class="mono edit-subject">{{ editing.id }}</p>

        <label class="edit-label" for="mem-sum">摘要</label>
        <textarea id="mem-sum" v-model="form.summary" class="editor" rows="2" />

        <label class="edit-label" for="mem-body">正文</label>
        <textarea id="mem-body" v-model="form.content" class="editor" rows="6" />

        <label class="edit-label" for="mem-ent">实体（逗号分隔）</label>
        <input id="mem-ent" v-model="form.entities" class="edit-input" placeholder="人名, 项目名, 地点" />

        <p v-if="saveError !== ''" class="edit-error">{{ saveError }}</p>
        <p class="edit-hint muted">
          摘要**不能为空**：列表与提示词注入用的都是摘要，空摘要会让这条记忆在界面上显示成
          一片空白，而正文其实很长。归档也**不是真删** —— 记忆是不可再生数据，
          而且真删会让它引用过的中期条目断链。归档后检索不再命中，但能恢复。
        </p>

        <div class="edit-actions">
          <button type="button" class="mini" @click="editing = null">取消</button>
          <button type="button" class="mini primary" :disabled="saving" @click="save()">
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

.mem-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  list-style: none;
}
.mem-row {
  padding: var(--s-3);
  border-radius: var(--r-sm);
  cursor: context-menu;
}
.mem-row:hover {
  background: var(--c-surface-2);
}
.mem-row[data-status='archived'] .mem-summary {
  color: var(--c-text-3);
}
.mem-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--s-2);
}
.mem-id {
  color: var(--c-text-3);
  font-size: var(--t-xs);
}
.mem-time {
  margin-left: auto;
  color: var(--c-text-3);
  font-size: var(--t-xs);
}
.mem-summary {
  margin-top: 4px;
  color: var(--c-text);
  font-size: var(--t-sm);
  line-height: 1.7;
}
.mem-actions {
  display: flex;
  gap: 4px;
  margin-top: var(--s-2);
}
.mem-empty {
  padding: var(--s-5) 0;
  color: var(--c-text-3);
  font-size: var(--t-sm);
  line-height: 1.8;
  text-align: center;
}
.mini {
  min-height: 28px;
  padding: 0 var(--s-2);
  border: 1px solid var(--c-border-strong);
  border-radius: var(--r-sm);
  background: transparent;
  color: var(--c-text-2);
  font-size: var(--t-xs);
  cursor: pointer;
}
.mini:hover:not(:disabled) {
  border-color: var(--c-brand);
  color: var(--c-brand);
}
.mini.danger:hover:not(:disabled) {
  border-color: var(--c-err, #d9534f);
  color: var(--c-err, #d9534f);
}
.mini.primary {
  border-color: transparent;
  background: var(--c-brand);
  color: #fff;
}
.mini:disabled {
  opacity: 0.6;
  cursor: default;
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
  width: min(560px, 100%);
  max-height: 88vh;
  overflow: auto;
  padding: var(--s-5);
  background: var(--c-surface);
  border: 1px solid var(--c-border-strong);
  border-radius: var(--r-lg);
}
.edit-title {
  font-size: var(--t-md);
}
.edit-subject {
  margin-top: 4px;
  color: var(--c-text-3);
  font-size: var(--t-xs);
}
.edit-label {
  display: block;
  margin-top: var(--s-3);
  margin-bottom: 4px;
  color: var(--c-text-2);
  font-size: var(--t-xs);
}
.editor,
.edit-input {
  width: 100%;
  padding: var(--s-2) var(--s-3);
  background: var(--c-bg);
  border: 1px solid var(--c-border-strong);
  border-radius: var(--r-md);
  color: var(--c-text);
  font-family: inherit;
  font-size: var(--t-sm);
}
.editor {
  line-height: 1.7;
  resize: vertical;
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
</style>
