<script setup lang="ts">
/**
 * 异步区块的统一外壳：加载 / 失败 / 空 / 正常 四态。
 *
 * 为什么要有它：每个页面都手写这四态，必然出现"某页失败时一片空白"这种最难查的情况。
 * 这里把失败**必须显示原因与重试**这件事固定下来。
 */
import AppIcon from './AppIcon.vue'

defineProps<{
  readonly loading: boolean
  readonly error?: string | undefined
  /** 数据到了但内容为空（例如"还没有记录"）。 */
  readonly empty?: boolean
  readonly emptyText?: string
  /** 上次成功刷新时间（毫秒时间戳）。 */
  readonly updatedAt?: number | undefined
  /** 首次加载时用骨架屏（比转圈更少跳动）。 */
  readonly skeletonRows?: number
}>()

const emit = defineEmits<{ readonly retry: [] }>()

function formatTime(at: number | undefined): string {
  if (at === undefined) return ''
  const diff = Date.now() - at
  if (diff < 5000) return '刚刚更新'
  if (diff < 60_000) return `${Math.round(diff / 1000)} 秒前更新`
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)} 分钟前更新`
  return new Date(at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}
</script>

<template>
  <!-- 首次加载：骨架屏，避免高度从 0 跳到大块内容 -->
  <div v-if="loading && updatedAt === undefined" class="skeleton" aria-busy="true" aria-live="polite">
    <div v-for="row in skeletonRows ?? 3" :key="row" class="skeleton-row" />
    <span class="visually-hidden">正在加载…</span>
  </div>

  <!-- 失败：必须说清楚原因，并给重试 -->
  <div v-else-if="error !== undefined" class="state err" role="alert">
    <AppIcon name="warning" :size="18" />
    <div class="state-body">
      <strong>读取失败</strong>
      <p>{{ error }}</p>
    </div>
    <button type="button" class="retry" @click="emit('retry')">重试</button>
  </div>

  <!-- 空 -->
  <div v-else-if="empty === true" class="state">
    <AppIcon name="info" :size="18" />
    <div class="state-body">
      <p>{{ emptyText ?? '暂无数据' }}</p>
    </div>
  </div>

  <!-- 正常 -->
  <template v-else>
    <div v-if="loading" class="refreshing" aria-live="polite">
      <span class="dot" />
      <span class="muted">正在刷新…</span>
    </div>
    <slot />
    <p v-if="updatedAt !== undefined" class="stamp muted">{{ formatTime(updatedAt) }}</p>
  </template>
</template>

<style scoped>
.skeleton {
  display: flex;
  flex-direction: column;
  gap: var(--s-3);
  padding: var(--s-2) 0;
}
.skeleton-row {
  height: 18px;
  border-radius: var(--r-sm);
  background: linear-gradient(90deg, var(--c-surface-2), var(--c-surface-3), var(--c-surface-2));
  background-size: 200% 100%;
  animation: shimmer 1.3s ease-in-out infinite;
}
@keyframes shimmer {
  from {
    background-position: 200% 0;
  }
  to {
    background-position: -200% 0;
  }
}

.state {
  display: flex;
  align-items: flex-start;
  gap: var(--s-3);
  padding: var(--s-4);
  border-radius: var(--r-md);
  background: var(--c-surface-2);
  color: var(--c-text-2);
}
.state.err {
  background: var(--c-err-soft);
  color: var(--c-err);
}
.state-body {
  flex: 1;
  min-width: 0;
}
.state-body strong {
  display: block;
  margin-bottom: 2px;
}
.state-body p {
  font-size: var(--t-sm);
  word-break: break-word;
}
.retry {
  flex: none;
  min-height: 32px;
  padding: 0 var(--s-3);
  border: 1px solid currentColor;
  border-radius: var(--r-md);
  background: transparent;
  color: inherit;
  cursor: pointer;
  font-size: var(--t-sm);
}

.refreshing {
  display: flex;
  align-items: center;
  gap: var(--s-2);
  margin-bottom: var(--s-3);
  font-size: var(--t-xs);
}
.dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--c-brand);
  animation: pulse 1s ease-in-out infinite alternate;
}
@keyframes pulse {
  from {
    opacity: 0.3;
  }
  to {
    opacity: 1;
  }
}

.stamp {
  margin-top: var(--s-3);
  font-size: var(--t-xs);
  text-align: right;
}
</style>
