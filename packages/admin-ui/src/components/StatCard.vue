<script setup lang="ts">
/**
 * 指标卡：一个大数字 + 标签 + 可选说明。
 *
 * `tone` 只影响强调色，用来表达"这个数字是好是坏"；
 * `value` 为 undefined 时显示占位符而不是 "undefined"（宁可显示"—"）。
 */
import AppIcon from './AppIcon.vue'

defineProps<{
  readonly label: string
  readonly value: string | number | undefined
  readonly hint?: string
  readonly tone?: 'neutral' | 'ok' | 'warn' | 'err' | 'brand'
  readonly icon?: string
}>()
</script>

<template>
  <div class="stat" :data-tone="tone ?? 'neutral'">
    <div class="top">
      <span class="label">{{ label }}</span>
      <AppIcon v-if="icon !== undefined" :name="icon" :size="15" class="icon" />
    </div>
    <div class="value">{{ value === undefined || value === '' ? '—' : value }}</div>
    <div v-if="hint !== undefined" class="hint">{{ hint }}</div>
  </div>
</template>

<style scoped>
.stat {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  padding: var(--s-4);
  background: var(--c-surface);
  border: 1px solid var(--c-border);
  border-radius: var(--r-lg);
}
.top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--s-2);
}
.label {
  color: var(--c-text-3);
  font-size: var(--t-xs);
  font-weight: 500;
}
.icon {
  color: var(--c-text-3);
}
.value {
  font-size: var(--t-xl);
  font-weight: 650;
  line-height: 1.2;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.hint {
  color: var(--c-text-3);
  font-size: var(--t-xs);
  line-height: 1.4;
}

.stat[data-tone='brand'] .value {
  color: var(--c-brand);
}
.stat[data-tone='ok'] .value {
  color: var(--c-ok);
}
.stat[data-tone='warn'] .value {
  color: var(--c-warn);
}
.stat[data-tone='err'] .value {
  color: var(--c-err);
}
.stat[data-tone='brand'] .icon,
.stat[data-tone='ok'] .icon {
  color: var(--c-ok);
}
.stat[data-tone='warn'] .icon {
  color: var(--c-warn);
}
.stat[data-tone='err'] .icon {
  color: var(--c-err);
}
</style>
