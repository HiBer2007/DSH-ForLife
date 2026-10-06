<script setup lang="ts">
/**
 * 会话子窗口 —— 一个会话的**全部信息与配置**。
 *
 * ## 为什么是抽屉（而不是新页面）
 *
 * 用户要求它能从「会话与队列」**和**「唤醒与自唤醒」两处打开。
 * 做成独立页面的话，从哪来、回哪去就得靠路由参数传，而且**看的时候看不到原列表** ——
 * 而"这个会话跟旁边那些比怎么样"恰恰是常见的判断方式。
 * 抽屉保留了背后的列表，关掉就回到原处。
 *
 * ## 画像为什么要跟备注分开显示
 *
 * 备注是**主人说的**（权威），画像是**模型总结的**（可能有误）。
 * 界面上必须看得出区别，否则用户会把模型的猜测当成事实读。
 * 所以画像带来源标签，模型写的那版明确标"可能有误"。
 */
import { computed, ref, watch } from 'vue'

import { api } from '../api/client.ts'
import type { ConversationDetail } from '../api/types-conversation.ts'
import AsyncSection from './AsyncSection.vue'
import StatusBadge from './StatusBadge.vue'
import { formatDuration, formatNumber, formatRelative } from '../utils/format.ts'

const props = defineProps<{
  /** 要看的会话键；为 null 表示关闭。 */
  readonly conversationKey: string | null
}>()

const emit = defineEmits<{ readonly close: [] }>()

const detail = ref<ConversationDetail | null>(null)
const loading = ref(false)
const error = ref('')
const saving = ref(false)
const saveError = ref('')

/** 编辑中的草稿（与已保存值分开，取消时不会污染）。 */
const noteDraft = ref('')
const timezoneDraft = ref('')

/** 常用时区（只是**建议**，仍允许自由输入 —— 总有人的时区不在短名单里）。 */
const TIMEZONE_SUGGESTIONS = [
  'Asia/Shanghai',
  'Asia/Hong_Kong',
  'Asia/Taipei',
  'Asia/Tokyo',
  'Asia/Seoul',
  'Asia/Singapore',
  'Europe/London',
  'Europe/Berlin',
  'America/New_York',
  'America/Los_Angeles',
  'UTC',
] as const
const impressionDraft = ref('')

async function load(): Promise<void> {
  const key = props.conversationKey
  if (key === null) return
  loading.value = true
  error.value = ''
  try {
    // 直接拼查询串：`api.get` 的 query 参数类型不接受对象值，拼串更省事也更明确
    const data = await api.get<ConversationDetail>(`/conversation?id=${encodeURIComponent(key)}`)
    detail.value = data
    noteDraft.value = data.note ?? ''
    impressionDraft.value = data.impression ?? ''
    timezoneDraft.value = data.clock?.timezone ?? ''
  } catch (caught) {
    // 会话不存在时接口给 404 并带原因 —— 如实显示，不显示空壳
    error.value = caught instanceof Error ? caught.message : String(caught)
    detail.value = null
  } finally {
    loading.value = false
  }
}

watch(() => props.conversationKey, (key) => {
  if (key === null) {
    detail.value = null
    return
  }
  void load()
}, { immediate: true })

/** 保存时区（记 user_set，优先级高于模型判断）。 */
async function saveTimezone(): Promise<void> {
  const key = props.conversationKey
  if (key === null) return
  if (timezoneDraft.value.trim() === '') {
    saveError.value = '时区不能为空'
    return
  }
  saving.value = true
  saveError.value = ''
  try {
    await api.post('/conversation-timezone', { conversationKey: key, timezone: timezoneDraft.value.trim() })
    await load()
  } catch (caught) {
    saveError.value = caught instanceof Error ? caught.message : String(caught)
  } finally {
    saving.value = false
  }
}

/** 保存备注（只有人能写这条路径）。 */
async function saveNote(): Promise<void> {
  const key = props.conversationKey
  if (key === null) return
  saving.value = true
  saveError.value = ''
  try {
    await api.post('/conversation-note', { conversationKey: key, note: noteDraft.value === '' ? null : noteDraft.value })
    await load()
  } catch (caught) {
    saveError.value = caught instanceof Error ? caught.message : String(caught)
  } finally {
    saving.value = false
  }
}

/** 保存画像（面板改的会被标成"主人修正过"，此后模型不会覆盖）。 */
async function saveImpression(): Promise<void> {
  const key = props.conversationKey
  if (key === null) return
  saving.value = true
  saveError.value = ''
  try {
    await api.post('/conversation-impression', {
      conversationKey: key,
      impression: impressionDraft.value === '' ? null : impressionDraft.value,
    })
    await load()
  } catch (caught) {
    saveError.value = caught instanceof Error ? caught.message : String(caught)
  } finally {
    saving.value = false
  }
}

/** 自己配的规则（`own`）与继承来的分开，避免把继承的当成自己设的。 */
const ownRules = computed(() => (detail.value?.wakeRules ?? []).filter((rule) => rule.own))
const inheritedRules = computed(() => (detail.value?.wakeRules ?? []).filter((rule) => !rule.own))

const kindLabel = computed(() => {
  switch (detail.value?.kind) {
    case 'group':
      return '群聊'
    case 'private':
      return '私聊'
    case 'temp':
      return '临时会话'
    default:
      return detail.value?.kind ?? ''
  }
})
</script>

<template>
  <Teleport to="body">
    <div v-if="conversationKey !== null" class="drawer-mask" @click.self="emit('close')">
      <aside class="drawer" role="dialog" aria-modal="true" aria-label="会话详情">
        <header class="drawer-head">
          <div class="head-main">
            <h2 class="head-title mono">{{ conversationKey }}</h2>
            <p class="head-sub">
              <StatusBadge v-if="detail" tone="muted">{{ kindLabel }}</StatusBadge>
              <span v-if="detail?.lastMessageAt">最近活跃 {{ formatRelative(detail.lastMessageAt) }}</span>
            </p>
          </div>
          <button type="button" class="close" aria-label="关闭" @click="emit('close')">✕</button>
        </header>

        <div class="drawer-body">
          <AsyncSection :loading="loading" :error="error" :skeleton-rows="4" @retry="load">
            <template v-if="detail">
              <!-- 计数 -->
              <section class="block">
                <h3 class="block-title">数据</h3>
                <dl class="facts">
                  <div><dt>入站</dt><dd>{{ formatNumber(detail.counts.inbound) }}</dd></div>
                  <div><dt>出站</dt><dd>{{ formatNumber(detail.counts.outbound) }}</dd></div>
                  <div><dt>轮次</dt><dd>{{ formatNumber(detail.counts.turns) }}</dd></div>
                  <div>
                    <dt>待处理</dt>
                    <dd :data-warn="detail.counts.pendingInbound > 0">{{ formatNumber(detail.counts.pendingInbound) }}</dd>
                  </div>
                </dl>
                <p v-if="detail.createdAt" class="hint">首次出现 {{ formatRelative(detail.createdAt) }}</p>
              </section>

              <!-- 时区 -->
              <section class="block">
                <h3 class="block-title">时区</h3>
                <div class="tz-row">
                  <input
                    v-model="timezoneDraft"
                    class="tz-input mono"
                    list="tz-suggestions"
                    placeholder="Asia/Shanghai"
                    aria-label="时区"
                  />
                  <datalist id="tz-suggestions">
                    <option v-for="zone in TIMEZONE_SUGGESTIONS" :key="zone" :value="zone" />
                  </datalist>
                  <button type="button" class="btn primary" :disabled="saving" @click="saveTimezone">
                    {{ saving ? '保存中…' : '保存时区' }}
                  </button>
                </div>
                <p v-if="detail.clock" class="hint">
                  当前 <span class="mono">{{ detail.clock.timezone }}</span> ·
                  来源 <span class="mono">{{ detail.clock.source }}</span>
                  <template v-if="detail.clock.source === 'user_set'"> （人工设置，优先级最高）</template>
                </p>
                <p v-else class="hint">未设置 —— 用系统默认</p>
                <p class="hint">
                  保存后会记为 <span class="mono">user_set</span>，**优先级高于模型与小模型的自动判断** ——
                  否则它们之后会把你设的值覆盖掉。时区名写错不会报错，只会让这个会话的
                  **所有时间表述都错**，所以后端会校验，这里也给了常用值可选。
                </p>
              </section>

              <!-- 备注（主人说的，权威） -->
              <section class="block">
                <h3 class="block-title">
                  备注 <span class="badge-owner">主人写</span>
                </h3>
                <textarea
                  v-model="noteDraft"
                  class="editor"
                  rows="3"
                  placeholder="这个人是谁、什么关系、要注意什么…"
                />
                <div class="actions">
                  <button type="button" class="btn primary" :disabled="saving" @click="saveNote">
                    {{ saving ? '保存中…' : '保存备注' }}
                  </button>
                </div>
              </section>

              <!-- 画像（模型总结的，可能有误） -->
              <section class="block">
                <h3 class="block-title">
                  画像
                  <span v-if="detail.impressionSource === 'user'" class="badge-owner">主人修正过</span>
                  <span v-else class="badge-model">模型总结，可能有误</span>
                </h3>
                <textarea
                  v-model="impressionDraft"
                  class="editor"
                  rows="3"
                  placeholder="模型对这个会话/人的印象（关系、说话习惯、禁忌、称呼偏好）…"
                />
                <div class="actions">
                  <button type="button" class="btn primary" :disabled="saving" @click="saveImpression">
                    {{ saving ? '保存中…' : '保存画像' }}
                  </button>
                </div>
                <p class="hint">
                  在面板里保存过的画像会标成「主人修正过」，此后**模型自动更新不会覆盖它** ——
                  避免"我改了但它又变回去了"。
                </p>
              </section>

              <p v-if="saveError !== ''" class="save-error">{{ saveError }}</p>

              <!-- 唤醒规则 -->
              <section class="block">
                <h3 class="block-title">
                  唤醒规则
                  <span class="hint-inline">
                    自己的 {{ ownRules.length }} 条 · 继承全局 {{ inheritedRules.length }} 条
                  </span>
                </h3>
                <p v-if="ownRules.length === 0" class="hint">
                  这个会话**没有单独配过**规则，下面那些是全局默认在生效 —— 所以它照样会被唤醒。
                </p>
                <ul class="rules">
                  <li v-for="rule in detail.wakeRules" :key="`${rule.scope}/${rule.condition}`" :data-own="rule.own">
                    <span class="mono rule-cond">{{ rule.condition }}</span>
                    <StatusBadge :tone="rule.enabled ? 'ok' : 'muted'" dot>{{ rule.enabled ? '启用' : '停用' }}</StatusBadge>
                    <span class="rule-facts">
                      {{ rule.probability }}% · 间隔 {{ formatDuration(rule.minIntervalMs / 1000) }} ·
                      日限 {{ rule.dailyLimit === 0 ? '不限' : formatNumber(rule.dailyLimit) }}
                    </span>
                    <span v-if="!rule.own" class="rule-inherit">继承</span>
                  </li>
                </ul>
              </section>

              <!-- 留痕 -->
              <section v-if="detail.recentWakeEvents.length > 0" class="block">
                <h3 class="block-title">最近唤醒留痕</h3>
                <ul class="events">
                  <li v-for="event in detail.recentWakeEvents" :key="`${event.at}/${event.condition}`">
                    <span class="mono">{{ event.at.slice(11, 19) }}</span>
                    <span class="mono">{{ event.condition }}</span>
                    <StatusBadge :tone="event.decision === 'wake' ? 'ok' : 'muted'">{{ event.decision }}</StatusBadge>
                    <span v-if="event.reason" class="hint-inline">{{ event.reason }}</span>
                  </li>
                </ul>
              </section>
            </template>
          </AsyncSection>
        </div>
      </aside>
    </div>
  </Teleport>
</template>

<style scoped>
.drawer-mask {
  position: fixed;
  inset: 0;
  z-index: 950;
  background: rgb(0 0 0 / 40%);
  display: flex;
  justify-content: flex-end;
}
.drawer {
  display: flex;
  flex-direction: column;
  width: min(460px, 100%);
  height: 100%;
  background: var(--c-surface);
  border-left: 1px solid var(--c-border-strong);
  animation: drawer-in 140ms ease-out;
}
@keyframes drawer-in {
  from {
    transform: translateX(12px);
    opacity: 0;
  }
}

.drawer-head {
  display: flex;
  align-items: flex-start;
  gap: var(--s-3);
  padding: var(--s-4);
  border-bottom: 1px solid var(--c-border);
}
.head-main {
  flex: 1;
  min-width: 0;
}
.head-title {
  font-size: var(--t-sm);
  overflow-wrap: anywhere;
}
.head-sub {
  display: flex;
  align-items: center;
  gap: var(--s-2);
  margin-top: 4px;
  color: var(--c-text-3);
  font-size: var(--t-xs);
}
.close {
  flex: none;
  width: var(--touch-min, 44px);
  height: var(--touch-min, 44px);
  border: none;
  border-radius: var(--r-md);
  background: transparent;
  color: var(--c-text-2);
  font-size: var(--t-md);
  cursor: pointer;
}
.close:hover {
  background: var(--c-surface-2);
}

.drawer-body {
  flex: 1;
  overflow: auto;
  padding: var(--s-4);
}

.block + .block {
  margin-top: var(--s-5);
  padding-top: var(--s-4);
  border-top: 1px solid var(--c-border);
}
.block-title {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--s-2);
  font-size: var(--t-sm);
  margin-bottom: var(--s-2);
}
.badge-owner {
  padding: 0 6px;
  border-radius: var(--r-full);
  background: var(--c-ok-soft, rgb(40 160 90 / 14%));
  color: var(--c-ok, #2a9d5c);
  font-size: var(--t-xs);
}
.badge-model {
  padding: 0 6px;
  border-radius: var(--r-full);
  background: var(--c-surface-2);
  color: var(--c-text-3);
  font-size: var(--t-xs);
}
.hint-inline {
  color: var(--c-text-3);
  font-size: var(--t-xs);
  font-weight: 400;
}

.facts {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: var(--s-2);
}
.facts div {
  padding: var(--s-2);
  background: var(--c-surface-2);
  border-radius: var(--r-sm);
  text-align: center;
}
.facts dt {
  color: var(--c-text-3);
  font-size: var(--t-xs);
}
.facts dd {
  margin-top: 2px;
  color: var(--c-text);
  font-size: var(--t-sm);
}
.facts dd[data-warn='true'] {
  color: var(--c-warn, #d08700);
  font-weight: 600;
}

.value {
  display: flex;
  align-items: center;
  gap: var(--s-2);
  font-size: var(--t-sm);
}
.hint {
  margin-top: var(--s-2);
  color: var(--c-text-3);
  font-size: var(--t-xs);
  line-height: 1.7;
}

.editor {
  width: 100%;
  padding: var(--s-3);
  background: var(--c-bg);
  border: 1px solid var(--c-border-strong);
  border-radius: var(--r-md);
  color: var(--c-text);
  font-family: inherit;
  font-size: var(--t-sm);
  line-height: 1.7;
  resize: vertical;
}
.editor:focus {
  outline: none;
  border-color: var(--c-brand);
  box-shadow: 0 0 0 3px var(--c-brand-soft);
}
.actions {
  display: flex;
  justify-content: flex-end;
  margin-top: var(--s-2);
}
.btn {
  min-height: 34px;
  padding: 0 var(--s-4);
  border: 1px solid var(--c-border-strong);
  border-radius: var(--r-md);
  background: transparent;
  color: var(--c-text);
  font-size: var(--t-sm);
  cursor: pointer;
}
.btn.primary {
  border-color: transparent;
  background: var(--c-brand);
  color: #fff;
}
.btn:disabled {
  opacity: 0.6;
  cursor: default;
}
.save-error {
  margin-top: var(--s-3);
  color: var(--c-err, #d9534f);
  font-size: var(--t-xs);
}

.rules,
.events {
  display: flex;
  flex-direction: column;
  gap: 4px;
  list-style: none;
}
.rules li,
.events li {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--s-2);
  padding: var(--s-2);
  border-radius: var(--r-sm);
  font-size: var(--t-xs);
}
.rules li[data-own='true'] {
  background: var(--c-brand-soft);
}
.rule-cond {
  color: var(--c-text);
}
.rule-facts {
  margin-left: auto;
  color: var(--c-text-3);
}
.rule-inherit {
  color: var(--c-text-3);
}

.tz-row {
  display: flex;
  flex-wrap: wrap;
  gap: var(--s-2);
}
.tz-input {
  flex: 1;
  min-width: 140px;
  min-height: 34px;
  padding: 0 var(--s-3);
  background: var(--c-bg);
  border: 1px solid var(--c-border-strong);
  border-radius: var(--r-md);
  color: var(--c-text);
  font-size: var(--t-sm);
}
.tz-input:focus {
  outline: none;
  border-color: var(--c-brand);
  box-shadow: 0 0 0 3px var(--c-brand-soft);
}
</style>
