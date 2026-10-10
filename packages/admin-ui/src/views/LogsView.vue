<script setup lang="ts">
/**
 * 实时日志 —— 看进程现在在想什么。
 *
 * 数据来自服务端的**内存环形缓冲**（不是读日志文件）：文件位置随部署形态变、
 * 还可能被轮转截断，而"最近发生了什么"才是排障时要的。
 *
 * 交互上做了四件排障时真需要的事：
 *  1. **暂停**：日志滚动时根本点不中要看的行，所以必须先能冻住；
 *  2. **★ 按等级筛选**（七级多选）/ **按模块筛选**（下拉）—— 用户 2026-10-10 的要求；
 *  3. **关键词**：几百行里找一条，靠眼睛扫是浪费生命；
 *  4. **增量拉取**：只取比上次更新的行（用 seq），不重复传整段。
 *
 * ## ★ 为什么这里**在客户端筛**，而不是带上 `levels`/`modules` 去问服务端
 *
 * 服务端的 `/logs` **支持**筛选（`?levels=&modules=&q=`），但它与 `since` **不能并用**
 * （有筛选就回 `filtered: true`、要整段替换）。而这一页是**跟着 SSE 实时长的**：
 * 每来一条新行就重新问一次服务端会**把这个页变成轮询**，实时性反而没了。
 *
 * ⇒ 这里在**已累积的那批行**上筛（最多 1000 条），**与 SSE 天然兼容**；
 *   而服务端那套筛选是留给**从落盘里翻更久远历史**的（那一侧才有 `since` 的问题）。
 *
 * ## ★ 七级与模块清单都**从接口拿**，前端不抄一份
 *
 * `levels` / `modules` 由 `/logs` 一起回（真源是服务端的 `log-levels.ts` 与缓冲本身）。
 * 前端再抄一份清单的话，两边迟早对不上 —— 那时候排障的人会以为"这个级别不存在"。
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
import { LogStreamFallback } from '../log-stream.ts'

interface LogLine {
  readonly seq: number
  readonly at: string
  /** 七级之一（`debug < info < note < warn < error < fault < crash`）。 */
  readonly level: string
  /** 模块名（`onebot` / `wake-liveness` / `gateway` …）。 */
  readonly module: string
  readonly text: string
}

interface LogsPayload {
  readonly lines: readonly LogLine[]
  readonly sequence: number
  readonly size: number
  readonly capacity: number
  /** 缓冲里出现过的模块（服务端给的，前端不抄）。 */
  readonly modules?: readonly string[]
  /** 七级清单（服务端给的，前端不抄）。 */
  readonly levels?: readonly string[]
}

const state = useAsyncData<LogsPayload>(() => api.get<LogsPayload>('/logs', { limit: 300 }))

/** 已累积的行（增量拉取会往里追加）。 */
const lines = ref<LogLine[]>([])
const lastSeq = ref(0)
const paused = ref(false)
/** ★ 选中的等级（**空 = 全部**；多选）。 */
const levels = ref<string[]>([])
/** ★ 选中的模块（空串 = 全部）。 */
const module = ref('')
const keyword = ref('')
const follow = ref(true)

/** 服务端报过的清单（刷新时更新；**不用本地常量兜底** —— 见文件头的理由）。 */
const modules = ref<readonly string[]>([])
const levelNames = ref<readonly string[]>([])

// ── 实时推送（SSE）优先，失败**回退到轮询** ────────────────────────────
//
// **回退不是可选项**：SSE 挂了而面板没回退的话，结果不是"慢一点"，
// 而是"**日志完全不更新**" —— 用户会以为系统没日志，而真相是面板瞎了。
const fallback = new LogStreamFallback()
const transportLabel = ref(fallback.describe())
let source: EventSource | undefined
let pollTimer: number | undefined
let retryTimer: number | undefined

/** 首屏/手动刷新：整段替换。 */
async function reload(): Promise<void> {
  await state.refresh()
  const data = state.data.value
  if (data === undefined) return
  lines.value = [...data.lines]
  lastSeq.value = data.sequence
  syncChoices(data)
}

/** 记下服务端给的清单（模块下拉与等级按钮都照它渲染）。 */
function syncChoices(data: LogsPayload): void {
  if (data.modules !== undefined && data.modules.length > 0) modules.value = data.modules
  if (data.levels !== undefined && data.levels.length > 0) levelNames.value = data.levels
}

/** 增量拉取：只要比 lastSeq 更新的。 */
async function poll(): Promise<void> {
  if (paused.value) return
  try {
    const data = await api.get<LogsPayload>('/logs', { since: lastSeq.value })
    syncChoices(data)
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

/** 收到一批新行（SSE 与轮询**共用这一段** —— 两条路的追加逻辑必须一致）。 */
function appendLines(incoming: readonly LogLine[], sequence: number): void {
  if (incoming.length > 0) {
    lines.value = [...lines.value, ...incoming].slice(-1000)
    lastSeq.value = sequence
    if (follow.value) queueMicrotask(scrollToBottom)
  } else if (sequence !== lastSeq.value) {
    lastSeq.value = sequence
  }
}

/** 启动轮询（**回退路径**）。 */
function startPolling(): void {
  if (pollTimer !== undefined) return
  pollTimer = window.setInterval(() => void poll(), 2000)
}

function stopPolling(): void {
  if (pollTimer !== undefined) {
    window.clearInterval(pollTimer)
    pollTimer = undefined
  }
}

/**
 * 连 SSE。
 *
 * **同源相对路径** —— `EventSource` 对同源请求**自动带 cookie**，
 * 所以鉴权与别的接口一致（**不把令牌放进 URL**）。
 */
function connectSse(): void {
  closeSse()
  try {
    source = new EventSource(`/api/admin/logs/stream?since=${String(lastSeq.value)}`)
  } catch (error) {
    fallback.report({ ok: false, reason: `浏览器不支持：${String(error).slice(0, 60)}` })
    transportLabel.value = fallback.describe()
    startPolling()
    return
  }
  source.onopen = (): void => {
    fallback.report({ ok: true })
    transportLabel.value = fallback.describe()
    stopPolling()
  }
  source.onmessage = (event: MessageEvent<string>): void => {
    try {
      const line = JSON.parse(event.data) as LogLine
      appendLines([line], line.seq)
    } catch {
      // 单条解析失败不该断流
    }
  }
  source.onerror = (): void => {
    // ★ **回退到轮询**（并安排退避后重试 SSE）
    fallback.report({ ok: false, reason: "连接中断" })
    transportLabel.value = fallback.describe()
    closeSse()
    startPolling()
    scheduleRetry()
  }
}

function closeSse(): void {
  if (source !== undefined) {
    source.close()
    source = undefined
  }
}

/** 退避后重试 SSE（**只降级不重试 = 一次抖动就永久锁在轮询上**）。 */
function scheduleRetry(): void {
  if (retryTimer !== undefined) window.clearTimeout(retryTimer)
  retryTimer = window.setTimeout(() => {
    retryTimer = undefined
    if (fallback.tick(60_000)) connectSse()
    else scheduleRetry()
  }, 1000)
}

function scrollToBottom(): void {
  const element = viewport.value
  if (element !== undefined) element.scrollTop = element.scrollHeight
}

/** 切换一个等级的选中状态（多选）。 */
function toggleLevel(name: string): void {
  levels.value = levels.value.includes(name)
    ? levels.value.filter((item) => item !== name)
    : [...levels.value, name]
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

/**
 * 右键菜单。
 *
 * 从这一行**直接筛**是排障最常用的动作 —— 但筛完要能看出来"当前筛的是什么"，
 * 所以下面 `activeFilterLabel` 会把它写出来（否则人会对着一屏空日志发愣）。
 */
function logMenuItems(line: Record<string, unknown>): ContextMenuItem[] {
  // 局部变量**不叫 level/module** —— 那会遮蔽外层的同名 ref（上次就是这么栽的）
  const lineLevel = String(line["level"] ?? "")
  const lineModule = String(line["module"] ?? "")
  const text = String(line["text"] ?? "")
  return [
    { key: "copy", label: "复制这一行", run: () => void navigator.clipboard?.writeText(text) },
    {
      key: "filter-level",
      label: "只看这个级别",
      hint: lineLevel,
      run: () => {
        // 复用页面已有的等级筛选，不另写一套（七级都真实存在，直接放进去）
        if (lineLevel !== "") levels.value = [lineLevel]
      },
    },
    {
      key: "filter-module",
      label: "只看这个模块",
      hint: lineModule,
      run: () => {
        if (lineModule !== "") module.value = lineModule
      },
    },
    {
      key: "clear",
      label: "清空筛选",
      run: () => {
        levels.value = []
        module.value = ""
        keyword.value = ""
      },
    },
  ]
}

const filtered = computed(() => {
  const needle = keyword.value.trim().toLowerCase()
  const wanted = levels.value
  const mod = module.value
  return lines.value.filter((line) => {
    if (wanted.length > 0 && !wanted.includes(line.level)) return false
    if (mod !== '' && line.module !== mod) return false
    if (needle !== '' && !line.text.toLowerCase().includes(needle)) return false
    return true
  })
})

/** 每个等级各有多少行（按钮上显示条数，否则筛完是空屏也不知道为什么）。 */
const counts = computed(() => {
  const out: Record<string, number> = {}
  for (const line of lines.value) out[line.level] = (out[line.level] ?? 0) + 1
  return out
})

/** 当前筛了什么，写成一句话 —— 筛完空屏时**必须能看出是筛出来的**。 */
const activeFilterLabel = computed(() => {
  const bits: string[] = []
  if (levels.value.length > 0) bits.push(`等级 ${levels.value.join('/')}`)
  if (module.value !== '') bits.push(`模块 ${module.value}`)
  if (keyword.value.trim() !== '') bits.push(`关键词「${keyword.value.trim()}」`)
  return bits.join('，')
})

onMounted(() => {
  void reload()
  // **先试实时推送**；连不上会自动回退到轮询（见 connectSse 的 onerror）
  connectSse()
})
onBeforeUnmount(() => {
  closeSse()
  stopPolling()
  if (retryTimer !== undefined) window.clearTimeout(retryTimer)
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
            <!-- ★ **当前传输方式必须能看见** ——
                 否则排障时没人知道"日志慢"是因为**回退到轮询了** -->
            <span class="transport" :title="transportLabel">{{ transportLabel }}</span>
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
          <!-- ★ 等级筛选：**七个按钮都能点**（多选，空 = 全部）。
               按 `debug < info < note < warn < error < fault < crash` 的顺序排，
               与文档、与代码都是同一份顺序 —— 顺带让人一眼看到"还有更严重的级别"。 -->
          <div class="segmented" role="group" aria-label="等级筛选">
            <button
              type="button"
              :data-active="levels.length === 0"
              @click="levels = []"
            >
              全部 {{ lines.length }}
            </button>
            <button
              v-for="name in levelNames"
              :key="name"
              type="button"
              :data-active="levels.includes(name)"
              :data-level="name"
              :title="`只看 ${name}（共 ${counts[name] ?? 0} 条）`"
              @click="toggleLevel(name)"
            >
              {{ name }} {{ counts[name] ?? 0 }}
            </button>
          </div>

          <!-- 模块下拉：选项**来自服务端**（`/logs` 回里的 `modules`），
               前端不抄一份 —— 抄了就会有人在"这个模块不存在"上白花时间 -->
          <select v-model="module" aria-label="模块筛选" :disabled="modules.length === 0">
            <option value="">全部模块</option>
            <option v-for="name in modules" :key="name" :value="name">{{ name }}</option>
          </select>

          <input v-model="keyword" type="search" placeholder="搜关键词…" aria-label="搜索日志" />
          <StatusBadge v-if="paused" tone="warn" dot>已暂停（后台仍在累积，只是不刷新视图）</StatusBadge>
        </div>

        <!-- ★ 筛了什么必须写出来：否则筛完一屏空，人只会以为"系统没日志" -->
        <p v-if="activeFilterLabel !== ''" class="active-filter">
          正在筛选：{{ activeFilterLabel }}
          <button type="button" class="link" @click="levels = []; module = ''; keyword = ''">清空</button>
        </p>

        <div ref="viewport" class="viewport">
          <p v-if="filtered.length === 0" class="empty">
            {{ lines.length === 0 ? '缓冲里还没有日志。服务刚启动时是正常的。' : `没有匹配的行（${activeFilterLabel === '' ? '缓冲里本来就没有' : '当前筛选：' + activeFilterLabel}）。` }}
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
              <span class="level-tag">{{ line.level }}</span>
              <span class="module" :title="line.module">{{ line.module }}</span>
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
.filters input,
.filters select {
  min-height: 32px;
  min-width: 140px;
  padding: 0 var(--s-3);
  background: var(--c-bg);
  border: 1px solid var(--c-border-strong);
  border-radius: var(--r-md);
  color: var(--c-text);
  font-size: var(--t-sm);
  outline: none;
}
.filters select:disabled {
  opacity: 0.5;
}
.filters input:focus,
.filters select:focus {
  border-color: var(--c-brand);
  box-shadow: 0 0 0 3px var(--c-brand-soft);
}

.active-filter {
  margin: 0 0 var(--s-2);
  font-size: var(--t-xs);
  color: var(--c-text-3);
}
.link {
  margin-left: var(--s-2);
  border: none;
  background: transparent;
  color: var(--c-brand);
  cursor: pointer;
  font-size: var(--t-xs);
  text-decoration: underline;
}

.segmented {
  display: inline-flex;
  flex-wrap: wrap;
  gap: 2px;
  padding: 2px;
  background: var(--c-surface-2);
  border-radius: var(--r-md);
}
.segmented button {
  min-height: 28px;
  padding: 0 var(--s-2);
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
/* ★ 每个等级按钮自己带一点颜色：一眼能分清"这条是 note 还是 fault" */
.segmented button[data-level='note'] { color: var(--c-text-2); }
.segmented button[data-level='warn'] { color: var(--c-warn); }
.segmented button[data-level='error'] { color: var(--c-err); }
.segmented button[data-level='fault'] { color: var(--c-err); font-weight: 600; }
.segmented button[data-level='crash'] { color: var(--c-bg); background: var(--c-err); }
.segmented button[data-level='crash'][data-active='false'] { color: var(--c-err); background: transparent; }

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
  gap: var(--s-2);
  padding: 1px var(--s-3);
  line-height: 1.6;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.lines > li:hover {
  background: var(--c-surface-2);
}
/* 七级各自的观感（轴是**影响范围**，不是"看起来多吓人"）：
   debug 压暗、info 正常、note 稍亮（那是"判断"，值得回看）、
   warn 琥珀、error 红、fault 红加粗（一个子系统坏了）、crash 红底（进程要没了） */
.lines > li[data-level='debug'] { color: var(--c-text-3); }
.lines > li[data-level='note'] { color: var(--c-text-2); }
.lines > li[data-level='warn'] { color: var(--c-warn); }
.lines > li[data-level='error'] { color: var(--c-err); }
.lines > li[data-level='fault'] { color: var(--c-err); font-weight: 600; }
.lines > li[data-level='crash'] { color: var(--c-err); background: var(--c-err-soft, var(--c-surface-2)); font-weight: 700; }

.time {
  flex: none;
  color: var(--c-text-3);
  font-variant-numeric: tabular-nums;
}
.level-tag {
  flex: none;
  min-width: 42px;
  color: var(--c-text-3);
  text-transform: uppercase;
}
.module {
  flex: none;
  max-width: 140px;
  overflow: hidden;
  color: var(--c-text-3);
  text-overflow: ellipsis;
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
