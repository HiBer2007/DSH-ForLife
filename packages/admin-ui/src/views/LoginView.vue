<script setup lang="ts">
/**
 * 登录 / 首次设置口令。
 *
 * 两种形态共用一个界面，由服务端的 `needsSetup` 决定：
 *  - **首次设置**：库或配置里还没有口令哈希 → 设一次新口令（两次输入确认，够长度才让提交）；
 *  - **登录**：输入口令，错了就显示错误并保留输入焦点。
 *
 * 安全相关的取舍（见计划 §2.12）：
 *  - 口令**只**走 POST body，绝不进 URL（URL 会进日志、进 Referer、进浏览器历史）；
 *  - 会话令牌由服务端下发 HttpOnly cookie，前端不接触；
 *  - 失败次数由服务端限流，前端只负责把话说清楚。
 */
import { computed, nextTick, ref, useTemplateRef } from 'vue'

import AppIcon from '../components/AppIcon.vue'
import { useAuth } from '../composables/useAuth.ts'

const auth = useAuth()

const password = ref('')
const confirm = ref('')
const busy = ref(false)
const error = ref<string>()
const input = useTemplateRef<HTMLInputElement>('passwordInput')

const isSetup = computed(() => auth.needsSetup.value)
/** 设置口令时的最小长度，与服务端校验保持一致（服务端会再校验一次，前端只是提前告知）。 */
const MIN_LENGTH = 8
const tooShort = computed(() => isSetup.value && password.value.length > 0 && password.value.length < MIN_LENGTH)
const mismatch = computed(() => isSetup.value && confirm.value.length > 0 && password.value !== confirm.value)
const canSubmit = computed(() => {
  if (password.value === '' || busy.value) return false
  if (!isSetup.value) return true
  return password.value.length >= MIN_LENGTH && password.value === confirm.value
})

async function submit(): Promise<void> {
  if (!canSubmit.value) return
  busy.value = true
  error.value = undefined
  try {
    if (isSetup.value) await auth.setup(password.value)
    else await auth.login(password.value)
    password.value = ''
    confirm.value = ''
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : String(caught)
    password.value = ''
    await nextTick()
    input.value?.focus()
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="login">
    <form class="card" @submit.prevent="submit">
      <div class="head">
        <span class="mark" aria-hidden="true">DF</span>
        <div>
          <h1>{{ isSetup ? '设置管理口令' : '登录 DSH-ForLife 控制台' }}</h1>
          <p class="muted">
            {{ isSetup ? '这是第一次打开：请设置一个管理口令，之后用它登录。' : '输入管理口令后进入。' }}
          </p>
        </div>
      </div>

      <label class="field">
        <span class="label">口令</span>
        <input
          ref="passwordInput"
          v-model="password"
          type="password"
          name="password"
          autocomplete="current-password"
          :placeholder="isSetup ? `至少 ${MIN_LENGTH} 位` : '请输入口令'"
          :aria-invalid="tooShort || mismatch || error !== undefined"
          autofocus
        />
        <small v-if="tooShort" class="hint err">至少 {{ MIN_LENGTH }} 位</small>
      </label>

      <label v-if="isSetup" class="field">
        <span class="label">再输一次</span>
        <input v-model="confirm" type="password" name="confirm" autocomplete="new-password" placeholder="确认口令" />
        <small v-if="mismatch" class="hint err">两次输入不一致</small>
      </label>

      <p v-if="error" class="alert" role="alert">
        <AppIcon name="warning" :size="15" />
        <span>{{ error }}</span>
      </p>

      <button type="submit" class="submit" :disabled="!canSubmit">
        {{ busy ? '请稍候…' : isSetup ? '设置并进入' : '登录' }}
      </button>

      <p class="foot muted">
        <AppIcon name="lock" :size="13" />
        <span>口令经 scrypt 加盐哈希后存储；会话用 HttpOnly cookie，前端拿不到令牌。</span>
      </p>
    </form>
  </div>
</template>

<style scoped>
.login {
  display: grid;
  place-items: center;
  min-height: 100dvh;
  padding: var(--s-5);
  padding-top: max(var(--s-5), env(safe-area-inset-top));
  padding-bottom: max(var(--s-5), env(safe-area-inset-bottom));
  background:
    radial-gradient(1200px 600px at 50% -10%, var(--c-brand-soft), transparent 70%),
    var(--c-bg);
}

.card {
  display: flex;
  flex-direction: column;
  gap: var(--s-4);
  width: 100%;
  max-width: 400px;
  padding: var(--s-6);
  background: var(--c-surface);
  border: 1px solid var(--c-border);
  border-radius: var(--r-xl);
  box-shadow: var(--sh-2);
}

.head {
  display: flex;
  align-items: flex-start;
  gap: var(--s-3);
}
.head h1 {
  font-size: var(--t-lg);
  margin-bottom: 2px;
}
.head p {
  font-size: var(--t-sm);
}
.mark {
  display: grid;
  place-items: center;
  flex: none;
  width: 38px;
  height: 38px;
  border-radius: var(--r-md);
  background: var(--c-brand);
  color: #fff;
  font-size: var(--t-xs);
  font-weight: 700;
}

.field {
  display: flex;
  flex-direction: column;
  gap: var(--s-2);
}
.label {
  font-size: var(--t-sm);
  color: var(--c-text-2);
  font-weight: 500;
}
input {
  /* 44px：手机上输入框太矮会误触 */
  height: var(--touch-min);
  padding: 0 var(--s-3);
  background: var(--c-bg);
  border: 1px solid var(--c-border-strong);
  border-radius: var(--r-md);
  outline: none;
  transition: border-color var(--dur-fast) var(--ease), box-shadow var(--dur-fast) var(--ease);
}
input:focus {
  border-color: var(--c-brand);
  box-shadow: 0 0 0 3px var(--c-brand-soft);
}
input[aria-invalid='true'] {
  border-color: var(--c-err);
}
.hint {
  font-size: var(--t-xs);
}
.err {
  color: var(--c-err);
}

.alert {
  display: flex;
  align-items: flex-start;
  gap: var(--s-2);
  padding: var(--s-3);
  border-radius: var(--r-md);
  background: var(--c-err-soft);
  color: var(--c-err);
  font-size: var(--t-sm);
}

.submit {
  height: var(--touch-min);
  border: none;
  border-radius: var(--r-md);
  background: var(--c-brand);
  color: #fff;
  font-size: var(--t-md);
  font-weight: 600;
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease);
}
.submit:hover:not(:disabled) {
  background: var(--c-brand-hover);
}
.submit:disabled {
  opacity: 0.5;
  cursor: default;
}

.foot {
  display: flex;
  align-items: flex-start;
  gap: var(--s-2);
  font-size: var(--t-xs);
  line-height: 1.5;
}
</style>
