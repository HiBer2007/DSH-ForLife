<script setup lang="ts">
/**
 * 运行图表：面积图 / 柱状图，纯 SVG 手写。
 *
 * 为什么不引图表库：整库动辄几百 KB，而这里只需要"按小时看趋势 + 悬停读数"。
 * 手写还能保证：颜色全部走设计令牌（深浅色自动适配）、手机上能用手指点读数。
 *
 * 几个刻意的决定：
 *  - **空桶补零**由数据层负责；这里对"整段全空"显示明确的空状态，而不是画一条贴底的线
 *    （贴底的线会被误读成"一直是 0，系统正常"）；
 *  - `null` 表示**没有数据**，与 0 区分：折线在 null 处断开，而不是掉到 0 —— 否则
 *    一次"没有调用"会被画成"命中率暴跌到 0"；
 *  - 悬停/触摸用同一条交互路径：手机上手指按下即显示读数，松手隐藏。
 */
import { computed, ref } from 'vue'

import { useElementSize } from '../composables/useElementSize.ts'

/** 一条序列。 */
export interface ChartSeries {
  readonly name: string
  readonly values: readonly (number | null)[]
  /** 取色令牌：1..6（对应 --c-1 … --c-6）。 */
  readonly tone?: number
}

const props = withDefaults(
  defineProps<{
    readonly buckets: readonly string[]
    readonly series: readonly ChartSeries[]
    readonly kind?: 'area' | 'bar'
    readonly height?: number
    /** 数值格式：count（整数）| tokens（k 缩写）| percent（0..1 → %）。 */
    readonly unit?: 'count' | 'tokens' | 'percent'
  }>(),
  { kind: 'area', height: 160, unit: 'count' },
)

const { element, width } = useElementSize<HTMLDivElement>()
const hoverIndex = ref<number | null>(null)

const PAD = { top: 12, right: 10, bottom: 20, left: 46 }
const plotWidth = computed(() => Math.max(10, width.value - PAD.left - PAD.right))
const plotHeight = computed(() => Math.max(10, props.height - PAD.top - PAD.bottom))

/** 是否整段都没有数据（全 null 或全 0）。 */
const isEmpty = computed(() => props.series.every((s) => s.values.every((v) => v === null || v === 0)))

/** Y 轴上界：取整到"好看"的刻度，避免出现 37.4 这种标签。 */
const yMax = computed(() => {
  let max = 0
  for (const s of props.series) {
    for (const v of s.values) if (v !== null && v > max) max = v
  }
  if (max <= 0) return 1
  const magnitude = 10 ** Math.floor(Math.log10(max))
  const normalized = max / magnitude
  const nice = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 2.5 ? 2.5 : normalized <= 5 ? 5 : 10
  return nice * magnitude
})

/** 网格与刻度（4 条横线）。 */
const gridLines = computed(() => {
  const lines: { y: number; label: string }[] = []
  for (let i = 0; i <= 4; i += 1) {
    const ratio = i / 4
    lines.push({ y: PAD.top + plotHeight.value * (1 - ratio), label: formatValue(yMax.value * ratio) })
  }
  return lines
})

function formatValue(value: number): string {
  if (props.unit === 'percent') return `${Math.round(value * 100)}%`
  if (props.unit === 'tokens') {
    if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
    if (value >= 1000) return `${(value / 1000).toFixed(value >= 10_000 ? 0 : 1)}k`
    return String(Math.round(value))
  }
  return value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(Math.round(value))
}

/** 一个值 → 像素 y。 */
function toY(value: number): number {
  return PAD.top + plotHeight.value * (1 - value / yMax.value)
}

/** 一个下标 → 像素 x（取桶中心）。 */
function toX(index: number): number {
  const count = Math.max(1, props.buckets.length)
  const step = plotWidth.value / count
  return PAD.left + step * (index + 0.5)
}

/** 折线路径；`null` 处断开。 */
function linePath(values: readonly (number | null)[]): string {
  let path = ''
  let penDown = false
  values.forEach((value, index) => {
    if (value === null) {
      penDown = false
      return
    }
    path += `${penDown ? 'L' : 'M'}${toX(index).toFixed(1)},${toY(value).toFixed(1)} `
    penDown = true
  })
  return path.trim()
}

/** 面积路径（闭合到底边）。 */
function areaPath(values: readonly (number | null)[]): string {
  const line = linePath(values)
  if (line === '') return ''
  const first = values.findIndex((v) => v !== null)
  const last = values.length - 1 - [...values].reverse().findIndex((v) => v !== null)
  return `${line} L${toX(last).toFixed(1)},${(PAD.top + plotHeight.value).toFixed(1)} L${toX(first).toFixed(1)},${(PAD.top + plotHeight.value).toFixed(1)} Z`
}

/** 柱宽。 */
const barWidth = computed(() => {
  const step = plotWidth.value / Math.max(1, props.buckets.length)
  return Math.max(1.5, step * (props.series.length > 1 ? 0.34 : 0.62))
})

/** X 轴标签：最多 6 个，均匀取样。 */
const xLabels = computed(() => {
  const total = props.buckets.length
  if (total === 0) return []
  const wanted = Math.min(6, total)
  const stride = Math.max(1, Math.floor(total / wanted))
  const labels: { x: number; text: string }[] = []
  for (let i = 0; i < total; i += stride) {
    const bucket = props.buckets[i]
    if (bucket === undefined) continue
    const date = new Date(bucket)
    labels.push({
      x: toX(i),
      text: `${String(date.getHours()).padStart(2, '0')}:00`,
    })
  }
  return labels
})

/** 悬停时显示的读数。 */
const hovered = computed(() => {
  const index = hoverIndex.value
  if (index === null) return undefined
  const bucket = props.buckets[index]
  if (bucket === undefined) return undefined
  const date = new Date(bucket)
  return {
    index,
    x: toX(index),
    title: `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:00`,
    rows: props.series.map((s) => ({
      name: s.name,
      tone: s.tone ?? 1,
      text: s.values[index] === null || s.values[index] === undefined ? '无数据' : formatValue(s.values[index] as number),
    })),
  }
})

/** 触摸/鼠标 → 最近的桶下标。 */
function onPointer(event: PointerEvent): void {
  const target = element.value
  if (target === undefined) return
  const rect = target.getBoundingClientRect()
  const x = event.clientX - rect.left
  const step = plotWidth.value / Math.max(1, props.buckets.length)
  const index = Math.floor((x - PAD.left) / step)
  hoverIndex.value = index >= 0 && index < props.buckets.length ? index : null
}
</script>

<template>
  <div class="chart">
    <div v-if="series.length > 1" class="legend">
      <span v-for="s in series" :key="s.name" class="legend-item">
        <i :style="{ background: `var(--c-${s.tone ?? 1})` }" />
        {{ s.name }}
      </span>
    </div>

    <div
      ref="element"
      class="canvas"
      :style="{ height: `${height}px` }"
      @pointermove="onPointer"
      @pointerdown="onPointer"
      @pointerleave="hoverIndex = null"
      @pointerup="hoverIndex = null"
    >
      <div v-if="isEmpty" class="empty">
        <span>这段时间还没有数据</span>
      </div>

      <svg v-else :width="width" :height="height" role="img">
        <defs>
          <linearGradient v-for="(s, i) in series" :id="`grad-${i}`" :key="s.name" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" :stop-color="`var(--c-${s.tone ?? 1})`" stop-opacity="0.28" />
            <stop offset="100%" :stop-color="`var(--c-${s.tone ?? 1})`" stop-opacity="0.02" />
          </linearGradient>
        </defs>

        <!-- 网格与 Y 轴刻度 -->
        <g class="grid">
          <line
            v-for="line in gridLines"
            :key="line.y"
            :x1="PAD.left"
            :x2="PAD.left + plotWidth"
            :y1="line.y"
            :y2="line.y"
          />
          <text v-for="line in gridLines" :key="`t-${line.y}`" :x="PAD.left - 8" :y="line.y + 3" text-anchor="end">
            {{ line.label }}
          </text>
        </g>

        <!-- 数据 -->
        <template v-if="kind === 'bar'">
          <template v-for="(s, si) in series" :key="s.name">
            <rect
              v-for="(value, index) in s.values"
              :key="`${si}-${index}`"
              :x="toX(index) - (series.length > 1 ? barWidth * series.length / 2 - si * barWidth : barWidth / 2)"
              :y="value === null ? PAD.top + plotHeight : toY(value)"
              :width="barWidth"
              :height="value === null ? 0 : PAD.top + plotHeight - toY(value)"
              :fill="`var(--c-${s.tone ?? 1})`"
              rx="2"
            />
          </template>
        </template>
        <template v-else>
          <template v-for="(s, si) in series" :key="s.name">
            <path :d="areaPath(s.values)" :fill="`url(#grad-${si})`" />
            <path :d="linePath(s.values)" fill="none" :stroke="`var(--c-${s.tone ?? 1})`" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round" />
          </template>
        </template>

        <!-- X 轴标签 -->
        <g class="axis">
          <text v-for="label in xLabels" :key="label.x" :x="label.x" :y="height - 6" text-anchor="middle">
            {{ label.text }}
          </text>
        </g>

        <!-- 悬停十字线与读数点 -->
        <g v-if="hovered" class="hover">
          <line :x1="hovered.x" :x2="hovered.x" :y1="PAD.top" :y2="PAD.top + plotHeight" />
          <circle
            v-for="(s, si) in series"
            :key="si"
            :cx="hovered.x"
            :cy="s.values[hovered.index] === null || s.values[hovered.index] === undefined ? 0 : toY(s.values[hovered.index] as number)"
            r="3.5"
            :fill="`var(--c-${s.tone ?? 1})`"
            :opacity="s.values[hovered.index] === null || s.values[hovered.index] === undefined ? 0 : 1"
          />
        </g>
      </svg>

      <!-- 读数气泡：放在 DOM 里而不是 SVG 里，方便换行与圆角 -->
      <div v-if="hovered" class="tooltip" :style="{ left: `${Math.min(Math.max(hovered.x, 70), Math.max(70, width - 70))}px` }">
        <strong>{{ hovered.title }}</strong>
        <span v-for="row in hovered.rows" :key="row.name" class="tooltip-row">
          <i :style="{ background: `var(--c-${row.tone})` }" />
          {{ row.name }}
          <b>{{ row.text }}</b>
        </span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.chart {
  display: flex;
  flex-direction: column;
  gap: var(--s-2);
  min-width: 0;
}

.legend {
  display: flex;
  flex-wrap: wrap;
  gap: var(--s-3);
  font-size: var(--t-xs);
  color: var(--c-text-3);
}
.legend-item {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}
.legend-item i {
  width: 9px;
  height: 9px;
  border-radius: 2px;
}

.canvas {
  position: relative;
  width: 100%;
  min-width: 0;
  /* 手机上用手指拖动看图时不要触发页面滚动 */
  touch-action: pan-y;
}

.empty {
  display: grid;
  place-items: center;
  height: 100%;
  color: var(--c-text-3);
  font-size: var(--t-sm);
}

.grid line {
  stroke: var(--c-border);
  stroke-width: 1;
}
.grid text,
.axis text {
  fill: var(--c-text-3);
  font-size: 10px;
  font-variant-numeric: tabular-nums;
}

.hover line {
  stroke: var(--c-border-strong);
  stroke-width: 1;
  stroke-dasharray: 3 3;
}

.tooltip {
  position: absolute;
  top: 4px;
  transform: translateX(-50%);
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 6px 8px;
  border-radius: var(--r-sm);
  background: var(--c-surface);
  border: 1px solid var(--c-border-strong);
  box-shadow: var(--sh-2);
  font-size: var(--t-xs);
  pointer-events: none;
  white-space: nowrap;
  z-index: 2;
}
.tooltip strong {
  color: var(--c-text);
  font-weight: 600;
}
.tooltip-row {
  display: flex;
  align-items: center;
  gap: 5px;
  color: var(--c-text-3);
}
.tooltip-row i {
  width: 8px;
  height: 8px;
  border-radius: 2px;
}
.tooltip-row b {
  margin-left: auto;
  color: var(--c-text);
  font-variant-numeric: tabular-nums;
}
</style>
