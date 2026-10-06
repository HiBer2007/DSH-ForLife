<script setup lang="ts">
/**
 * 设置页：外观 / 会话 / 安全 / 关于。
 *
 * 放在这里的都是"全局且不常改"的东西。日常运维动作（重发消息、切模型…）各自归到对应页面，
 * 不要往设置页堆 —— 那样设置页很快会变成杂物间。
 */
import { computed, nextTick, ref, useTemplateRef } from 'vue'

import { api } from '../api/client.ts'
import AppIcon from '../components/AppIcon.vue'
import PanelCard from '../components/PanelCard.vue'
import ThemeControl from '../components/ThemeControl.vue'
import { useAuth } from '../composables/useAuth.ts'
import { formatDateTime } from '../utils/format.ts'

const auth = useAuth()

const expiresAt = computed(() => formatDateTime(auth.identity.value.expiresAt))

// ── 修改口令 ──────────────────────────────────────────────────
const current = ref('')
const next = ref('')
const confirm = ref('')
const busy = ref(false)
const notice = ref<{ tone: 'ok' | 'err'; text: string }>()
const currentInput = useTemplateRef<HTMLInputElement>('currentInput')

const MIN_LENGTH = 8
const canSubmit = computed(
  () =>
    !busy.value &&
    current.value !== '' &&
    next.value.length >= MIN_LENGTH &&
    next.value === confirm.value,
)

async function changePassword(): Promise<void> {
  if (!canSubmit.value) return
  busy.value = true
  notice.value = undefined
  try {
    await api.post('/password', { current: current.value, next: next.value })
    notice.value = { tone: 'ok', text: '口令已更新，其它设备上的会话已失效。' }
    current.value = ''
    next.value = ''
    confirm.value = ''
  } catch (error) {
    notice.value = { tone: 'err', text: error instanceof Error ? error.message : String(error) }
    current.value = ''
    await nextTick()
    currentInput.value?.focus()
  } finally {
    busy.value = false
  }
}

async function logout(): Promise<void> {
  await auth.logout()
}
</script>

<template>
  <div class="settings">
    <PanelCard title="外观" subtitle="主题会保存在这台设备上；跟随系统时随系统自动切换">
      <ThemeControl />
      <p class="muted note">
        深色模式覆盖全部界面元素（包括图表与表格），不是简单反色；手机端会自动收窄布局并把侧栏收成抽屉。
      </p>
    </PanelCard>

    <PanelCard title="会话" subtitle="当前登录状态">
      <dl class="kv">
        <div>
          <dt>状态</dt>
          <dd>
            <span class="pill ok">已登录</span>
          </dd>
        </div>
        <div>
          <dt>有效期至</dt>
          <dd>{{ expiresAt }}</dd>
        </div>
      </dl>
      <div class="actions">
        <button type="button" class="btn" @click="logout">
          <AppIcon name="logout" :size="15" />
          <span>退出登录</span>
        </button>
      </div>
    </PanelCard>

    <PanelCard title="安全" subtitle="修改管理口令">
      <form class="form" @submit.prevent="changePassword">
        <label class="field">
          <span>当前口令</span>
          <input ref="currentInput" v-model="current" type="password" autocomplete="current-password" />
        </label>
        <label class="field">
          <span>新口令</span>
          <input v-model="next" type="password" autocomplete="new-password" :placeholder="`至少 ${MIN_LENGTH} 位`" />
        </label>
        <label class="field">
          <span>再输一次</span>
          <input v-model="confirm" type="password" autocomplete="new-password" />
        </label>

        <p v-if="next.length > 0 && next.length < MIN_LENGTH" class="hint err">新口令至少 {{ MIN_LENGTH }} 位</p>
        <p v-else-if="confirm.length > 0 && next !== confirm" class="hint err">两次输入不一致</p>

        <p v-if="notice" class="hint" :class="notice.tone === 'ok' ? 'ok' : 'err'">
          {{ notice.text }}
        </p>

        <button type="submit" class="btn primary" :disabled="!canSubmit">
          {{ busy ? '提交中…' : '修改口令' }}
        </button>
        <p class="muted note">
          口令用 scrypt 加盐哈希后存库，明文不落盘；改口令会使**其它设备**上的会话立即失效，当前设备会重新登录。
        </p>
      </form>
    </PanelCard>

    <PanelCard title="关于" subtitle="这个面板是什么">
      <p class="muted note">
        这是 forlife 的**主管理后台**，由 gateway 直接提供（单进程单端口），
        数据来自同一个 SQLite —— 与 DSH 会话里内嵌的那套面板共享同一份数据，不存在第二套真源。
      </p>
      <p class="muted note">
        公网只暴露 <span class="mono">/admin</span>（本面板，自带鉴权）与显式发布的服务；
        DSH 官方 Web UI、OneBot 端口、Caddy Admin API 都不对外。
      </p>
    </PanelCard>
  </div>
</template>

<style scoped>
.settings {
  display: flex;
  flex-direction: column;
  gap: var(--s-4);
  max-width: 720px;
}

.note {
  margin-top: var(--s-3);
  font-size: var(--t-xs);
  line-height: 1.6;
}

.kv {
  display: flex;
  flex-direction: column;
  gap: var(--s-2);
}
.kv > div {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--s-3);
}
.kv dt {
  color: var(--c-text-3);
  font-size: var(--t-xs);
}
.kv dd {
  color: var(--c-text-2);
}

.pill {
  padding: 1px 8px;
  border-radius: var(--r-full);
  font-size: var(--t-xs);
  font-weight: 600;
}
.pill.ok {
  background: var(--c-ok-soft);
  color: var(--c-ok);
}

.actions {
  display: flex;
  gap: var(--s-2);
  margin-top: var(--s-4);
}

.form {
  display: flex;
  flex-direction: column;
  gap: var(--s-3);
}
.field {
  display: flex;
  flex-direction: column;
  gap: var(--s-2);
}
.field > span {
  color: var(--c-text-2);
  font-size: var(--t-sm);
  font-weight: 500;
}
.field input {
  height: var(--touch-min);
  padding: 0 var(--s-3);
  background: var(--c-bg);
  border: 1px solid var(--c-border-strong);
  border-radius: var(--r-md);
  outline: none;
}
.field input:focus {
  border-color: var(--c-brand);
  box-shadow: 0 0 0 3px var(--c-brand-soft);
}

.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--s-2);
  align-self: flex-start;
  min-height: 38px;
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
.btn.primary:hover:not(:disabled) {
  background: var(--c-brand-hover);
}
.btn:disabled {
  opacity: 0.5;
  cursor: default;
}

.hint {
  font-size: var(--t-xs);
}
.hint.err {
  color: var(--c-err);
}
.hint.ok {
  color: var(--c-ok);
}
</style>
