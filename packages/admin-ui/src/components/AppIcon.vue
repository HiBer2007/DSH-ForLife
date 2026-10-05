<script setup lang="ts">
/**
 * 内联图标集。
 *
 * 为什么不装图标库：整包图标库动辄几百 KB，而我们一共用十几个。
 * 这里用 24×24 线性图标（`stroke: currentColor`），颜色跟随文字，深浅色都不用额外处理。
 */

/** 图标名 → SVG 路径。新增图标只需在这里加一行。 */
const PATHS: Record<string, string> = {
  overview: 'M4 13h6V4H4v9Zm0 7h6v-4H4v4Zm10 0h6v-9h-6v9Zm0-16v4h6V4h-6Z',
  chat: 'M21 12a8 8 0 0 1-8 8H8l-5 3 1.5-4.5A8 8 0 1 1 21 12Z',
  memory: 'M4 7c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3Zm0 0v10c0 1.7 3.6 3 8 3s8-1.3 8-3V7M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3',
  compaction: 'M4 6h16M4 12h16M4 18h10M18 16l2 2 2-2',
  routing: 'M4 6h5a4 4 0 0 1 4 4v4a4 4 0 0 0 4 4h3M4 18h5M18 3l3 3-3 3',
  prompt: 'M4 5h16v11H8l-4 4V5Zm4 4h8M8 12h5',
  endpoint: 'M12 3v6m0 6v6M5 12h6m6 0h6M9 9h6v6H9V9Z',
  media: 'M4 5h16v14H4V5Zm0 10 4-4 4 4 3-3 5 5M15 9h.01',
  storage: 'M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3v12c0 1.7-3.6 3-8 3s-8-1.3-8-3V6Zm0 6c0 1.7 3.6 3 8 3s8-1.3 8-3',
  logs: 'M4 4h16v16H4V4Zm4 5 3 3-3 3m5 1h4',
  settings:
    'M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Zm7.4-3.5a7.6 7.6 0 0 0-.1-1.2l2-1.5-2-3.4-2.3 1a7.7 7.7 0 0 0-2-1.2L14.6 3H9.4L9 5.7a7.7 7.7 0 0 0-2 1.2l-2.4-1-2 3.4 2 1.5a7.7 7.7 0 0 0 0 2.4l-2 1.5 2 3.4 2.4-1a7.7 7.7 0 0 0 2 1.2l.4 2.7h5.2l.4-2.7a7.7 7.7 0 0 0 2-1.2l2.3 1 2-3.4-2-1.5c.1-.4.1-.8.1-1.2Z',
  menu: 'M4 7h16M4 12h16M4 17h16',
  close: 'M6 6l12 12M18 6 6 18',
  sun: 'M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10Zm0-14v2m0 18v-2M3 12h2m14 0h2M5.6 5.6l1.4 1.4m10 10 1.4 1.4m0-12.8-1.4 1.4m-10 10-1.4 1.4',
  moon: 'M20 14.5A8.5 8.5 0 1 1 9.5 4a6.6 6.6 0 0 0 10.5 10.5Z',
  monitor: 'M4 5h16v11H4V5Zm4 14h8m-4-3v3',
  refresh: 'M20 12a8 8 0 1 1-2.3-5.6M20 4v5h-5',
  logout: 'M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 8l-4 4 4 4M6 12h9',
  warning: 'M12 4 2.5 20h19L12 4Zm0 6v5m0 3h.01',
  check: 'M4 12.5 9 17.5 20 6.5',
  info: 'M12 11v6m0-9h.01M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z',
  lock: 'M6 11h12v9H6v-9Zm3 0V8a3 3 0 0 1 6 0v3',
  external: 'M14 4h6v6M20 4l-8 8M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5',
}

const props = defineProps<{ readonly name: string; readonly size?: number | string }>()
const path = PATHS[props.name] ?? PATHS['info']!
</script>

<template>
  <svg
    :width="props.size ?? 18"
    :height="props.size ?? 18"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.6"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    <path :d="path" />
  </svg>
</template>
