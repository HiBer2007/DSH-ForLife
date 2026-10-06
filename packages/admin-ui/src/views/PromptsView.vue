<script setup lang="ts">
/**
 * 提示词 —— 两个槽位（P1 系统提示词 / P2 回答风格）当前的**只读**观察面。
 *
 * 为什么这一版只读：用户明确要求提示词可编辑，而"可编辑"背后是写入、校验、版本落库、
 * 回滚这一整条链路 —— 网关目前只有只读查询。
 * 与其摆一个点了没反应的编辑框（用户会以为自己改过了，其实没生效），不如先把
 * "现在生效的是哪一版、什么时候写的、哈希是多少、被哪些会话覆盖过"看清楚。
 *
 * 顺序 = 排查顺序：规模（槽位 / 版本 / 覆盖 / 生效 token）→ 每个槽位此刻生效的那一版
 * → 历史版本（将来回滚要选的对象）→ 按会话覆盖（谁没用全局版本）。
 */
import { computed } from 'vue'

import { api } from '../api/client.ts'
import type { PromptsOverview, PromptSlotOverview } from '../api/types-prompts.ts'
import AppIcon from '../components/AppIcon.vue'
import AsyncSection from '../components/AsyncSection.vue'
import DataTable, { type TableColumn } from '../components/DataTable.vue'
import PanelCard from '../components/PanelCard.vue'
import StatCard from '../components/StatCard.vue'
import StatusBadge from '../components/StatusBadge.vue'
import { useAsyncData } from '../composables/useAsyncData.ts'
import { formatDateTime, formatNumber, formatTokens } from '../utils/format.ts'

const state = useAsyncData<PromptsOverview>(() => api.get<PromptsOverview>('/prompts'))

interface StatItem {
  readonly label: string
  readonly value: string
  readonly hint: string
  readonly tone: 'neutral' | 'brand'
  readonly icon: string
}

/**
 * 顶部统计。
 *
 * 「历史版本」刻意用服务端的**全表计数**而不是列表长度：列表是按条数截断的，
 * 拿截断后的长度当"共 N 版"，会让人以为版本被删过。提示里写清两者的差别。
 */
const stats = computed<StatItem[]>(() => {
  const data = state.data.value
  if (data === undefined) return []
  return [
    {
      label: '槽位',
      value: formatNumber(data.stats.slots),
      hint: '每个槽位同时只有一版生效',
      tone: 'neutral',
      icon: 'prompt',
    },
    {
      label: '历史版本',
      value: formatNumber(data.stats.revisions),
      hint: `全表计数；本页列最近 ${formatNumber(data.revisions.length)} 条`,
      tone: 'neutral',
      icon: 'storage',
    },
    {
      label: '会话覆盖',
      value: formatNumber(data.stats.overrides),
      hint: '按会话改写版本的槽位',
      tone: 'neutral',
      icon: 'chat',
    },
    {
      label: '生效 token',
      value: formatTokens(data.stats.totalTokens),
      hint: '只算生效版本：每轮都要带上的前缀成本',
      tone: 'brand',
      icon: 'routing',
    },
  ]
})

const slots = computed<readonly PromptSlotOverview[]>(() => state.data.value?.slots ?? [])

/**
 * 表格行必须是 `Record<string, unknown>`（DataTable 要按任意列 key 取值）。
 * 接口类型是 interface，没有隐式索引签名，所以展开成匿名对象再传。
 */
const revisionRows = computed<Record<string, unknown>[]>(() =>
  (state.data.value?.revisions ?? []).map((row) => ({ ...row })),
)
const overrideRows = computed<Record<string, unknown>[]>(() =>
  (state.data.value?.overrides ?? []).map((row) => ({ ...row })),
)

/**
 * 哈希 / 版本 id 的短形式。
 *
 * 面板上这两样东西只需要"能对上库里那一行"：64 位十六进制全铺出来会把行撑爆。
 * 完整值仍放在 `title` 里，想核对时鼠标停一下就有 —— 截断只是显示，不是丢弃。
 */
function shortHash(value: string | undefined): string {
  if (value === undefined || value === '') return '—'
  return value.length > 12 ? `${value.slice(0, 12)}…` : value
}

/** 列取值回调拿到的是 `Record<string, unknown>`（表格按任意 key 取列），这里收窄回字符串。 */
function asText(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/** 变量列表 → 一行文本；空列表给 undefined，DataTable 会显示"—"。 */
function variablesText(value: unknown): string | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined
  return value.join('、')
}

/** 槽位副标题：生效的是哪一版（显示短 id，好和「版本历史」里的行对上）。 */
function slotSubtitle(slot: PromptSlotOverview): string {
  const active = slot.activeRevisionId === undefined ? '未设置生效版本' : `生效版本 ${shortHash(slot.activeRevisionId)}`
  return `${active} · 共 ${formatNumber(slot.revisionCount)} 版`
}

const revisionColumns: TableColumn<Record<string, unknown>>[] = [
  { key: 'slug', label: 'slug', primary: true, mono: true },
  { key: 'createdAt', label: '创建时间', secondary: true, value: (row) => formatDateTime(asText(row['createdAt'])) },
  { key: 'revisionId', label: '版本 ID', mono: true, value: (row) => shortHash(asText(row['id'])) },
  { key: 'tokenCount', label: 'token', numeric: true, narrow: true, value: (row) => formatNumber(Number(row['tokenCount'])) },
  { key: 'createdBy', label: '来源', narrow: true },
  { key: 'active', label: '生效', narrow: true, value: (row) => (row['active'] === true ? '生效中' : '历史版本') },
  { key: 'note', label: '备注' },
  { key: 'variables', label: '变量', value: (row) => variablesText(row['variables']) },
]

const overrideColumns: TableColumn<Record<string, unknown>>[] = [
  { key: 'scope', label: '作用域', primary: true, mono: true },
  { key: 'slug', label: 'slug', secondary: true, mono: true },
  { key: 'revisionId', label: '版本', mono: true, value: (row) => shortHash(asText(row['revisionId'])) },
  { key: 'createdBy', label: '创建者', narrow: true },
  { key: 'createdAt', label: '时间', value: (row) => formatDateTime(asText(row['createdAt'])) },
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
            v-for="item in stats"
            :key="item.label"
            :label="item.label"
            :value="item.value"
            :hint="item.hint"
            :tone="item.tone"
            :icon="item.icon"
          />
        </div>

        <!-- 这一条必须显眼：否则用户会到处找编辑入口，或者以为是页面坏了 -->
        <p class="notice">
          <AppIcon name="info" :size="15" />
          <span>
            <strong>当前为只读展示，编辑功能待接。</strong>
            提示词本身是可编辑的（这是硬要求），但保存 / 回滚 / 覆盖的写入接口还没做，
            所以这一页不放编辑框 —— 免得改完以为已经生效。
          </span>
        </p>

        <!-- ① 生效提示词：此刻真正会进入模型上下文的那一版 -->
        <section class="section">
          <div class="section-head">
            <h2>生效提示词</h2>
            <p class="muted">每个槽位同时只有一版生效，下面是它此刻的样子</p>
          </div>

          <div v-if="slots.length > 0" class="grid grid-2">
            <PanelCard v-for="slot in slots" :key="slot.slug" :title="slot.slug" :subtitle="slotSubtitle(slot)">
              <template #actions>
                <StatusBadge tone="muted">只读</StatusBadge>
              </template>

              <dl class="kv">
                <div>
                  <dt>token</dt>
                  <dd class="numeric">{{ formatNumber(slot.tokenCount) }}</dd>
                </div>
                <div>
                  <dt>历史版本</dt>
                  <dd class="numeric">{{ formatNumber(slot.revisionCount) }}</dd>
                </div>
                <div>
                  <dt>生效版本写入</dt>
                  <dd>{{ formatDateTime(slot.updatedAt) }}</dd>
                </div>
                <div>
                  <dt>sha256</dt>
                  <dd class="mono" :title="slot.sha256 === '' ? '没有生效版本，所以没有哈希' : slot.sha256">
                    {{ shortHash(slot.sha256) }}
                  </dd>
                </div>
              </dl>

              <pre v-if="slot.textPreview !== ''" class="preview">{{ slot.textPreview }}</pre>
              <p v-else class="empty-note">
                这个槽位还没有生效版本：注入时它是空的，模型只看得到另一个槽位的内容。
              </p>
              <p v-if="slot.textPreview !== ''" class="muted cap">
                预览是服务端截断的前 300 字符，只够看清结构与语气；完整文本在下面「版本历史」里对应的那一版。
              </p>
            </PanelCard>
          </div>

          <PanelCard v-else title="生效提示词">
            <p class="empty-note">
              服务端一个槽位都没返回 —— 连已知槽位（p1-system / p2-style）都不在，
              这通常说明查询出错或库版本不对，而不是"本来就没有提示词"。
            </p>
          </PanelCard>
        </section>

        <!-- ② 版本历史：将来回滚要在这里挑一版 -->
        <PanelCard
          title="版本历史"
          :subtitle="`共 ${formatNumber(state.data.value.stats.revisions)} 版（全表计数），本页列出最近 ${formatNumber(revisionRows.length)} 条，按写入时间倒序`"
        >
          <DataTable
            :columns="revisionColumns"
            :rows="revisionRows"
            empty-text="还没有任何提示词版本。写入接口落地之前这里会是空的 —— 不是加载失败，也不是槽位被删了。"
          />

          <template #footer>
            <p class="muted legend">
              「生效中」是当前真正注入的那一版（每个 slug 至多一版）；
              其余都是历史，回滚会把某一版重新置为生效，但不会刷新它的创建时间。
            </p>
          </template>
        </PanelCard>

        <!-- ③ 会话覆盖 -->
        <PanelCard
          title="会话覆盖"
          :subtitle="`共 ${formatNumber(state.data.value.stats.overrides)} 条（作用域 × 槽位）`"
        >
          <DataTable
            :columns="overrideColumns"
            :rows="overrideRows"
            empty-text="还没有会话覆盖。没有覆盖时所有会话都用全局版本 —— 这一页空着是正常状态，不是缺数据。"
          />
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

.section {
  display: flex;
  flex-direction: column;
  gap: var(--s-3);
}
.section-head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--s-2);
}
.section-head h2 {
  font-size: var(--t-base);
  font-weight: 600;
}
.section-head p {
  font-size: var(--t-xs);
}

/* 只读提示：用品牌浅底而不是警告色 —— 它不是错误，只是功能还没接 */
.notice {
  display: flex;
  align-items: flex-start;
  gap: var(--s-2);
  padding: var(--s-3) var(--s-4);
  background: var(--c-brand-soft);
  border-radius: var(--r-md);
  color: var(--c-text-2);
  font-size: var(--t-sm);
  line-height: var(--lh-base);
}
.notice svg {
  flex: none;
  margin-top: 3px;
  color: var(--c-brand);
}
.notice strong {
  color: var(--c-text);
}

.kv {
  display: flex;
  flex-direction: column;
  gap: var(--s-2);
}
.kv > div {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--s-3);
}
.kv dt {
  flex: none;
  color: var(--c-text-3);
  font-size: var(--t-xs);
}
.kv dd {
  min-width: 0;
  color: var(--c-text-2);
  text-align: right;
  overflow-wrap: anywhere;
}
.numeric {
  font-variant-numeric: tabular-nums;
}

.preview {
  max-height: 220px;
  margin-top: var(--s-3);
  padding: var(--s-3);
  overflow: auto;
  background: var(--c-surface-2);
  border: 1px solid var(--c-border);
  border-radius: var(--r-md);
  color: var(--c-text-2);
  font-family: var(--font-mono);
  font-size: var(--t-xs);
  line-height: 1.6;
  /* 提示词里有换行与缩进，pre-wrap 保留它们，同时不让长行走不出视野 */
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.cap {
  margin-top: var(--s-2);
  font-size: var(--t-xs);
  line-height: var(--lh-base);
}

.empty-note {
  max-width: 62ch;
  margin: 0 auto;
  padding: var(--s-4) 0;
  color: var(--c-text-3);
  font-size: var(--t-sm);
  line-height: var(--lh-base);
  text-align: center;
}

.legend {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  font-size: var(--t-xs);
}
</style>
