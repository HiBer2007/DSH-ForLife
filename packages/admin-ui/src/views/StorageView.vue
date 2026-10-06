<script setup lang="ts">
/**
 * 存储与迁移 —— 回答三个运维问题：
 *  1. 磁盘会不会满（库/WAL/备份各占多少）
 *  2. 哪些表在涨（涨得最快的就是下一个要治理的对象）
 *  3. 迁移到哪一版了、迁移前的自动备份还在不在
 *
 * 刻意**没有**"删数据"按钮：清理是破坏性动作，该走明确的运维流程，
 * 不该是一个顺手点下去的界面按钮。
 */
import { computed, ref } from 'vue'

import { api } from '../api/client.ts'
import type { StorageOverview } from '../api/types-storage.ts'
import AsyncSection from '../components/AsyncSection.vue'
import DataTable, { type TableColumn } from '../components/DataTable.vue'
import PanelCard from '../components/PanelCard.vue'
import StatCard from '../components/StatCard.vue'
import StatusBadge from '../components/StatusBadge.vue'
import { useAsyncData } from '../composables/useAsyncData.ts'
import { formatBytes, formatDateTime, formatNumber } from '../utils/format.ts'

const state = useAsyncData<StorageOverview>(() => api.get<StorageOverview>('/storage'))

/** 只显示有数据的表？默认显示全部（空表也是信息：说明那条链路还没跑过）。 */
const onlyNonEmpty = ref(false)

const tableRows = computed(() => {
  const tables = state.data.value?.tables ?? []
  const list = onlyNonEmpty.value ? tables.filter((table) => table.rows > 0) : tables
  // 行数降序：涨得最快的排最前，这才是这一页要传达的信息
  return [...list].sort((a, b) => b.rows - a.rows)
})

const tableColumns: TableColumn<Record<string, unknown>>[] = [
  { key: 'name', label: '表', primary: true, mono: true },
  { key: 'group', label: '分类', secondary: true },
  { key: 'rows', label: '行数', numeric: true, value: (row) => (Number(row['rows']) < 0 ? '表不存在' : formatNumber(Number(row['rows']))) },
]

const migrationColumns: TableColumn<Record<string, unknown>>[] = [
  { key: 'version', label: '版本', primary: true, numeric: true, value: (row) => `v${String(row['version'])}` },
  { key: 'name', label: '名称', mono: true },
  { key: 'appliedAt', label: '应用时间', secondary: true, value: (row) => formatDateTime(String(row['appliedAt'])) },
]

const backupColumns: TableColumn<Record<string, unknown>>[] = [
  { key: 'name', label: '备份文件', primary: true, mono: true },
  { key: 'at', label: '时间', secondary: true, value: (row) => formatDateTime(String(row['at'])) },
  { key: 'sizeBytes', label: '大小', numeric: true, value: (row) => formatBytes(Number(row['sizeBytes'])) },
]
</script>

<template>
  <div class="page">
    <AsyncSection
      :loading="state.loading.value"
      :error="state.error.value"
      :updated-at="state.updatedAt.value"
      :skeleton-rows="5"
      @retry="state.refresh()"
    >
      <template v-if="state.data.value">
        <div class="grid grid-4">
          <StatCard
            label="主库"
            :value="formatBytes(state.data.value.db.sizeBytes)"
            :hint="state.data.value.db.path"
            icon="storage"
          />
          <StatCard
            label="WAL"
            :value="formatBytes(state.data.value.db.walBytes)"
            :hint="state.data.value.db.walBytes > 8 * 1024 * 1024 ? '偏大：可能有长事务或未 checkpoint' : '正常范围'"
            :tone="state.data.value.db.walBytes > 8 * 1024 * 1024 ? 'warn' : 'neutral'"
          />
          <StatCard
            label="迁移版本"
            :value="`v${state.data.value.schema.current} / v${state.data.value.schema.latest}`"
            :hint="state.data.value.schema.behind ? '落后于代码：进程还没跑过新迁移' : '已是最新'"
            :tone="state.data.value.schema.behind ? 'warn' : 'ok'"
          />
          <StatCard
            label="关注表总行数"
            :value="formatNumber(state.data.value.totals.rows)"
            :hint="`备份 ${formatNumber(state.data.value.backups.length)} 个，共 ${formatBytes(state.data.value.totals.backupBytes)}`"
          />
        </div>

        <PanelCard title="表行数" subtitle="按行数降序 —— 涨得最快的表就是下一个要治理的对象">
          <template #actions>
            <label class="toggle">
              <input v-model="onlyNonEmpty" type="checkbox" />
              <span>只看非空</span>
            </label>
          </template>
          <DataTable
            :columns="tableColumns"
            :rows="tableRows"
            row-key="name"
            empty-text="没有匹配的表"
          />
          <template #footer>
            <p class="muted small">
              空表也是信息：它说明那条链路**还没跑过**（而不是坏了）。
              <span class="mono">表不存在</span> 则表示该功能尚未建表。
            </p>
          </template>
        </PanelCard>

        <div class="grid grid-2">
          <PanelCard title="迁移账本" :subtitle="`已应用 ${state.data.value.migrations.length} 个`">
            <DataTable
              :columns="migrationColumns"
              :rows="state.data.value.migrations"
              row-key="version"
              empty-text="还没有任何迁移记录（库是空的或从未打开过）"
            />
          </PanelCard>

          <PanelCard title="备份" subtitle="迁移前的自动备份 —— 最后一道保险，得能看见它在不在">
            <template #actions>
              <StatusBadge :tone="state.data.value.backups.length > 0 ? 'ok' : 'muted'">
                {{ state.data.value.backups.length }} 个
              </StatusBadge>
            </template>
            <DataTable
              :columns="backupColumns"
              :rows="state.data.value.backups"
              row-key="name"
              empty-text="没有备份文件。首次迁移（或库为空）时不会产生备份，这是正常的。"
            />
          </PanelCard>
        </div>

        <PanelCard title="清理" subtitle="这里刻意没有按钮">
          <p class="muted note">
            清理是**破坏性**动作，应该走明确的运维流程（先备份、再确认、可回滚），
            不该是一个顺手点下去的界面按钮。需要清理时请走 <span class="mono">scripts/</span> 下的脚本，
            并在动手前确认上面的备份清单里有可用的一份。
          </p>
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
.grid-2 {
  grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
}

.toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: var(--t-xs);
  color: var(--c-text-3);
  cursor: pointer;
}

.small {
  font-size: var(--t-xs);
}
.note {
  font-size: var(--t-sm);
  line-height: 1.8;
}
</style>
