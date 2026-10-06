<script setup lang="ts">
/**
 * 端口出口。
 *
 * 写操作与右键菜单**调用同一批函数**（openPublish / unpublish），避免两处行为分叉。
 */
import { computed, ref } from 'vue'

import { api } from '../api/client.ts'
import type { PortsOverview } from '../api/types-ports.ts'
import AsyncSection from '../components/AsyncSection.vue'
import ContextMenu from '../components/ContextMenu.vue'
import PanelCard from '../components/PanelCard.vue'
import StatCard from '../components/StatCard.vue'
import StatusBadge from '../components/StatusBadge.vue'
import { useAsyncData } from '../composables/useAsyncData.ts'
import { useContextMenu, type ContextMenuItem } from '../composables/useContextMenu.ts'
import { formatRelative } from '../utils/format.ts'

const state = useAsyncData<PortsOverview>(() => api.get<PortsOverview>('/ports'))

const { state: menuState, onContextMenu, touchHandlers, close: closeMenu, clampToViewport } = useContextMenu()

const enabled = computed(() => state.data.value?.enabled === true)
const whitelistText = computed(() =>
  (state.data.value?.whitelist ?? []).map((r) => `${r.from}–${r.to}`).join('、') || '（未配置）',
)

const stats = computed(() => [
  { label: '有效发布', value: String(state.data.value?.rows.length ?? 0), hint: '过期的不计入（读取时即判定）' },
  { label: '允许的端口段', value: whitelistText.value, hint: '白名单外一律拒绝并留审计' },
])

// ── 发布 ────────────────────────────────────────────────────────────
const publishing = ref(false)
const formOpen = ref(false)
const formError = ref('')
const form = ref({ name: '', targetPort: '', protocol: 'http' as 'http' | 'tcp', listenPort: '', ttlSeconds: '' })

function openPublish(): void {
  if (!enabled.value) return
  formOpen.value = true
  formError.value = ''
  form.value = { name: '', targetPort: '', protocol: 'http', listenPort: '', ttlSeconds: '' }
}

async function submitPublish(): Promise<void> {
  publishing.value = true
  formError.value = ''
  try {
    await api.post('/port-publish', {
      name: form.value.name.trim(),
      targetPort: Number(form.value.targetPort),
      protocol: form.value.protocol,
      // 只有 tcp 才传对外端口 —— http 传了会被服务端拒（它没有"选对外端口"这回事）
      listenPort: form.value.protocol === 'tcp' ? Number(form.value.listenPort) : null,
      // 空字符串表示"不过期"，要传 null 而不是 NaN
      ttlSeconds: form.value.ttlSeconds.trim() === '' ? null : Number(form.value.ttlSeconds),
    })
    formOpen.value = false
    state.refresh()
  } catch (error) {
    formError.value = error instanceof Error ? error.message : String(error)
  } finally {
    publishing.value = false
  }
}

// ── 取消 ────────────────────────────────────────────────────────────
async function unpublish(row: Record<string, unknown>): Promise<void> {
  const name = String(row['name'] ?? '')
  // 取消会**立即让服务不可访问**，所以先确认
  if (!window.confirm(`取消「${name}」的发布？\n\n对外地址会立即 404。`)) return
  try {
    await api.post('/port-unpublish', { id: row['id'] })
    state.refresh()
  } catch (error) {
    window.alert(error instanceof Error ? error.message : String(error))
  }
}

function portMenuItems(row: Record<string, unknown>): ContextMenuItem[] {
  const url = String(row['url'] ?? '')
  return [
    { key: 'open', label: '打开地址', hint: url, run: () => void window.open(url, '_blank', 'noopener,noreferrer') },
    { key: 'copy', label: '复制地址', run: () => void navigator.clipboard?.writeText(url) },
    { key: 'unpublish', label: '取消发布', hint: '立即 404', danger: true, run: () => unpublish(row) },
  ]
}

const rows = computed<Record<string, unknown>[]>(
  () => (state.data.value?.rows ?? []) as unknown as Record<string, unknown>[],
)
</script>

<template>
  <div class="page">
    <header class="head">
      <h1>端口出口</h1>
      <p class="muted">
        把工作区里的服务发布到 <span class="mono">https://&lt;host&gt;/svc/&lt;name&gt;/</span>。
        发布要过**端口白名单**，每次动作（含被拒的）都落审计。
      </p>
    </header>

    <AsyncSection
      :loading="state.loading.value"
      :error="state.error.value"
      :updated-at="state.updatedAt.value"
      :skeleton-rows="4"
      @retry="state.refresh()"
    >
      <template #default>
        <div v-if="!enabled" class="disabled-note">
          <StatusBadge tone="warn" dot>未启用</StatusBadge>
          <p>{{ state.data.value?.disabledReason }}</p>
          <p class="muted cap">
            配好这两个变量并重启网关后本页即可用：<span class="mono">FORLIFE_CADDY_ADMIN</span>、
            <span class="mono">FORLIFE_PUBLIC_HOST</span>。
          </p>
        </div>

        <div class="grid">
          <StatCard v-for="item in stats" :key="item.label" v-bind="item" />
        </div>

        <PanelCard title="已发布" :subtitle="`${rows.length} 条有效（过期的不显示）`">
          <div class="bar">
            <button type="button" class="btn primary" :disabled="!enabled" @click="openPublish">
              发布端口…
            </button>
            <span v-if="!enabled" class="muted cap">未启用 —— 按钮禁用，而不是让你点了再看错误</span>
          </div>

          <p v-if="rows.length === 0" class="empty-note">
            还没有发布。工作区里起了 HTTP 服务之后，用「发布端口…」把它映射出去；
            模型侧也可以用 <span class="mono">publish_port</span> 工具做同样的事。
          </p>

          <ul v-else class="port-list">
            <li
              v-for="row in rows"
              :key="String(row['id'])"
              class="port-row"
              @contextmenu="onContextMenu($event, portMenuItems(row), row)"
              v-on="touchHandlers(portMenuItems(row), row)"
            >
              <div class="port-head">
                <StatusBadge tone="ok" dot>已发布</StatusBadge>
                <span class="mono port-name">{{ row['name'] }}</span>
                <span class="port-time">{{ formatRelative(String(row['created_at'] ?? '')) }}</span>
              </div>
              <p class="mono port-url">{{ row['url'] }}</p>
              <p class="muted cap">
                <StatusBadge :tone="row['protocol'] === 'tcp' ? 'warn' : 'muted'">{{ row['protocol'] }}</StatusBadge>
                目标 <span class="mono">:{{ row['target_port'] }}</span>
                <template v-if="row['listen_port'] !== null && row['listen_port'] !== undefined">
                  · 对外 <span class="mono">:{{ row['listen_port'] }}</span>
                </template>
                ·
                {{ row['expires_at'] === null ? '不过期' : `到期 ${String(row['expires_at'])}` }} ·
                由 {{ row['approved_by'] }} 批准
              </p>
              <div class="port-actions">
                <button type="button" class="mini" @click="unpublish(row)">取消发布</button>
              </div>
            </li>
          </ul>
        </PanelCard>
      </template>
    </AsyncSection>

    <div v-if="formOpen" class="edit-mask" @click.self="formOpen = false">
      <div class="edit-box" role="dialog" aria-modal="true" aria-label="发布端口">
        <h3 class="edit-title">发布端口</h3>

        <label class="edit-label" for="p-name">名字（会拼进 URL）</label>
        <input id="p-name" v-model="form.name" class="edit-input" placeholder="my-app" />
        <p class="muted cap">只能小写字母/数字/连字符；admin / api / svc / health 是保留名。</p>

        <label class="edit-label" for="p-proto">协议</label>
        <select id="p-proto" v-model="form.protocol" class="edit-input">
          <option value="http">http（网页 / API）</option>
          <option value="tcp">tcp（数据库 / SSH 等非 HTTP 服务）</option>
        </select>

        <label class="edit-label" for="p-port">目标端口（工作区里那个服务）</label>
        <input id="p-port" v-model="form.targetPort" class="edit-input" inputmode="numeric" placeholder="8080" />

        <!-- 只有 tcp 才显示对外端口：**不显示的东西不会被填** ——
             否则用户会给 http 服务填一个，然后收到"HTTP 发布不接受 listenPort"，
             得试错一次才知道。 -->
        <template v-if="form.protocol === 'tcp'">
          <label class="edit-label" for="p-listen">对外端口（别人连的那个）</label>
          <input id="p-listen" v-model="form.listenPort" class="edit-input" inputmode="numeric" placeholder="18050" />
          <p class="muted cap">
            **TCP 没有路径可以分流，所以每个服务要独占一个对外端口**，而且它不能和别人重复。
            地址会是 <span class="mono">tcp://&lt;host&gt;:&lt;对外端口&gt;</span>。
          </p>
        </template>

        <p class="muted cap">允许的端口段：{{ whitelistText }}</p>

        <label class="edit-label" for="p-ttl">TTL 秒数（留空 = 不过期）</label>
        <input id="p-ttl" v-model="form.ttlSeconds" class="edit-input" inputmode="numeric" placeholder="留空" />
        <p class="muted cap">
          **建议填**：到期会自动回收（连 Caddy 路由一起删）。
          不过期的发布一旦被忘掉，就是一条**没人记得的公开路由**。
        </p>

        <p v-if="formError !== ''" class="edit-error">{{ formError }}</p>

        <div class="edit-actions">
          <button type="button" class="mini" @click="formOpen = false">取消</button>
          <button type="button" class="mini primary" :disabled="publishing" @click="submitPublish">
            {{ publishing ? '发布中…' : '发布' }}
          </button>
        </div>
      </div>
    </div>

    <ContextMenu :state="menuState" :on-close="closeMenu" :on-clamp="clampToViewport" />
  </div>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: var(--s-4);
  max-width: var(--w-content-max);
}
.head h1 {
  font-size: var(--t-lg);
}
.head p {
  margin-top: 4px;
  font-size: var(--t-sm);
  line-height: 1.7;
}
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: var(--s-3);
}
.disabled-note {
  display: flex;
  flex-direction: column;
  gap: var(--s-2);
  padding: var(--s-4);
  background: var(--c-surface-2);
  border: 1px solid var(--c-border-strong);
  border-radius: var(--r-lg);
}
.disabled-note p {
  font-size: var(--t-sm);
  line-height: 1.7;
}
.bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--s-2);
  margin-bottom: var(--s-3);
}
.cap {
  font-size: var(--t-xs);
}
.empty-note {
  padding: var(--s-4) 0;
  color: var(--c-text-3);
  font-size: var(--t-sm);
  line-height: 1.8;
}
.port-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  list-style: none;
}
.port-row {
  padding: var(--s-3);
  border-radius: var(--r-sm);
  cursor: context-menu;
}
.port-row:hover {
  background: var(--c-surface-2);
}
.port-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--s-2);
}
.port-name {
  font-size: var(--t-sm);
}
.port-time {
  margin-left: auto;
  color: var(--c-text-3);
  font-size: var(--t-xs);
}
.port-url {
  margin-top: 4px;
  color: var(--c-brand);
  font-size: var(--t-xs);
  overflow-wrap: anywhere;
}
.port-actions {
  display: flex;
  gap: 4px;
  margin-top: var(--s-2);
}
.btn,
.mini {
  min-height: var(--touch-min, 44px);
  padding: 0 var(--s-4);
  border: 1px solid var(--c-border-strong);
  border-radius: var(--r-md);
  background: transparent;
  color: var(--c-text);
  cursor: pointer;
}
.btn.primary,
.mini.primary {
  border-color: transparent;
  background: var(--c-brand);
  color: #fff;
}
.btn:disabled,
.mini:disabled {
  opacity: 0.5;
  cursor: default;
}
.mini {
  min-height: 32px;
  font-size: var(--t-xs);
}
.edit-mask {
  position: fixed;
  inset: 0;
  z-index: 900;
  display: grid;
  place-items: center;
  padding: var(--s-4);
  background: rgb(0 0 0 / 45%);
}
.edit-box {
  width: min(520px, 100%);
  max-height: 88vh;
  overflow: auto;
  padding: var(--s-5);
  background: var(--c-surface);
  border: 1px solid var(--c-border-strong);
  border-radius: var(--r-lg);
}
.edit-title {
  font-size: var(--t-md);
}
.edit-label {
  display: block;
  margin-top: var(--s-3);
  margin-bottom: 4px;
  color: var(--c-text-2);
  font-size: var(--t-xs);
}
.edit-input {
  width: 100%;
  padding: var(--s-2) var(--s-3);
  background: var(--c-bg);
  border: 1px solid var(--c-border-strong);
  border-radius: var(--r-md);
  color: var(--c-text);
  font-family: inherit;
  font-size: var(--t-sm);
}
.edit-error {
  margin-top: var(--s-3);
  color: var(--c-err, #d9534f);
  font-size: var(--t-xs);
  line-height: 1.7;
}
.edit-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--s-2);
  margin-top: var(--s-4);
}
</style>
