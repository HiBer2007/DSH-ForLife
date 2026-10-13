<script setup lang="ts">
/**
 * 会话与队列 —— 「消息现在走到哪一步了」的观察面。
 *
 * 这一页信息量最大，所以**必须分区**，不能堆成一张大表：一条消息的生命周期是
 * 入站队列 → 轮次 → 出站队列（外加一个独立的待读池），四段各有各的"卡住了"的样子
 * （待处理堆积 / 轮次 running 不动 / 出站 failed / 待读没人看）。混在一张表里，
 * 排查时就得靠人脑做 join。
 *
 * 每块的分工：
 *  1. 顶部四张卡 —— 只看"要不要现在动手"；
 *  2. 会话 —— 有哪些对话、各自压了多少未读；
 *  3. 入站 / 轮次 / 出站 —— 一条消息的三段流水，按时间倒序；
 *  4. 待读池 —— 攒起来还没来得及看的消息。
 *
 * 数字口径写在每张卡的 hint 里：列表是**一页**（服务端单页 50/30 条），
 * 卡片上的计数是**全库**聚合。混着用会让人以为"待处理 30 条"却只看到 3 行。
 */
import { useContextMenu, type ContextMenuItem } from '../composables/useContextMenu.ts'
import { computed, ref } from 'vue'

import { api } from '../api/client.ts'
import type {
  ConversationSession,
  ConversationsOverview,
  InboxItem,
  OutboxItem,
  PendingItem,
  TurnItem,
} from '../api/types-qq.ts'
import AsyncSection from '../components/AsyncSection.vue'
import ConversationPanel from '../components/ConversationPanel.vue'
import ContextMenu from '../components/ContextMenu.vue'
import DataTable, { type TableColumn } from '../components/DataTable.vue'
import PanelCard from '../components/PanelCard.vue'
import StatCard from '../components/StatCard.vue'
import StatusBadge from '../components/StatusBadge.vue'
import { useAsyncData } from '../composables/useAsyncData.ts'
import { formatDuration, formatNumber, formatRelative, formatTokens } from '../utils/format.ts'
import { inboundPreview } from '../utils/message-labels.ts'

// 队列深度 / 待读 / 出站积压都是**会自己变的运行状态**：不轮询的话，
// 看到的是"打开这一页那一刻"的快照（用户会照着旧数字去排查一个已经不存在的问题）。
// 30 秒：这一页是观察面，不是操作面，比总览的 15 秒慢一拍就够。
const state = useAsyncData<ConversationsOverview>(() => api.get<ConversationsOverview>('/conversations'), {
  pollMs: 30_000,
})

const sessions = computed<readonly ConversationSession[]>(() => state.data.value?.sessions ?? [])
const queue = computed<readonly InboxItem[]>(() => state.data.value?.queue ?? [])
const turns = computed<readonly TurnItem[]>(() => state.data.value?.turns ?? [])
const outbox = computed<readonly OutboxItem[]>(() => state.data.value?.outbox ?? [])
const pending = computed<readonly PendingItem[]>(() => state.data.value?.pending ?? [])

const queueStats = computed(() => state.data.value?.queueStats)
const turnStats = computed(() => state.data.value?.turnStats)
const outboxStats = computed(() => state.data.value?.outboxStats)

// ── 取值小工具 ──────────────────────────────────────────────────────────────
//
// DataTable 的列定义拿到的是 `Record<string, unknown>`（行来自接口，前端不重写它），
// 所以这里把 unknown 收窄成具体类型再格式化：直接 `String(x)` 会把 undefined 渲染成
// 字面量 "undefined"，那是界面上最伤信任的一种细节。

/** `unknown` → string；不是字符串就当"没有值"（交给 format 系列给占位符）。 */
function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/** `unknown` → number；不是数字就当"没有值"（NaN 会被 format 系列渲染成 "NaN"）。 */
function num(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined
}

/**
 * 截断长文本（码元数）。
 *
 * 桌面上 DataTable 的单元格本来就有 CSS 省略号，但**手机端的卡片会把整段换行**：
 * 一条长消息能把一屏撑满。所以在数据侧先截断。
 * 截断点落在代理对中间会切出孤立代理、渲染成 `�`，所以末位是高位代理就少取一个码元
 * （与服务端 queries-memory.ts 的 truncate 同一条规矩）。
 */
function clip(value: string, max = 80): string {
  if (value.length <= max) return value
  const cut = value.slice(0, max)
  const last = cut.charCodeAt(max - 1)
  return `${last >= 0xd800 && last <= 0xdbff ? cut.slice(0, max - 1) : cut}…`
}

// ── 展示映射 ────────────────────────────────────────────────────────────────
//
// 一律"已知取值给中文，未知取值照原样显示"：编一个中文名比显示英文代号更误导，
// 而空白则让人分不清"没有值"和"不认识这个值"。

/** `private` | `group` | `temp`。 */
function kindLabel(value: unknown): string {
  const kind = text(value)
  if (kind === 'private') return '私聊'
  if (kind === 'group') return '群聊'
  if (kind === 'temp') return '临时'
  return kind ?? '—'
}

/**
 * 入站消息的文本预览。
 *
 * ## 为什么不能只映射 `image` / `file`（2026-10-09 审计 §6.2）
 *
 * 以前这里只有那两个分支，于是**语音（`record`）与视频（`video`）落到「（无文本）」** ——
 * 用户看到的是"一条空消息"，而实际上那里有一条语音。
 * 类型清单与占位符翻译搬进了 `utils/message-labels.ts`（媒体列与文本占位符是两个来源，
 * 见那里的说明），这里只负责"拼起来 + 截断"。
 */
function textPreview(row: Record<string, unknown>): string {
  return clip(inboundPreview({ mediaKind: row['mediaKind'], text: row['text'] }))
}

/** 已处理是布尔，**不是** 0/1；取不到就给"—"，不能默认成"待处理"（那是替数据下结论）。 */
function processedText(value: unknown): string {
  if (value === true) return '已处理'
  if (value === false) return '待处理'
  return '—'
}

/** 出站类型是开放集合（text/image/file/sticker/notice/mention_all…）。 */
function outboxKindText(value: unknown): string {
  const kind = text(value)
  if (kind === 'text') return '文本'
  if (kind === 'image') return '图片'
  if (kind === 'file') return '文件'
  if (kind === 'sticker') return '表情'
  if (kind === 'notice') return '通知'
  if (kind === 'mention_all') return '@全体'
  return kind ?? '—'
}

function outboxStatusText(value: unknown): string {
  if (value === 'pending') return '待认领'
  if (value === 'sending') return '发送中'
  if (value === 'sent') return '已发送'
  if (value === 'failed') return '失败'
  return text(value) ?? '—'
}

/** 待读是否已读（同样是布尔而非 0/1）。 */
function readText(value: unknown): string {
  if (value === true) return '已读'
  if (value === false) return '未读'
  return '—'
}

/** 轮次状态 → 语义色：完成=好；失败=坏；延后=要注意；进行中只是"信息"，不是异常。 */
function turnTone(status: string): 'ok' | 'warn' | 'err' | 'info' | 'muted' {
  if (status === 'done') return 'ok'
  if (status === 'failed') return 'err'
  if (status === 'deferred') return 'warn'
  if (status === 'running') return 'info'
  return 'muted'
}

function turnLabel(status: string): string {
  if (status === 'running') return '进行中'
  if (status === 'done') return '完成'
  if (status === 'failed') return '失败'
  if (status === 'deferred') return '已延后'
  return status
}

/**
 * 一轮的耗时（秒）。
 *
 * 没有 `endedAt` 就是 undefined（界面显示"—"）：拿 `Date.now()` 顶替会得到一个
 * 每秒都在涨的假耗时。解析失败也给 undefined，免得 `formatDuration` 渲染出 "NaN 秒"。
 */
function turnSeconds(turn: TurnItem): number | undefined {
  if (turn.endedAt === undefined) return undefined
  const from = Date.parse(turn.startedAt)
  const to = Date.parse(turn.endedAt)
  if (Number.isNaN(from) || Number.isNaN(to)) return undefined
  return Math.max(0, (to - from) / 1000)
}

// ── 顶部指标卡 ──────────────────────────────────────────────────────────────
//
// hint 里说明每个数的口径：列表有页大小、计数是全库，这两件事必须在界面上讲清楚。

const sessionsHint = computed(() => '最近有消息的会话；服务端单页最多 50 条')

const queueHint = computed(
  () => `队列共 ${formatNumber(queueStats.value?.total)} 条 · 有错误的 ${formatNumber(queueStats.value?.failed)} 条`,
)

const turnHint = computed(() => {
  const s = turnStats.value
  const base = `完成 ${formatNumber(s?.done)} · 失败 ${formatNumber(s?.failed)} · 延后 ${formatNumber(s?.deferred)}`
  const avgMs = s?.avgDurationMs
  // 平均时长只在"有跑完的轮次"时才存在（服务端缺席而不是给 0），所以这里也只在有时才显示
  return avgMs === undefined ? base : `${base} · 平均 ${formatDuration(avgMs / 1000)}`
})

const outboxHint = computed(
  () => `失败 ${formatNumber(outboxStats.value?.failed)} · 已确认送达 ${formatNumber(outboxStats.value?.confirmed)}`,
)

// ── 各表的列定义 ────────────────────────────────────────────────────────────

/**
 * 子窗口与右键菜单。
 *
 * 菜单动作与页面按钮调用**同一个** openConversation —— 分成两套的话，
 * 菜单里改了 A、按钮里改了 B，最后没人知道哪个是对的。
 */
const { state: menuState, onContextMenu, touchHandlers, close: closeMenu, clampToViewport } = useContextMenu()
const openedKey = ref<string | null>(null)

function openConversation(key: string): void {
  openedKey.value = key
}

/** 右键/长按菜单项。 */
function sessionMenuItems(row: Record<string, unknown>): ContextMenuItem[] {
  const key = String(row['conversationKey'])
  return [
    { key: 'detail', label: '打开详情…', hint: '时区/备注/画像', run: () => openConversation(key) },
    {
      key: 'copy',
      label: '复制会话键',
      run: () => {
        void navigator.clipboard?.writeText(key)
      },
    },
  ]
}

const sessionColumns: TableColumn<Record<string, unknown>>[] = [
  // 手机端卡片标题取标题，没标题的会话退回会话键——否则卡片头上是一个没有信息量的 "—"
  {
    key: 'title',
    label: '标题',
    primary: true,
    value: (row) => text(row['title']) ?? text(row['conversationKey']) ?? '—',
  },
  { key: 'conversationKey', label: '会话键', mono: true },
  { key: 'kind', label: '类型', narrow: true, value: (row) => kindLabel(row['kind']) },
  { key: 'lastMessageAt', label: '最后消息', secondary: true, value: (row) => formatRelative(text(row['lastMessageAt'])) },
  { key: 'unread', label: '未读', numeric: true, narrow: true, value: (row) => formatNumber(num(row['unread'])) },
]

const inboxColumns: TableColumn<Record<string, unknown>>[] = [
  // 时间用落库时间（receivedAt）：队列是按它排序的；事件时间（at）与它的差才是"在路上花了多久"
  { key: 'receivedAt', label: '落库时间', primary: true, value: (row) => formatRelative(text(row['receivedAt'])) },
  { key: 'conversationKey', label: '会话', mono: true },
  { key: 'senderName', label: '发送者' },
  { key: 'text', label: '文本', value: (row) => textPreview(row) },
  { key: 'processed', label: '处理', narrow: true, value: (row) => processedText(row['processed']) },
  { key: 'error', label: '错误' },
]

const outboxColumns: TableColumn<Record<string, unknown>>[] = [
  { key: 'sentAt', label: '时间', primary: true, value: (row) => formatRelative(text(row['sentAt'])) },
  { key: 'conversationKey', label: '会话', mono: true },
  { key: 'kind', label: '类型', narrow: true, value: (row) => outboxKindText(row['kind']) },
  { key: 'status', label: '状态', narrow: true, value: (row) => outboxStatusText(row['status']) },
  { key: 'attempt', label: '尝试', numeric: true, narrow: true, value: (row) => formatNumber(num(row['attempt'])) },
  { key: 'error', label: '错误' },
]

const pendingColumns: TableColumn<Record<string, unknown>>[] = [
  { key: 'at', label: '时间', primary: true, value: (row) => formatRelative(text(row['at'])) },
  { key: 'conversationKey', label: '会话', mono: true },
  { key: 'senderName', label: '发送者' },
  { key: 'summary', label: '摘要', value: (row) => clip(text(row['summary']) ?? '') },
  { key: 'read', label: '状态', narrow: true, value: (row) => readText(row['read']) },
]
</script>

<template>
  <div class="page">
    <AsyncSection
      :loading="state.loading.value"
      :error="state.error.value"
      :updated-at="state.updatedAt.value"
      :skeleton-rows="6"
      @retry="state.refresh()"
    >
      <template v-if="state.data.value">
        <div class="grid grid-4">
          <StatCard
            label="会话数"
            :value="formatNumber(sessions.length)"
            :hint="sessionsHint"
            icon="chat"
          />
          <StatCard
            label="待处理入站"
            :value="formatNumber(queueStats?.pending)"
            :tone="(queueStats?.pending ?? 0) > 0 ? 'warn' : 'ok'"
            icon="overview"
            :hint="queueHint"
          />
          <StatCard
            label="运行中轮次"
            :value="formatNumber(turnStats?.running)"
            :tone="(turnStats?.running ?? 0) > 0 ? 'brand' : 'neutral'"
            icon="refresh"
            :hint="turnHint"
          />
          <StatCard
            label="出站积压"
            :value="formatNumber(outboxStats?.pending)"
            :tone="(outboxStats?.pending ?? 0) > 0 ? 'warn' : 'ok'"
            icon="external"
            :hint="outboxHint"
          />
        </div>

        <PanelCard title="会话" :subtitle="`按最后消息时间倒序；本页 ${formatNumber(sessions.length)} 个 · 右键或长按可操作`">
          <p v-if="sessions.length === 0" class="sessions-empty">
            还没有会话记录。QQ 连接收到第一条消息、或机器人主动发过一条之后，
            这里会出现会话及其未读数。
          </p>

          <ul v-else class="sessions">
            <li
              v-for="row in sessions"
              :key="String(row['conversationKey'])"
              class="session"
              @contextmenu="onContextMenu($event, sessionMenuItems(row), row)"
              v-on="touchHandlers(sessionMenuItems(row), row)"
            >
              <div class="session-main">
                <span class="session-title">{{ text(row['title']) ?? String(row['conversationKey']) }}</span>
                <span class="mono session-key">{{ row['conversationKey'] }}</span>
              </div>
              <div class="session-facts">
                <StatusBadge tone="muted">{{ kindLabel(row['kind']) }}</StatusBadge>
                <span>{{ formatRelative(String(row['lastMessageAt'] ?? '')) }}</span>
                <span v-if="Number(row['unread'] ?? 0) > 0" class="session-unread">
                  未读 {{ formatNumber(Number(row['unread'])) }}
                </span>
              </div>
              <button type="button" class="session-open" @click="openConversation(String(row['conversationKey']))">
                详情
              </button>
            </li>
          </ul>
        </PanelCard>

        <PanelCard title="入站队列" :subtitle="`按落库时间倒序；本页 ${formatNumber(queue.length)} 条`">
          <DataTable
            :columns="inboxColumns"
            :rows="queue"
            empty-text="入站队列是空的：还没有收到过任何消息（或历史已被清理）。收到消息后会先落到这里，再交给轮次处理。"
          />

          <template #footer>
            <p class="muted note">
              表格只取最近的一页；积压很久的待处理消息可能不在这一页里，
              顶部卡片上的「待处理入站」才是全库口径。
            </p>
          </template>
        </PanelCard>

        <!--
          这一块**故意不用 DataTable**：DataTable 的单元格只渲染字符串，
          而轮次状态必须是一个带语义色的 StatusBadge（"失败/延后"要在一眼扫过时就跳出来）。
          手机端用同一份标记靠 CSS 把表格折成卡片（见 <style> 里的媒体查询），不复制模板。
        -->
        <PanelCard title="轮次" :subtitle="`按开始时间倒序；本页 ${formatNumber(turns.length)} 条`">
          <table v-if="turns.length > 0" class="turns">
            <thead>
              <tr>
                <th scope="col">开始时间</th>
                <th scope="col">会话</th>
                <th scope="col">状态</th>
                <th scope="col">模型</th>
                <th scope="col" class="num">token 入/出</th>
                <th scope="col" class="num">耗时</th>
              </tr>
            </thead>
            <tbody>
              <template v-for="turn in turns" :key="turn.id">
                <tr>
                  <td data-label="开始" :title="turn.startedAt">{{ formatRelative(turn.startedAt) }}</td>
                  <td data-label="会话" class="mono">{{ turn.conversationKey }}</td>
                  <td data-label="状态">
                    <StatusBadge :tone="turnTone(turn.status)" dot>{{ turnLabel(turn.status) }}</StatusBadge>
                  </td>
                  <td data-label="模型" class="mono">{{ turn.model ?? '—' }}</td>
                  <td data-label="token 入/出" class="num">
                    {{ formatTokens(turn.tokensIn) }} / {{ formatTokens(turn.tokensOut) }}
                  </td>
                  <td data-label="耗时" class="num">{{ formatDuration(turnSeconds(turn)) }}</td>
                </tr>
                <!-- 失败原因 / 延后原因单独一行：它是排查这一轮时唯一真正想看的东西，
                     塞进状态列会把徽标挤变形，塞进 tooltip 在手机上又看不到 -->
                <tr v-if="turn.error !== undefined || turn.deferReason !== undefined" class="why">
                  <td colspan="6">
                    <template v-if="turn.error !== undefined">错误：{{ turn.error }}</template>
                    <template v-else>延后原因：{{ turn.deferReason }}</template>
                  </td>
                </tr>
              </template>
            </tbody>
          </table>
          <p v-else class="empty">
            还没有轮次记录。收到消息并触发一次模型调用之后，这里会出现从「进行中」到「完成 / 失败 / 已延后」的完整过程。
          </p>
        </PanelCard>

        <PanelCard title="出站" :subtitle="`按时间倒序；本页 ${formatNumber(outbox.length)} 条`">
          <DataTable
            :columns="outboxColumns"
            :rows="outbox"
            empty-text="还没有出站记录。机器人的回复、通知、表情等发送动作都会先落到出站队列，这里能看到每次发送的尝试次数与结果。"
          />
        </PanelCard>

        <PanelCard title="待读池" :subtitle="`按时间倒序；本页 ${formatNumber(pending.length)} 条`">
          <DataTable
            :columns="pendingColumns"
            :rows="pending"
            empty-text="待读池是空的：目前没有攒下来还没看的消息。有积压时它们会出现在这里，并标明是否已被读过。"
          />
        </PanelCard>
      </template>
    </AsyncSection>
  </div>

    <ConversationPanel :conversation-key="openedKey" @close="openedKey = null" />
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

.note {
  font-size: var(--t-xs);
  line-height: 1.5;
}

/* 桌面：与 DataTable 的表格同一套度量（内边距/边框/字号），一页里不会像两个系统 */
.turns {
  width: 100%;
  border-collapse: collapse;
  font-size: var(--t-sm);
}
.turns th,
.turns td {
  padding: 8px var(--s-2);
  text-align: left;
  border-bottom: 1px solid var(--c-border);
  vertical-align: top;
}
.turns th {
  position: sticky;
  top: 0;
  z-index: 1;
  background: var(--c-surface);
  color: var(--c-text-3);
  font-size: var(--t-xs);
  font-weight: 600;
  white-space: nowrap;
}
.turns tbody tr:hover {
  background: var(--c-surface-2);
}
.turns td {
  color: var(--c-text-2);
  max-width: 32ch;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.turns .num {
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.turns .mono {
  font-family: var(--font-mono);
  font-size: 0.92em;
}
/* 原因行：贴着上一行、弱化显示，读起来像那条记录的注脚 */
.turns .why td {
  padding-top: 0;
  max-width: none;
  border-bottom: 1px solid var(--c-border);
  color: var(--c-text-3);
  font-size: var(--t-xs);
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
  .turns,
  .turns tbody,
  .turns tr,
  .turns td {
    display: block;
    width: auto;
  }
  .turns thead {
    display: none;
  }
  .turns tr {
    margin-bottom: var(--s-2);
    padding: var(--s-3);
    background: var(--c-surface-2);
    border-radius: var(--r-md);
  }
  .turns tbody tr:hover {
    background: var(--c-surface-2);
  }
  .turns td {
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
  .turns td::before {
    content: attr(data-label);
    flex: none;
    color: var(--c-text-3);
    font-size: var(--t-xs);
  }
  /* 原因行没有列名（data-label 为空），当普通卡片读 */
  .turns .why td {
    text-align: left;
    padding-top: 0;
  }
}

.sessions {
  display: flex;
  flex-direction: column;
  gap: 2px;
  list-style: none;
}
.session {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--s-3);
  min-height: var(--touch-min, 44px);
  padding: var(--s-2) var(--s-3);
  border-radius: var(--r-sm);
  cursor: context-menu;
}
.session:hover {
  background: var(--c-surface-2);
}
.session-main {
  display: flex;
  flex-direction: column;
  min-width: 0;
  flex: 1;
}
.session-title {
  color: var(--c-text);
  font-size: var(--t-sm);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.session-key {
  color: var(--c-text-3);
  font-size: var(--t-xs);
}
.session-facts {
  display: flex;
  align-items: center;
  gap: var(--s-2);
  color: var(--c-text-3);
  font-size: var(--t-xs);
}
.session-unread {
  padding: 0 6px;
  border-radius: var(--r-full);
  background: var(--c-brand-soft);
  color: var(--c-brand-text, var(--c-brand));
}
.session-open {
  min-height: 28px;
  padding: 0 var(--s-3);
  border: 1px solid var(--c-border-strong);
  border-radius: var(--r-sm);
  background: transparent;
  color: var(--c-text-2);
  font-size: var(--t-xs);
  cursor: pointer;
}
.session-open:hover {
  border-color: var(--c-brand);
  color: var(--c-brand);
}
.sessions-empty {
  padding: var(--s-5) 0;
  color: var(--c-text-3);
  font-size: var(--t-sm);
  line-height: 1.8;
  text-align: center;
}
</style>
