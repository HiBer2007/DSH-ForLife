<script setup lang="ts">
/**
 * 数据表 —— 桌面端是表格，手机端自动变成卡片。
 *
 * 为什么不直接 `<table>`：手机屏上横向滚动的表格是最难用的一种界面
 * （要么被压缩成不可读，要么要左右拖）。这里用同一份列定义渲染两种形态，
 * 由 CSS 在 `<720px` 处切换，**数据与逻辑只有一份**。
 *
 * 列定义里的 `primary: true` 表示"这列是这条记录的身份"，手机上会作为卡片标题。
 */
export interface TableColumn<T> {
  readonly key: string
  readonly label: string
  /** 手机端作为卡片标题的列。 */
  readonly primary?: boolean
  /** 手机端副标题（通常是时间或会话）。 */
  readonly secondary?: boolean
  /** 右对齐（数字列）。 */
  readonly numeric?: boolean
  /** 等宽字体（ID、路径、模型名）。 */
  readonly mono?: boolean
  /** 窄列（状态、计数）。 */
  readonly narrow?: boolean
  /** 取值；不传则按 key 取。 */
  readonly value?: (row: T) => string | number | null | undefined
}

const props = withDefaults(
  defineProps<{
    readonly columns: readonly TableColumn<Record<string, unknown>>[]
    readonly rows: readonly Record<string, unknown>[]
    /** 行主键字段。 */
    readonly rowKey?: string
    /** 空数据时的说明。 */
    readonly emptyText?: string
    /** 行数上限（超出只提示，不静默截断）。 */
    readonly limit?: number
  }>(),
  { rowKey: 'id', emptyText: '没有数据', limit: 0 },
)

function cell(row: Record<string, unknown>, column: TableColumn<Record<string, unknown>>): string {
  const raw = column.value !== undefined ? column.value(row) : row[column.key]
  if (raw === null || raw === undefined) return '—'
  return String(raw)
}

function keyOf(row: Record<string, unknown>, index: number): string {
  const value = row[props.rowKey]
  return value === null || value === undefined ? String(index) : String(value)
}
</script>

<template>
  <div class="table-wrap">
    <p v-if="rows.length === 0" class="empty">{{ emptyText }}</p>

    <template v-else>
      <!-- 桌面：表格 -->
      <table class="table">
        <thead>
          <tr>
            <th
              v-for="column in columns"
              :key="column.key"
              :class="{ numeric: column.numeric, narrow: column.narrow }"
            >
              {{ column.label }}
            </th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(row, index) in rows" :key="keyOf(row, index)">
            <td
              v-for="column in columns"
              :key="column.key"
              :class="{ numeric: column.numeric, narrow: column.narrow, mono: column.mono }"
              :title="cell(row, column)"
            >
              {{ cell(row, column) }}
            </td>
          </tr>
        </tbody>
      </table>

      <!-- 手机：卡片 -->
      <ul class="cards">
        <li v-for="(row, index) in rows" :key="keyOf(row, index)">
          <div class="card-head">
            <span
              v-for="column in columns.filter((c) => c.primary)"
              :key="column.key"
              class="card-title"
              :class="{ mono: column.mono }"
            >
              {{ cell(row, column) }}
            </span>
            <span
              v-for="column in columns.filter((c) => c.secondary)"
              :key="column.key"
              class="card-sub"
            >
              {{ cell(row, column) }}
            </span>
          </div>
          <dl class="card-body">
            <div v-for="column in columns.filter((c) => !c.primary && !c.secondary)" :key="column.key">
              <dt>{{ column.label }}</dt>
              <dd :class="{ mono: column.mono, numeric: column.numeric }">{{ cell(row, column) }}</dd>
            </div>
          </dl>
        </li>
      </ul>
    </template>

    <p v-if="limit > 0 && rows.length >= limit" class="more muted">
      只显示最近 {{ limit }} 条（还有更多，缩小范围或翻页看）
    </p>
  </div>
</template>

<style scoped>
.table-wrap {
  min-width: 0;
}

.empty {
  padding: var(--s-6) 0;
  text-align: center;
  color: var(--c-text-3);
  font-size: var(--t-sm);
}

.table {
  width: 100%;
  border-collapse: collapse;
  font-size: var(--t-sm);
}
.table th,
.table td {
  padding: 8px var(--s-2);
  text-align: left;
  border-bottom: 1px solid var(--c-border);
  vertical-align: top;
}
.table th {
  position: sticky;
  top: 0;
  z-index: 1;
  background: var(--c-surface);
  color: var(--c-text-3);
  font-size: var(--t-xs);
  font-weight: 600;
  white-space: nowrap;
}
.table tbody tr:hover {
  background: var(--c-surface-2);
}
.table td {
  color: var(--c-text-2);
  /* 长 ID / 长文本不许把表格撑爆 */
  max-width: 32ch;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.table td.numeric,
.table th.numeric {
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.table td.narrow,
.table th.narrow {
  width: 1%;
  white-space: nowrap;
}
.mono {
  font-family: var(--font-mono);
  font-size: 0.92em;
}

.cards {
  display: none;
  flex-direction: column;
  gap: var(--s-2);
  list-style: none;
}
.cards > li {
  padding: var(--s-3);
  background: var(--c-surface-2);
  border-radius: var(--r-md);
}
.card-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--s-2);
  margin-bottom: var(--s-2);
}
.card-title {
  color: var(--c-text);
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.card-sub {
  flex: none;
  color: var(--c-text-3);
  font-size: var(--t-xs);
}
.card-body {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.card-body > div {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--s-3);
}
.card-body dt {
  flex: none;
  color: var(--c-text-3);
  font-size: var(--t-xs);
}
.card-body dd {
  min-width: 0;
  color: var(--c-text-2);
  font-size: var(--t-xs);
  text-align: right;
  overflow-wrap: anywhere;
}

.more {
  margin-top: var(--s-2);
  font-size: var(--t-xs);
  text-align: center;
}

/* 手机端切换形态：窄屏下表格换成卡片 */
@media (max-width: 720px) {
  .table {
    display: none;
  }
  .cards {
    display: flex;
  }
}
</style>
