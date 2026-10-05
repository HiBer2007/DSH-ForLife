<script setup lang="ts">
/**
 * 卡片容器 —— 页面的基本积木。
 *
 * 统一负责：标题行、右上角操作区、内边距、以及手机上的折行。
 * 页面里不要自己写 `<div class="card">`，否则圆角/边框/间距很快就各处不一致。
 */
defineProps<{
  readonly title?: string
  readonly subtitle?: string
  /** 去掉内边距（表格类内容要贴边）。 */
  readonly flush?: boolean
}>()
</script>

<template>
  <section class="card">
    <header v-if="title !== undefined || $slots.actions" class="head">
      <div class="titles">
        <h3 v-if="title !== undefined">{{ title }}</h3>
        <p v-if="subtitle !== undefined" class="muted sub">{{ subtitle }}</p>
      </div>
      <div v-if="$slots.actions" class="actions">
        <slot name="actions" />
      </div>
    </header>
    <div class="body" :data-flush="flush === true">
      <slot />
    </div>
  </section>
</template>

<style scoped>
.card {
  display: flex;
  flex-direction: column;
  min-width: 0;
  background: var(--c-surface);
  border: 1px solid var(--c-border);
  border-radius: var(--r-lg);
  overflow: hidden;
}

.head {
  display: flex;
  align-items: flex-start;
  gap: var(--s-3);
  padding: var(--s-4) var(--s-4) var(--s-3);
}
.titles {
  flex: 1;
  min-width: 0;
}
.head h3 {
  font-size: var(--t-base);
  font-weight: 600;
}
.sub {
  margin-top: 2px;
  font-size: var(--t-xs);
}
.actions {
  display: flex;
  align-items: center;
  gap: var(--s-2);
  flex: none;
}

.body {
  padding: 0 var(--s-4) var(--s-4);
  min-width: 0;
}
.body[data-flush='true'] {
  padding: 0;
}

/* 手机上标题与操作挤在一行会换行很丑，改成上下排列 */
@media (max-width: 560px) {
  .head {
    flex-wrap: wrap;
  }
  .actions {
    width: 100%;
  }
}
</style>
