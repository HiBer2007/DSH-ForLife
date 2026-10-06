<script setup lang="ts">
/**
 * 状态徽标 —— 一处定义语义色，全站统一。
 *
 * 为什么不让各页自己写颜色：一旦"降级"在 A 页是黄色、B 页是红色，
 * 人对颜色的直觉就失效了。语义 → 颜色的映射必须只有一份。
 */
withDefaults(
  defineProps<{
    /** 语义：ok 正常 / warn 需要注意 / err 异常 / info 中性信息 / muted 次要。 */
    readonly tone?: 'ok' | 'warn' | 'err' | 'info' | 'muted'
    /** 前置小圆点（用于状态）。 */
    readonly dot?: boolean
    readonly mono?: boolean
  }>(),
  { tone: 'muted', dot: false, mono: false },
)
</script>

<template>
  <span class="badge" :data-tone="tone" :class="{ mono }">
    <i v-if="dot" aria-hidden="true" />
    <slot />
  </span>
</template>

<style scoped>
.badge {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 1px 8px;
  border-radius: var(--r-full);
  background: var(--c-surface-2);
  color: var(--c-text-2);
  font-size: var(--t-xs);
  font-weight: 500;
  white-space: nowrap;
}
.badge.mono {
  font-family: var(--font-mono);
  font-size: 0.92em;
}
.badge i {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
}

.badge[data-tone='ok'] {
  background: var(--c-ok-soft);
  color: var(--c-ok);
}
.badge[data-tone='warn'] {
  background: var(--c-warn-soft);
  color: var(--c-warn);
}
.badge[data-tone='err'] {
  background: var(--c-err-soft);
  color: var(--c-err);
}
.badge[data-tone='info'] {
  background: var(--c-brand-soft);
  color: var(--c-brand);
}
</style>
