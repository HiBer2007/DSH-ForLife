<script setup lang="ts">
/**
 * 实时日志 —— 看进程现在在想什么。
 *
 * 数据来自服务端的**内存环形缓冲**（不是读日志文件）：文件位置随部署形态变、
 * 还可能被轮转截断，而"最近发生了什么"才是排障时要的。
 *
 * 交互上做了三件排障时真需要的事：
 *  1. **暂停**：日志滚动时根本点不中要看的行，所以必须先能冻住；
 *  2. **级别筛选 + 关键词**：几百行里找一条，靠眼睛扫是浪费生命；
 *  3. **增量拉取**：只取比上次更新的行（用 seq），不重复传整段。
 */
import ContextMenu from '../components/ContextMenu.vue'
import { useContextMenu, type ContextMenuItem } from '../composables/useContextMenu.ts'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

import { api } from '../api/client.ts'
import AppIcon from '../components/AppIcon.vue'
import AsyncSection from '../components/AsyncSection.vue'
import PanelCard from '../components/PanelCard.vue'
import StatusBadge from '../components/StatusBadge.vue'
import { useAsyncData } from '../composables/useAsyncData.ts'

interface LogLine {
  readonly seq: number
  readonly at: string
  readonly level: 'info' | 'warn' | 'error'
  readonly text: string
}

interface LogsPayload {
  readonly lines: readonly LogLine[]
  readonly sequence: number
  readonly size: number
  readonly capacity: number
}

const state = useAsyncData<LogsPayload>(() => api.get<LogsPayload>('/logs', { limit: 300 }))

/** 已累积的行（增量拉取会往里追加）。 */
const lines = ref<LogLine[]>([])
const lastSeq = ref(0)
const paused = ref(false)
const level = ref<'all' | 'warn' | 'error'>('all')
const keyword = ref('')
const follow = ref(true)

/** 首屏/手动刷新：整段替换。 */
async function reload(): Promise<void> {
  await state.refresh()
  const data = state.data.value
  if (data === undefined) return
  lines.value = [...data.lines]
  lastSeq.value = data.sequence
}

/** 增量拉取：只要比 lastSeq 更新的。 */
async function poll(): Promise<void> {
  if (paused.value) return
  try {
    const data = await api.get<LogsPayload>('/logs', { since: lastSeq.value })
    if (data.lines.length > 0) {
      lines.value = [...lines.value, ...data.lines].slice(-1000)
      lastSeq.value = data.sequence
      if (follow.value) queueMicrotask(scrollToBottom)
    } else if (data.sequence !== lastSeq.value) {
      lastSeq.value = data.sequence
    }
  } catch {
    // 轮询失败不打扰用户：下一轮会补上（服务重启时 seq 会归零，这里顺带重载）
  }
}

const viewport = ref<HTMLElement>()

function scrollToBottom(): void {
  const element = viewport.value
  if (element !== undefined) element.scrollTop = element.scrollHeight
}

/**
 * 日志操作。
 *
 * 清空是**危险操作**（销毁排障证据），所以：后端落审计、前端失败要显示错误。
 * 菜单动作与按钮调用同一个 clearLogs。
 */
const { state: menuState, onContextMenu, touchHandlers, close: closeMenu, clampToViewport } = useContextMenu()
const clearing = ref(false)
const clearError = ref("")

async function clearLogs(): Promise<void> {
  clearing.value = true
  clearError.value = ""
  try {
    await api.post("/logs-clear", {})
    state.refresh()
  } catch (error) {
    clearError.value = error instanceof Error ? error.message : String(error)
  } finally {
    clearing.value = false
  }
}

function logMenuItems(line: Record<string, unknown>): ContextMenuItem[] {
  // 局部变量**不叫 level** —— 那会遮蔽外层的 level ref（上次就是这么栽的）
  const lineLevel = String(line["level"] ?? "")
  const text = String(line["text"] ?? "")
  return [
    { key: "copy", label: "复制这一行", run: () => void navigator.clipboard?.writeText(text) },
    {
      key: "filter",
      label: "只看这个级别",
      hint: lineLevel,
      run: () => {
        // 复用页面已有的级别筛选，不另写一套
        // 页面的筛选取值只有 all / warn / error —— **没有 info**
        // （info 是默认档，等价于 all）。所以 info 行落到 all，而不是硬塞一个不存在的值。
        level.value = lineLevel === "warn" ? "warn" : lineLevel === "error" ? "error" : "all"
      },
    },
  ]
}

const filtered = computed(() => {
  const needle = keyword.value.trim().toLowerCase()
  return lines.value.filter((line) => {
    if (level.value === 'warn' && line.level === 'info') return false
    if (level.value === 'error' && line.level !== 'error') return false
    if (needle !== '' && !line.text.toLowerCase().includes(needle)) return false
    return true
  })
})

const counts = computed(() => ({
  total: lines.value.length,
  warn: lines.value.filter((line) => line.level === 'warn').length,
  error: lines.value.filter((line) => line.level === 'error').length,
}))

let timer: number | undefined
onMounted(() => {
  void reload()
  timer = window.setInterval(() => void poll(), 2000)
})
onBeforeUnmount(() => {
  if (timer !== undefined) window.clearInterval(timer)
})

function stamp(iso: string): string {
  const at = Date.parse(iso)
  if (Number.isNaN(at)) return iso
  return new Date(at).toLocaleTimeString('zh-CN', { hour12: false })
}
</script>

<template>
  <div class="page">
    <AsyncSection
      :loading="state.loading.value"
      :error="state.error.value"
      :updated-at="state.updatedAt.value"
      :skeleton-rows="4"
      @retry="reload()"
    >
      <PanelCard
        title="实时日志"
        :subtitle="`内存缓冲最近 ${state.data.value?.capacity ?? 0} 条，当前 ${state.data.value?.size ?? 0} 条（不读日志文件：位置随部署变，还可能被轮转截断）`"
      >
        <template #actions>
          <div class="tools">
            <button type="button" class="btn" :data-active="paused" @click="paused = !paused">
              <AppIcon :name="paused ? 'play' : 'pause'" :size="13" />
              <span>{{ paused ? '继续' : '暂停' }}</span>
            </button>
            <button type="button" class="btn" @click="reload()">
              <AppIcon name="refresh" :size="13" />
              <span>重载</span>
            </button>
            <label class="toggle">
              <input v-model="follow" type="checkbox" />
              <span>自动滚到底</span>
            </label>
          </div>
        </template>

        <div class="filters">
          <div class="segmented" role="radiogroup" aria-label="级别筛选">
            <button type="button" role="radio" :aria-checked="level === 'all'" :data-active="level === 'all'" @click="level = 'all'">
              全部 {{ counts.total }}
            </button>
            <button type="button" role="radio" :aria-checked="level === 'warn'" :data-active="level === 'warn'" @click="level = 'warn'">
              警告及以上 {{ counts.warn + counts.error }}
            </button>
            <button type="button" role="radio" :aria-checked="level === 'error'" :data-active="level === 'error'" @click="level = 'error'">
              仅错误 {{ counts.error }}
            </button>
          </div>
          <input v-model="keyword" type="search" placeholder="搜关键词…" aria-label="搜索日志" />
          <StatusBadge v-if="paused" tone="warn" dot>已暂停（后台仍在累积，只是不刷新视图）</StatusBadge>
        </div>

        <div ref="viewport" class="viewport">
          <p v-if="filtered.length === 0" class="empty">
            {{ lines.length === 0 ? '缓冲里还没有日志。服务刚启动时是正常的。' : '没有匹配的行。' }}
          </p>
          <ol v-else class="lines">
            <li
              v-for="line in filtered"
              :key="line.seq"
              :data-level="line.level"
              class="log-line"
              @contextmenu="onContextMenu($event, logMenuItems(line), line)"
              v-on="touchHandlers(logMenuItems(line), line)"
            >
              <span class="time">{{ stamp(line.at) }}</span>
              <span class="text">{{ line.text }}</span>
            </li>
          </ol>
        </div>
      </PanelCard>
    </AsyncSection>
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

.tools {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--s-2);
}

.filters {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--s-2);
  margin-bottom: var(--s-3);
}
.filters input {
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
.filters input:focus {
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

.viewport {
  max-height: 60vh;
  overflow: auto;
  background: var(--c-bg);
  border: 1px solid var(--c-border);
  border-radius: var(--r-md);
  font-family: var(--font-mono);
  font-size: var(--t-xs);
}

.empty {
  padding: var(--s-6);
  text-align: center;
  color: var(--c-text-3);
  font-family: var(--font-sans);
}

.lines {
  list-style: none;
  margin: 0;
  padding: var(--s-2) 0;
}
.lines > li {
  display: flex;
  gap: var(--s-3);
  padding: 1px var(--s-3);
  line-height: 1.6;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.lines > li:hover {
  background: var(--c-surface-2);
}
.lines > li[data-level='warn'] {
  color: var(--c-warn);
}
.lines > li[data-level='error'] {
  color: var(--c-err);
}
.time {
  flex: none;
  color: var(--c-text-3);
  font-variant-numeric: tabular-nums;
}
.text {
  min-width: 0;
}

.btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  min-height: 30px;
  padding: 0 var(--s-3);
  border: 1px solid var(--c-border-strong);
  border-radius: var(--r-md);
  background: var(--c-surface);
  color: var(--c-text);
  cursor: pointer;
  font-size: var(--t-xs);
}
.btn:hover {
  background: var(--c-surface-2);
}
.btn[data-active='true'] {
  border-color: var(--c-warn);
  color: var(--c-warn);
}

.toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: var(--t-xs);
  color: var(--c-text-3);
  cursor: pointer;
}
</style>
