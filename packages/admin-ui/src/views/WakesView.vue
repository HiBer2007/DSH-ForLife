<script setup lang="ts">
/**
 * 触发器页。写操作与右键菜单**调用同一批函数**，避免两处行为分叉。
 */
import { computed, ref } from 'vue'

import { api } from '../api/client.ts'
import type { WakesOverview } from '../api/types-wakes.ts'
import AsyncSection from '../components/AsyncSection.vue'
import ContextMenu from '../components/ContextMenu.vue'
import PanelCard from '../components/PanelCard.vue'
import StatCard from '../components/StatCard.vue'
import StatusBadge from '../components/StatusBadge.vue'
import { useAsyncData } from '../composables/useAsyncData.ts'
import { useContextMenu, type ContextMenuItem } from '../composables/useContextMenu.ts'
import { formatNumber, formatRelative } from '../utils/format.ts'

const state = useAsyncData<WakesOverview>(() => api.get<WakesOverview>('/wakes'))
const { state: menuState, onContextMenu, touchHandlers, close: closeMenu, clampToViewport } = useContextMenu()

const actionError = ref('')
const busy = ref(false)

const paused = computed(() => state.data.value?.paused === true)

const stats = computed(() => [
  { label: '触发器', value: String(state.data.value?.stats.triggers ?? 0), hint: `其中 ${String(state.data.value?.stats.enabled ?? 0)} 条启用` },
  { label: '累计唤醒', value: formatNumber(state.data.value?.stats.firedTotal ?? 0), hint: '含被拦下的（历史里能看到原因）' },
  { label: '累计花费', value: formatNumber(state.data.value?.stats.spentTokens ?? 0), hint: 'tokens（按触发器汇总）' },
])

const triggers = computed<Record<string, unknown>[]>(
  () => (state.data.value?.triggers ?? []) as unknown as Record<string, unknown>[],
)
const events = computed(() => state.data.value?.events ?? [])
const programs = computed(() => state.data.value?.programs ?? [])

/** 统一的写操作包装：**失败必须显示**，不静默。 */
async function post(path: string, body: Record<string, unknown>): Promise<void> {
  busy.value = true
  actionError.value = ''
  try {
    await api.post(path, body)
    state.refresh()
  } catch (error) {
    actionError.value = error instanceof Error ? error.message : String(error)
  } finally {
    busy.value = false
  }
}

// ── 全局暂停（乐观更新：验收要求"立即生效"）────────────────────────
const pauseOptimistic = ref<boolean | null>(null)
const showPaused = computed(() => pauseOptimistic.value ?? paused.value)

async function togglePause(): Promise<void> {
  const next = !showPaused.value
  pauseOptimistic.value = next
  try {
    await api.post('/wake-pause', { paused: next })
    state.refresh()
  } catch (error) {
    // 失败要**回滚界面**并报错 —— 否则用户以为已经暂停了，而其实还在响
    actionError.value = error instanceof Error ? error.message : String(error)
  } finally {
    pauseOptimistic.value = null
  }
}

// ── 单条操作（按钮与菜单共用）──────────────────────────────────────
const toggleTrigger = (row: Record<string, unknown>): Promise<void> =>
  post('/wake-toggle', { id: row['id'], enabled: row['enabled'] !== true })
const fireNow = (row: Record<string, unknown>): Promise<void> => post('/wake-now', { id: row['id'] })
const cancelTrigger = async (row: Record<string, unknown>): Promise<void> => {
  if (!window.confirm(`取消「${String(row['title'])}」？\n\n取消后就真的不会再醒了。`)) return
  await post('/wake-cancel', { id: row['id'] })
}

function triggerMenuItems(row: Record<string, unknown>): ContextMenuItem[] {
  const enabled = row['enabled'] === true
  return [
    { key: 'now', label: '立刻执行', hint: '不改周期', run: () => fireNow(row) },
    { key: 'toggle', label: enabled ? '停用' : '启用', run: () => toggleTrigger(row) },
    { key: 'copy', label: '复制 id', run: () => void navigator.clipboard?.writeText(String(row['id'])) },
    { key: 'cancel', label: '取消（删除）', danger: true, run: () => cancelTrigger(row) },
  ]
}

/** 决策 → 徽章色调。**被拦下的也要有颜色**，否则一眼看不出"它没醒"。 */
function decisionTone(decision: string): 'ok' | 'warn' | 'muted' {
  if (decision === 'fired') return 'ok'
  if (decision === 'failed') return 'warn'
  return 'muted'
}

function healthTone(health: unknown): 'ok' | 'warn' | 'muted' {
  if (health === 'ok') return 'ok'
  if (health === 'failing') return 'warn'
  return 'muted'
}
</script>

<template>
  <div class="page">
    <header class="head">
      <h1>触发器</h1>
      <p class="muted">
        模型给自己安排的唤醒（定时 / 监视 / 系统事件）。每次"要不要醒、醒了干什么、花了多少"
        都会记在下面。
      </p>
    </header>

    <AsyncSection
      :loading="state.loading.value"
      :error="state.error.value"
      :updated-at="state.updatedAt.value"
      :skeleton-rows="5"
      @retry="state.refresh()"
    >
      <template #default>
        <!-- 全局暂停：**放最上面、最显眼** —— 出事时用户要能找到它 -->
        <div class="pause-bar" :data-paused="showPaused">
          <div class="pause-text">
            <StatusBadge :tone="showPaused ? 'warn' : 'ok'" dot>
              {{ showPaused ? '已暂停' : '运行中' }}
            </StatusBadge>
            <span class="muted cap">
              {{ showPaused
                ? '所有唤醒都不会发生（触发器仍然被记录，但不叫醒模型）。'
                : '唤醒按各自的规则触发。' }}
            </span>
          </div>
          <button type="button" class="btn" :class="showPaused ? 'primary' : 'danger'" :disabled="busy" @click="togglePause">
            {{ showPaused ? '恢复唤醒' : '全部暂停' }}
          </button>
        </div>

        <p v-if="actionError !== ''" class="action-error">{{ actionError }}</p>

        <div class="grid">
          <StatCard v-for="item in stats" :key="item.label" v-bind="item" />
        </div>

        <PanelCard title="触发器" :subtitle="`${triggers.length} 条`">
          <p v-if="triggers.length === 0" class="empty-note">
            还没有任何触发器。模型可以用 <span class="mono">schedule_wake</span> 安排一次未来的唤醒，
            或用 <span class="mono">register_watcher</span> 盯一个条件。
          </p>

          <ul v-else class="trig-list">
            <li
              v-for="row in triggers"
              :key="String(row['id'])"
              class="trig-row"
              :data-enabled="row['enabled'] === true"
              @contextmenu="onContextMenu($event, triggerMenuItems(row), row)"
              v-on="touchHandlers(triggerMenuItems(row), row)"
            >
              <div class="trig-head">
                <StatusBadge :tone="healthTone(row['health'])" dot>{{ row['health'] }}</StatusBadge>
                <span class="trig-title">{{ row['title'] }}</span>
                <span class="mono trig-kind">{{ row['kind'] }}</span>
                <span class="trig-time">{{ formatRelative(String(row['lastFiredAt'] ?? row['createdAt'] ?? '')) }}</span>
              </div>
              <p class="muted cap">{{ row['healthNote'] }}</p>
              <p class="muted cap">
                下次 <span class="mono">{{ row['nextFireAt'] ?? '—' }}</span> ·
                已醒 {{ formatNumber(Number(row['fireCount'] ?? 0)) }} 次 ·
                花费 {{ formatNumber(Number(row['spentTokens'] ?? 0)) }} tokens
                <template v-if="Number(row['dailyLimit'] ?? 0) > 0"> · 日限 {{ row['dailyLimit'] }}</template>
                <template v-if="row['scope'] !== '*'"> · 会话 <span class="mono">{{ row['scope'] }}</span></template>
              </p>
              <div class="trig-actions">
                <button type="button" class="mini" @click="fireNow(row)">立刻执行</button>
                <button type="button" class="mini" @click="toggleTrigger(row)">
                  {{ row['enabled'] === true ? '停用' : '启用' }}
                </button>
                <button type="button" class="mini danger" @click="cancelTrigger(row)">取消</button>
              </div>
            </li>
          </ul>
        </PanelCard>

        <PanelCard title="唤醒历史" :subtitle="`最近 ${events.length} 条 —— 含被拦下的（原因可区分）`">
          <p v-if="events.length === 0" class="empty-note">
            还没有唤醒记录。到点触发、或被拦下时都会出现在这里。
          </p>
          <ul v-else class="ev-list">
            <li v-for="e in events" :key="e.id" class="ev-row" :data-decision="e.decision">
              <div class="ev-head">
                <StatusBadge :tone="decisionTone(e.decision)" dot>{{ e.decision }}</StatusBadge>
                <span class="mono ev-kind">{{ e.kind }}</span>
                <span v-if="e.costTokens !== null" class="ev-cost">{{ formatNumber(e.costTokens) }} tokens</span>
                <span class="ev-time">{{ formatRelative(e.firedAt) }}</span>
              </div>
              <p v-if="e.reason !== null" class="muted cap">{{ e.reason }}</p>
              <p v-if="e.modelDid !== null" class="ev-did">模型做了：{{ e.modelDid }}</p>
            </li>
          </ul>
        </PanelCard>

        <PanelCard v-if="programs.length > 0" title="监视程序" :subtitle="`${programs.length} 个`">
          <ul class="prog-list">
            <li v-for="p in programs" :key="p.id" class="prog-row">
              <div class="prog-head">
                <StatusBadge :tone="p.status === 'running' ? 'ok' : p.status === 'failed' ? 'warn' : 'muted'" dot>
                  {{ p.status }}
                </StatusBadge>
                <span class="prog-name">{{ p.name }}</span>
                <span class="mono prog-contract">{{ p.contract }}</span>
              </div>
              <p class="muted cap">
                <span class="mono">{{ p.path }}</span> · 重启 {{ p.restartCount }} 次
                <template v-if="p.lastExitCode !== null"> · 上次退出码 {{ p.lastExitCode }}</template>
              </p>
              <p v-if="p.lastError !== null" class="prog-error">{{ p.lastError }}</p>
            </li>
          </ul>
        </PanelCard>
      </template>
    </AsyncSection>

    <ContextMenu :state="menuState" :on-close="closeMenu" :on-clamp="clampToViewport" />
  </div>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: var(--s-4);
  max-width: var(--w-content-max);
}
.head h1 {
  font-size: var(--t-lg);
}
.head p {
  margin-top: 4px;
  font-size: var(--t-sm);
  line-height: 1.7;
}
.pause-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--s-3);
  padding: var(--s-3) var(--s-4);
  background: var(--c-surface-2);
  border: 1px solid var(--c-border-strong);
  border-radius: var(--r-lg);
}
.pause-bar[data-paused='true'] {
  border-color: var(--c-warn, #d99a2b);
}
.pause-text {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--s-2);
}
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: var(--s-3);
}
.cap {
  font-size: var(--t-xs);
}
.empty-note {
  padding: var(--s-4) 0;
  color: var(--c-text-3);
  font-size: var(--t-sm);
  line-height: 1.8;
}
.action-error {
  padding: var(--s-2) var(--s-3);
  color: var(--c-err, #d9534f);
  background: var(--c-surface-2);
  border-radius: var(--r-sm);
  font-size: var(--t-sm);
}
.trig-list,
.ev-list,
.prog-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  list-style: none;
}
.trig-row,
.ev-row,
.prog-row {
  padding: var(--s-3);
  border-radius: var(--r-sm);
}
.trig-row {
  cursor: context-menu;
}
.trig-row:hover,
.ev-row:hover {
  background: var(--c-surface-2);
}
.trig-row[data-enabled='false'] .trig-title {
  color: var(--c-text-3);
}
.trig-head,
.ev-head,
.prog-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--s-2);
}
.trig-title,
.prog-name {
  font-size: var(--t-sm);
}
.trig-kind,
.prog-contract,
.ev-kind {
  color: var(--c-text-3);
  font-size: var(--t-xs);
}
.trig-time,
.ev-time {
  margin-left: auto;
  color: var(--c-text-3);
  font-size: var(--t-xs);
}
.ev-cost {
  color: var(--c-text-2);
  font-size: var(--t-xs);
}
.ev-did {
  margin-top: 4px;
  color: var(--c-text-2);
  font-size: var(--t-xs);
  line-height: 1.7;
}
.prog-error {
  margin-top: 4px;
  color: var(--c-err, #d9534f);
  font-size: var(--t-xs);
  overflow-wrap: anywhere;
}
.trig-actions {
  display: flex;
  gap: 4px;
  margin-top: var(--s-2);
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
.btn.danger {
  border-color: var(--c-err, #d9534f);
  color: var(--c-err, #d9534f);
}
.btn:disabled {
  opacity: 0.5;
  cursor: default;
}
.mini {
  min-height: 32px;
  padding: 0 var(--s-3);
  border: 1px solid var(--c-border-strong);
  border-radius: var(--r-sm);
  background: transparent;
  color: var(--c-text-2);
  font-size: var(--t-xs);
  cursor: pointer;
}
.mini:hover {
  border-color: var(--c-brand);
  color: var(--c-brand);
}
.mini.danger:hover {
  border-color: var(--c-err, #d9534f);
  color: var(--c-err, #d9534f);
}
</style>
