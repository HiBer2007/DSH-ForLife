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
import ContextMenu from '../components/ContextMenu.vue'
import { useContextMenu, type ContextMenuItem } from '../composables/useContextMenu.ts'
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

/**
 * 立即备份。
 *
 * 这是本页**唯一**的写动作，而且是**非破坏性**的 ——
 * 破坏性清理仍然留在 scripts/ 里（页面原本"刻意没有按钮"的理由成立：
 * 清理该走明确流程：先备份、再确认、可回滚）。
 * 但"能看见备份清单、却做不了备份"是真缺口，而流程第一步就是先备份。
 */
const { state: menuState, onContextMenu, touchHandlers, close: closeMenu, clampToViewport } = useContextMenu()
const backingUp = ref(false)
const backupError = ref("")
const backupDone = ref("")

async function backupNow(): Promise<void> {
  backingUp.value = true
  backupError.value = ""
  backupDone.value = ""
  try {
    const result = await api.post<{ readonly path?: string }>("/backup-now", {})
    backupDone.value = result.path ?? "已备份"
    state.refresh()
  } catch (error) {
    // 备份失败必须**明确显示** —— 让人以为备份好了是最危险的失败方式
    backupError.value = error instanceof Error ? error.message : String(error)
  } finally {
    backingUp.value = false
  }
}

function backupMenuItems(row: Record<string, unknown>): ContextMenuItem[] {
  const name = String(row["name"] ?? "")
  return [
    { key: "copy", label: "复制文件名", run: () => void navigator.clipboard?.writeText(name) },
  ]
}

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
          <div class="backup-bar">
            <button type="button" class="btn primary" :disabled="backingUp" @click="backupNow">
              {{ backingUp ? "备份中…" : "立即备份" }}
            </button>
            <span class="muted cap">
              非破坏性：用 <span class="mono">VACUUM INTO</span> 生成一份紧凑副本，不动正在用的库。
            </span>
          </div>
          <p v-if="backupError !== ''" class="backup-error">{{ backupError }}</p>
          <p v-if="backupDone !== ''" class="backup-done">已生成：<span class="mono">{{ backupDone }}</span></p>
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
    <ContextMenu :state="menuState" :on-close="closeMenu" :on-clamp="clampToViewport" />
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

.backup-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--s-2);
  margin-bottom: var(--s-3);
}
.backup-bar .cap {
  font-size: var(--t-xs);
}
.btn {
  min-height: var(--touch-min, 44px);
  padding: 0 var(--s-4);
  border: 1px solid var(--c-border-strong);
  border-radius: var(--r-md);
  background: transparent;
  color: var(--c-text);
  cursor: pointer;
}
.btn.primary {
  border-color: transparent;
  background: var(--c-brand);
  color: #fff;
}
.btn:disabled {
  opacity: 0.6;
  cursor: default;
}
.backup-error {
  margin-bottom: var(--s-2);
  color: var(--c-err, #d9534f);
  font-size: var(--t-xs);
}
.backup-done {
  margin-bottom: var(--s-2);
  color: var(--c-ok, #2a9d5c);
  font-size: var(--t-xs);
  overflow-wrap: anywhere;
}
</style>
