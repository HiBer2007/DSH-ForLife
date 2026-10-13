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
    <!--
      ★ 2026-10-09 修（用户报的"顶部冒出一个刷新元素、一闪而过、界面跳动"）：

      **根因就是这个 `v-if`**。它以前写的是 `<div v-if="loading" class="refreshing">` ——
      轮询每来一次（总览 `/overview` 15 秒、`/series` 60 秒）这个 div 就**进入/离开文档流**，
      把下面所有内容整体顶下去 `高度 + margin-bottom`（约 30px），请求回来又弹回去。
      界面上就是"顶部闪一下、整页抖一下"；页面上有两个 AsyncSection 时抖两次。

      **修法不是删掉它**（用户要的是"别跳"，不是"别显示"）：
      元素**永远留在文档流里**并占住固定高度，只用 `visibility` 切换可见性 ——
      `visibility: hidden` 的元素**照样占位**，所以有无提示时布局完全一致，一次重排都没有。
      （`display: none` / `v-if` 都会撤掉占位，正是要避免的。）
    -->
    <div class="refresh-slot" :data-active="loading" aria-hidden="true">
      <span class="dot" />
      <span class="muted">正在刷新…</span>
    </div>
    <!--
      读屏用的实时状态：**内容在变**才会被播报（`role="status"` = polite live region）。
      上面那个可见的提示只是装饰，所以整块 `aria-hidden`，免得同一句话被念两遍。
      `visually-hidden` 是 `position: absolute` 的 1×1 元素 ⇒ 不参与文档流，也就不破坏这里的"不跳"。
    -->
    <span class="visually-hidden" role="status">{{ loading ? '正在刷新…' : '' }}</span>
    <slot />
    <p class="stamp muted" :data-visible="updatedAt !== undefined">
      {{ updatedAt === undefined ? '' : formatTime(updatedAt) }}
    </p>
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

/*
 * ── 刷新提示的**固定占位**（2026-10-09 修"面板刷新时跳动"）──────────────────
 *
 * 这个元素**始终参与布局**，只有可见性在变。要点两条，缺一不可：
 *  ① `visibility: hidden`（**不是** `display: none`、更不是 `v-if`）——
 *     前者照样占位，后两者会把位子一起撤掉 ⇒ 下面的内容整体上移/下移；
 *  ② 高度**写死**（16px = 一行 12px 文字 + 一点余量，由内部的 `line-height: 1` 保证
 *     内容不会把它撑高）—— 只要高度随内容变，就还是一次重排。
 *
 * 于是"正在刷新…"出现/消失时，下面所有卡片的位置**一个像素都不动**。
 */
.refresh-slot {
  display: flex;
  align-items: center;
  gap: var(--s-2);
  height: 16px;
  margin-bottom: var(--s-3);
  font-size: var(--t-xs);
  line-height: 1;
  visibility: hidden;
}
.refresh-slot[data-active='true'] {
  visibility: visible;
}
.dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--c-brand);
}
/* 动画只在"真的在刷新"时挂上：不可见时没必要让时钟一直转 */
.refresh-slot[data-active='true'] .dot {
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

/*
 * 底部那行"最后更新于…"同理：它以前是 `v-if="updatedAt !== undefined"`，
 * 首次成功时凭空多出一行，页面高度会跳一次。现在**永远占一行**，用可见性切换。
 */
.stamp {
  min-height: calc(var(--t-xs) * var(--lh-tight));
  margin-top: var(--s-3);
  font-size: var(--t-xs);
  text-align: right;
  font-variant-numeric: tabular-nums;
  visibility: hidden;
}
.stamp[data-visible='true'] {
  visibility: visible;
}
</style>
