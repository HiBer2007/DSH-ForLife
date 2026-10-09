<script setup lang="ts">
/**
 * 表情与媒体 —— 看"机器收到过哪些图/文件"和"视觉层怎么处理它们的"。
 *
 * 两个刻意的决定：
 *  1. **后两张表按实际列渲染**（不写死列名）：那两张表的 schema 归视觉层所有，
 *     在面板里写死列名的话，视觉层一改列这里就会静默出错 ——
 *     而面板是"看得见的门面"，最不该因为底层演进就坏掉。
 *  2. **没有表情库就如实说没有**，不画一张空表充数：
 *     空表会让人以为"功能已就绪、只是没数据"，那是误导。
 */
import { computed } from 'vue'

import { api } from '../api/client.ts'
import type { DynamicTable, MediaOverview } from '../api/types-media.ts'
import AsyncSection from '../components/AsyncSection.vue'
import DataTable, { type TableColumn } from '../components/DataTable.vue'
import PanelCard from '../components/PanelCard.vue'
import StatCard from '../components/StatCard.vue'
import StatusBadge from '../components/StatusBadge.vue'
import { useAsyncData } from '../composables/useAsyncData.ts'
import { formatNumber, formatRelative } from '../utils/format.ts'
import { mediaKindLabel, translateSegmentTokens } from '../utils/message-labels.ts'

const state = useAsyncData<MediaOverview>(() => api.get<MediaOverview>('/media'))

/**
 * 入站媒体表。
 *
 * 「类型」列**必须走标签表**：以前只有 `image` / `file` 两个分支，
 * 于是 `record` / `video` 把英文枚举名直接显示给用户（同一页的统计卡却写着中文）。
 */
const inboundColumns: TableColumn<Record<string, unknown>>[] = [
  { key: 'at', label: '时间', secondary: true, value: (row) => formatRelative(String(row['at'])) },
  {
    key: 'mediaKind',
    label: '类型',
    primary: true,
    value: (row) =>
      mediaKindLabel(row['mediaKind']) ?? (typeof row['mediaKind'] === 'string' ? row['mediaKind'] : '—'),
  },
  { key: 'senderName', label: '发送者', value: (row) => String(row['senderName'] ?? '—') },
  { key: 'conversationKey', label: '会话', mono: true },
  {
    key: 'text',
    label: '附带文本',
    // 正文里的 `[未解析:face]` 这类占位符也要翻中文（与 ConversationsView 同一份标签表）
    value: (row) => {
      const body = translateSegmentTokens(typeof row['text'] === 'string' ? row['text'].trim() : '')
      return body === '' ? '（无）' : body
    },
  },
]

/** 把"动态表"的列名转成表格列定义（值原样显示，未知类型转字符串）。 */
function dynamicColumns(table: DynamicTable): TableColumn<Record<string, unknown>>[] {
  return table.columns.map((column, index) => ({
    key: column,
    label: column,
    mono: true,
    ...(index === 0 ? { primary: true } : {}),
    value: (row) => {
      const value = row[column]
      if (value === null || value === undefined) return '—'
      if (typeof value === 'object') return JSON.stringify(value)
      return String(value)
    },
  }))
}

const tables = computed(() => state.data.value?.tables ?? [])
</script>

<template>
  <div class="page">
    <AsyncSection
      :loading="state.loading.value"
      :error="state.error.value"
      :updated-at="state.updatedAt.value"
      :skeleton-rows="4"
      @retry="state.refresh()"
    >
      <template v-if="state.data.value">
        <div class="grid grid-4">
          <StatCard label="收到图片" :value="formatNumber(state.data.value.inboundStats.images)" icon="media" />
          <StatCard label="收到文件" :value="formatNumber(state.data.value.inboundStats.files)" icon="storage" />
          <StatCard label="媒体消息合计" :value="formatNumber(state.data.value.inboundStats.total)" />
          <StatCard
            label="表情库"
            value="未建设"
            hint="没有存储层：现在只能发指定表情，没有收藏/检索"
            tone="warn"
          />
        </div>

        <PanelCard title="入站媒体" subtitle="QQ 收到的图片与文件（含附带文本）">
          <DataTable
            :columns="inboundColumns"
            :rows="state.data.value.inbound"
            empty-text="还没有收到过图片或文件。有人在 QQ 里发图之后会出现在这里。"
          />
        </PanelCard>

        <PanelCard
          v-for="table in tables"
          :key="table.name"
          :title="table.label"
          :subtitle="`表 ${table.name} · 共 ${formatNumber(table.total)} 行（显示最近 ${formatNumber(table.rows.length)} 行）`"
        >
          <template #actions>
            <StatusBadge :tone="table.missing ? 'muted' : table.total > 0 ? 'ok' : 'info'">
              {{ table.missing ? '表不存在' : table.total > 0 ? '有数据' : '空表' }}
            </StatusBadge>
          </template>

          <p v-if="table.missing" class="muted note">
            这张表还不存在 —— 说明视觉层**尚未启用**（不是"坏了"）。
            接入带 image 能力的模型后它会自动建表并开始写入。
          </p>
          <p v-else-if="table.total === 0" class="muted note">
            表已建好但还是空的 —— 说明还没有走过视觉调用。发一张图给机器人即可产生第一条记录。
          </p>
          <DataTable
            v-else
            :columns="dynamicColumns(table)"
            :rows="table.rows"
            empty-text="没有可显示的行"
          />
        </PanelCard>

        <PanelCard title="表情包（未建设）" subtitle="如实说明，而不是画一张空表">
          <p class="muted note">{{ state.data.value.stickers.note }}</p>
        </PanelCard>
      </template>
    </AsyncSection>
  </div>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: var(--s-4);
  max-width: var(--w-content-max);
}

.grid {
  display: grid;
  gap: var(--s-3);
}
.grid-4 {
  grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
}

.note {
  font-size: var(--t-sm);
  line-height: 1.8;
}
</style>
