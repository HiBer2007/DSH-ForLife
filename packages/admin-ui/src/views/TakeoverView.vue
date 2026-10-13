<script setup lang="ts">
/**
 * 接管台 —— 接管模式下的**运维收件箱**。
 *
 * ## 为什么单独一页，而不是塞进「会话与队列」
 *
 * 那一页是**观察面**（看清系统在干什么，数据密集、只读）；这一页是**工作面**
 * （你要动手回消息）。混在一起会出现"想回复时要在几十行表格里找输入框"这种事。
 * 而且接管态是**暂时**的：关掉之后这一页就没用了，不该让它污染日常视图。
 *
 * ## 接管模式的关键设计（也是这一页存在的原因）
 *
 * 开启后消息**照常入库**但**不进模型**，且 `processed` 保持 0 ——
 * 所以「待处理入站」这个数字正好就是**你的待办数量**。
 * 一旦你回复了，那条消息才被标记为已处理（见 `markHandled`）。
 *
 * 没有这一页的话，接管模式等于"消息石沉大海"：开关拨过去，然后什么都做不了。
 */
import ContextMenu from '../components/ContextMenu.vue'
import { useContextMenu, type ContextMenuItem } from '../composables/useContextMenu.ts'
import { computed, ref } from 'vue'

import { api } from '../api/client.ts'
import type { ConversationsOverview } from '../api/types-qq.ts'
import AppIcon from '../components/AppIcon.vue'
import AsyncSection from '../components/AsyncSection.vue'
import PanelCard from '../components/PanelCard.vue'
import StatusBadge from '../components/StatusBadge.vue'
import { useAsyncData } from '../composables/useAsyncData.ts'
import { formatRelative } from '../utils/format.ts'

interface TakeoverState {
  readonly on: boolean
  readonly changedAt?: string
}

const takeover = useAsyncData<TakeoverState>(() => api.get<TakeoverState>('/takeover'))
const conversations = useAsyncData<ConversationsOverview>(() => api.get<ConversationsOverview>('/conversations'))

const busy = ref(false)
const notice = ref<{ tone: 'ok' | 'err'; text: string }>()
/** 每个会话一个草稿（用会话键当字典键，切会话不丢已输入的内容）。 */
const drafts = ref<Record<string, string>>({})
const sendingTo = ref<string>()

const isOn = computed(() => takeover.data.value?.on === true)

/** 待人工处理的消息（接管模式下就是"还没人管的消息"）。 */
const pendingQueue = computed(() => (conversations.data.value?.queue ?? []).filter((item) => !item.processed))

/** 有消息待处理的会话（按最近消息排序，去重）。 */
/**
 * 待处理消息的右键菜单。
 *
 * 接管模式下"待处理"是**唯一的工作队列指示器**，所以菜单只放最常用的两件事：
 * 复制消息内容、复制会话键（要拿它去别处操作）。
 *
 * **不给"标记已处理"** —— 那件事应该发生在"你确实回复了"的时候（/send 会自动标记），
 * 单独一个"标记"按钮会让人为了清空数字而点它，而消息其实没被处理。
 */
const { state: menuState, onContextMenu, touchHandlers, close: closeMenu, clampToViewport } = useContextMenu()

function messageMenuItems(item: Record<string, unknown>): ContextMenuItem[] {
  const key = String(item["conversationKey"] ?? "")
  const text = String(item["text"] ?? "")
  return [
    { key: "copyText", label: "复制消息内容", run: () => void navigator.clipboard?.writeText(text) },
    { key: "copyKey", label: "复制会话键", hint: key, run: () => void navigator.clipboard?.writeText(key) },
  ]
}

const pendingSessions = computed(() => {
  const seen = new Map<string, { key: string; title: string; unread: number; lastAt?: string }>()
  for (const item of pendingQueue.value) {
    const known = (conversations.data.value?.sessions ?? []).find((s) => s.conversationKey === item.conversationKey)
    const existing = seen.get(item.conversationKey)
    if (existing === undefined) {
      seen.set(item.conversationKey, {
        key: item.conversationKey,
        title: known?.title ?? item.senderName ?? item.conversationKey,
        unread: 1,
        ...(item.at === undefined ? {} : { lastAt: item.at }),
      })
    } else {
      existing.unread += 1
    }
  }
  return [...seen.values()]
})

/** 全部会话（也允许给没有待处理消息的会话发消息 —— 有时你就是想主动说一句）。 */
const allSessions = computed(() => conversations.data.value?.sessions ?? [])

async function toggle(): Promise<void> {
  busy.value = true
  notice.value = undefined
  try {
    const next = !isOn.value
    await api.post('/takeover', { on: next })
    await takeover.refresh()
    notice.value = {
      tone: 'ok',
      text: next
        ? '已开启接管：新消息只入库、不进模型，等你在下面手动处理。'
        : '已关闭接管：消息恢复由模型处理。',
    }
  } catch (error) {
    notice.value = { tone: 'err', text: error instanceof Error ? error.message : String(error) }
  } finally {
    busy.value = false
  }
}

async function send(conversationKey: string): Promise<void> {
  const text = (drafts.value[conversationKey] ?? '').trim()
  if (text === '') return
  sendingTo.value = conversationKey
  notice.value = undefined
  try {
    await api.post('/send', { conversationKey, text })
    drafts.value[conversationKey] = ''
    notice.value = { tone: 'ok', text: `已交给发送队列（${conversationKey}）—— 发出去后状态会变成「已确认」。` }
    // 发完刷新一次：出站状态与待处理计数都会变
    setTimeout(() => void conversations.refresh(), 1200)
  } catch (error) {
    notice.value = { tone: 'err', text: error instanceof Error ? error.message : String(error) }
  } finally {
    sendingTo.value = undefined
  }
}
</script>

<template>
  <div class="page">
    <AsyncSection
      :loading="takeover.loading.value"
      :error="takeover.error.value"
      :updated-at="takeover.updatedAt.value"
      :skeleton-rows="3"
      @retry="takeover.refresh()"
    >
      <template v-if="takeover.data.value">
        <PanelCard title="接管模式" subtitle="开启后消息不再路由给模型，全部留给你手动处理">
          <template #actions>
            <StatusBadge :tone="isOn ? 'warn' : 'ok'" dot>{{ isOn ? '接管中' : '模型自动回复' }}</StatusBadge>
          </template>

          <div class="switch-row">
            <button
              type="button"
              class="switch"
              role="switch"
              :aria-checked="isOn"
              :data-on="isOn"
              :disabled="busy"
              @click="toggle"
            >
              <span class="knob" aria-hidden="true" />
              <span class="switch-label">{{ isOn ? '接管中（模型不参与）' : '自动回复中' }}</span>
            </button>
            <span v-if="takeover.data.value.changedAt" class="muted small">
              上次变更：{{ takeover.data.value.changedAt }}
            </span>
          </div>

          <p v-if="notice" class="notice" :class="notice.tone === 'err' ? 'err' : 'ok'">{{ notice.text }}</p>

          <p class="muted note">
            <strong>开关立即生效</strong>，不需要重启服务：网关每次收到消息都会重新读这个开关。
            开启期间消息**照常入库**（你能看到），但不会产生轮次，`processed` 保持 0 ——
            所以「待处理」这个数字就是你的待办数量。
          </p>
        </PanelCard>

        <PanelCard
          title="待你处理"
          :subtitle="`${pendingQueue.length} 条消息、${pendingSessions.length} 个会话`"
        >
          <template #actions>
            <button type="button" class="btn" @click="conversations.refresh()">
              <AppIcon name="refresh" :size="14" />
              <span>刷新</span>
            </button>
          </template>

          <p v-if="pendingSessions.length === 0" class="empty">
            {{
              isOn
                ? '还没有待处理的消息。开启接管后，别人发给机器人的消息会出现在这里等你回复。'
                : '当前是自动回复模式，消息不会积压在这里。想手动接管就先打开上面的开关。'
            }}
          </p>

          <ul v-else class="list">
            <li v-for="session in pendingSessions" :key="session.key">
              <div class="head">
                <strong>{{ session.title }}</strong>
                <span class="muted mono small">{{ session.key }}</span>
                <StatusBadge tone="warn">{{ session.unread }} 条待处理</StatusBadge>
              </div>

              <!-- 该会话的待处理原文：要回复就得先看见对方说了什么 -->
              <ul class="messages">
<li
                  @contextmenu="onContextMenu($event, messageMenuItems(item), item)"
                  v-on="touchHandlers(messageMenuItems(item), item)" v-for="item in pendingQueue.filter((m) => m.conversationKey === session.key)" :key="item.id">
                  <span class="who">{{ item.senderName ?? '未知' }}</span>
                  <span class="text">{{ item.text === '' ? '（非文本消息）' : item.text }}</span>
                  <span class="muted small">{{ formatRelative(item.at) }}</span>
                </li>
              </ul>

              <form class="reply" @submit.prevent="send(session.key)">
                <textarea
                  v-model="drafts[session.key]"
                  rows="2"
                  :placeholder="`回复 ${session.title}…`"
                  :aria-label="`回复 ${session.title}`"
                />
                <button type="submit" class="btn primary" :disabled="sendingTo === session.key || (drafts[session.key] ?? '').trim() === ''">
                  {{ sendingTo === session.key ? '发送中…' : '发送' }}
                </button>
              </form>
            </li>
          </ul>
        </PanelCard>

        <PanelCard title="主动发送" subtitle="给任意已登记的会话发一条消息（不限于待处理）">
          <p v-if="allSessions.length === 0" class="empty">还没有任何会话。等有人给机器人发过消息之后，这里会列出会话。</p>
          <ul v-else class="list compact">
            <li v-for="session in allSessions" :key="session.conversationKey">
              <div class="head">
                <strong>{{ session.title ?? session.conversationKey }}</strong>
                <StatusBadge :tone="session.kind === 'group' ? 'info' : 'muted'">
                  {{ session.kind === 'group' ? '群聊' : session.kind === 'private' ? '私聊' : session.kind }}
                </StatusBadge>
                <span class="muted small">{{ session.lastMessageAt ? formatRelative(session.lastMessageAt) : '还没消息' }}</span>
              </div>
              <form class="reply" @submit.prevent="send(session.conversationKey)">
                <textarea
                  v-model="drafts[session.conversationKey]"
                  rows="1"
                  :placeholder="`发给 ${session.title ?? session.conversationKey}…`"
                  :aria-label="`发给 ${session.title ?? session.conversationKey}`"
                />
                <button
                  type="submit"
                  class="btn"
                  :disabled="sendingTo === session.conversationKey || (drafts[session.conversationKey] ?? '').trim() === ''"
                >
                  发送
                </button>
              </form>
            </li>
          </ul>
        </PanelCard>
      </template>
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

.switch-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--s-3);
}

.switch {
  display: inline-flex;
  align-items: center;
  gap: var(--s-3);
  min-height: var(--touch-min);
  padding: 0 var(--s-4) 0 var(--s-2);
  border: 1px solid var(--c-border-strong);
  border-radius: var(--r-full);
  background: var(--c-surface);
  color: var(--c-text);
  cursor: pointer;
  font-size: var(--t-sm);
}
.switch:disabled {
  opacity: 0.6;
  cursor: default;
}
.switch .knob {
  position: relative;
  width: 44px;
  height: 24px;
  border-radius: var(--r-full);
  background: var(--c-ok);
  transition: background var(--dur-fast) var(--ease);
}
.switch .knob::after {
  content: '';
  position: absolute;
  top: 3px;
  left: 3px;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: #fff;
  transition: transform var(--dur-fast) var(--ease);
}
.switch[data-on='true'] .knob {
  background: var(--c-warn);
}
.switch[data-on='true'] .knob::after {
  transform: translateX(20px);
}

.notice {
  margin-top: var(--s-3);
  font-size: var(--t-sm);
}
.notice.ok {
  color: var(--c-ok);
}
.notice.err {
  color: var(--c-err);
}

.note {
  margin-top: var(--s-3);
  font-size: var(--t-xs);
  line-height: 1.7;
}

.empty {
  padding: var(--s-6) 0;
  text-align: center;
  color: var(--c-text-3);
  font-size: var(--t-sm);
  line-height: 1.7;
}

.list {
  display: flex;
  flex-direction: column;
  gap: var(--s-3);
  list-style: none;
}
.list > li {
  padding: var(--s-3);
  border: 1px solid var(--c-border);
  border-radius: var(--r-md);
}
.list.compact > li {
  padding: var(--s-2) var(--s-3);
}

.head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--s-2);
  margin-bottom: var(--s-2);
}

.messages {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-bottom: var(--s-3);
  padding-left: var(--s-2);
  border-left: 2px solid var(--c-border);
  list-style: none;
}
.messages > li {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--s-2);
  font-size: var(--t-sm);
}
.who {
  flex: none;
  color: var(--c-text-3);
  font-size: var(--t-xs);
}
.text {
  color: var(--c-text);
  overflow-wrap: anywhere;
}

.reply {
  display: flex;
  align-items: flex-end;
  gap: var(--s-2);
}
.reply textarea {
  flex: 1 1 auto;
  min-width: 0;
  padding: var(--s-2) var(--s-3);
  background: var(--c-bg);
  border: 1px solid var(--c-border-strong);
  border-radius: var(--r-md);
  color: var(--c-text);
  font: inherit;
  font-size: var(--t-sm);
  resize: vertical;
  outline: none;
}
.reply textarea:focus {
  border-color: var(--c-brand);
  box-shadow: 0 0 0 3px var(--c-brand-soft);
}

.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  flex: none;
  min-height: 36px;
  padding: 0 var(--s-4);
  border: 1px solid var(--c-border-strong);
  border-radius: var(--r-md);
  background: var(--c-surface);
  color: var(--c-text);
  cursor: pointer;
  font-size: var(--t-sm);
}
.btn:hover:not(:disabled) {
  background: var(--c-surface-2);
}
.btn.primary {
  border-color: transparent;
  background: var(--c-brand);
  color: #fff;
  font-weight: 600;
}
.btn:disabled {
  opacity: 0.5;
  cursor: default;
}

.small {
  font-size: var(--t-xs);
}
</style>
