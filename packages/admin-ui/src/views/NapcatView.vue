<script setup lang="ts">
/**
 * NapCat —— QQ 协议端的原生面板（内嵌）。
 *
 * ## 为什么是 iframe，以及为什么地址要"拼"出来
 *
 * NapCat 的 WebUI 是个完整的 React 应用，而且它**用绝对路径**请求自己的资源与接口
 * （`/webui/assets/…`、`/api/…`）。这意味着把它反代到我们的子路径（`/admin/napcat/…`）
 * 会直接坏掉 —— 除非重写它的产物，那既脆弱又要跟着它升级。
 * 所以这里用 iframe 直连它自己的端口，**同源策略不管 iframe**，它照常工作。
 *
 * 地址必须由**当前浏览器的主机名**拼出来：写死 `127.0.0.1` 的话，
 * 你在手机上打开时那个地址指的是**手机自己**，必然打不开（这正是我第一次给错地址的原因）。
 * 服务端只回端口与 token，主机名由这里推导。
 *
 * ## 安全
 *
 * - 这个页面本身要登录才能看（`/api/admin/napcat` 走统一鉴权）；
 * - iframe 的内容由 NapCat 自己的 token 保护（token 只发给已登录的会话）；
 * - CSP 的 `frame-src` 由服务端按**当前主机名 + NapCat 端口**精确放行，不是放开整个 `http:`。
 */
import ContextMenu from '../components/ContextMenu.vue'
import { useContextMenu, type ContextMenuItem } from '../composables/useContextMenu.ts'
import { ref, computed } from 'vue'

import { api } from '../api/client.ts'
import AppIcon from '../components/AppIcon.vue'
import AsyncSection from '../components/AsyncSection.vue'
import PanelCard from '../components/PanelCard.vue'
import StatusBadge from '../components/StatusBadge.vue'
import { useAsyncData } from '../composables/useAsyncData.ts'

interface NapcatInfo {
  readonly webuiPort: number
  readonly token?: string
  /** `undefined` = 本服务没接管 QQ 连接，无法判断（不是"离线"）。 */
  readonly connected?: boolean
}

const state = useAsyncData<NapcatInfo>(() => api.get<NapcatInfo>('/napcat'))

/** 用当前访问地址的主机名 + 服务端给的端口拼出 WebUI 地址。 */
/**
 * 重新加载内嵌的 WebUI。
 *
 * 用**换 key** 的方式强制 iframe 重建 —— 直接改 src 有时不会重新加载
 *（同源且路径没变时浏览器会复用现有文档），表现为"点了没反应"。
 */
const frameKey = ref(0)
function reloadFrame(): void {
  frameKey.value += 1
}

const { state: menuState, onContextMenu, touchHandlers, close: closeMenu, clampToViewport } = useContextMenu()

function napcatMenuItems(): ContextMenuItem[] {
  const url = webuiUrl.value
  return [
    { key: "reload", label: "重新加载内嵌页", hint: "登录态不会丢", run: () => reloadFrame() },
    { key: "open", label: "在新窗口打开", run: () => void window.open(url, "_blank", "noopener,noreferrer") },
    { key: "copy", label: "复制 WebUI 地址", run: () => void navigator.clipboard?.writeText(url) },
  ]
}

const webuiUrl = computed(() => {
  const info = state.data.value
  if (info === undefined) return ''
  const host = window.location.hostname
  const query = info.token === undefined ? '' : `?token=${encodeURIComponent(info.token)}`
  return `http://${host}:${String(info.webuiPort)}/webui${query}`
})

const connectionTone = computed<'ok' | 'err' | 'muted'>(() => {
  const connected = state.data.value?.connected
  if (connected === undefined) return 'muted'
  return connected ? 'ok' : 'err'
})

const connectionText = computed(() => {
  const connected = state.data.value?.connected
  if (connected === undefined) return '未接管'
  return connected ? 'OneBot 已连接' : 'OneBot 未连接'
})
</script>

<template>
  <div class="page">
    <AsyncSection
      :loading="state.loading.value"
      :error="state.error.value"
      :updated-at="state.updatedAt.value"
      :skeleton-rows="3"
      @retry="state.refresh()"
    >
      <template v-if="state.data.value">
        <PanelCard title="NapCat（QQ 协议端）" subtitle="扫码登录、查看登录态与网络配置都在这里操作">
          <template #actions>
            <StatusBadge :tone="connectionTone" dot>{{ connectionText }}</StatusBadge>
          </template>

          <div class="bar">
            <span
              class="napcat-tools"
              @contextmenu="onContextMenu($event, napcatMenuItems())"
              v-on="touchHandlers(napcatMenuItems())"
            >
              <a class="link" :href="webuiUrl" target="_blank" rel="noopener noreferrer">
                <AppIcon name="external" :size="14" />
                <span>在新标签页打开</span>
              </a>
              <button type="button" class="link" @click="reloadFrame">重新加载</button>
            </span>
            <span class="muted mono">{{ webuiUrl }}</span>
          </div>

          <p class="muted note">
            token 已自动带上，不需要手输。<strong>若显示需要输入密钥</strong>，说明这里的 token 与 NapCat 当前的不一致
            —— 在 <span class="mono">.runtime\onebot-token.txt</span> 旁边还有一个 NapCat 自己的 WebUI token，
            它可以从容器日志里取（<span class="mono">docker logs forlife-qq-1 | Select-String "WebUi Token"</span>）。
          </p>
        </PanelCard>

        <PanelCard title="登录与网络配置" subtitle="嵌的是 NapCat 官方 WebUI，操作与直接打开它完全一致">
          <div class="frame-wrap">
            <iframe :key="frameKey"
              :src="webuiUrl"
              title="NapCat WebUI"
              referrerpolicy="no-referrer"
              allow="clipboard-read; clipboard-write"
            />
          </div>
          <p class="muted note">
            扫码登录：在 iframe 里点「二维码登录」，用手机 QQ 扫码。
            登录成功后 OneBot 适配器才会初始化，**反向 WS 才会连上我们**（配置已就位，无需手动添加）。
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

.bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--s-3);
  margin-bottom: var(--s-2);
}
.link {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  min-height: 32px;
  padding: 0 var(--s-3);
  border: 1px solid var(--c-border-strong);
  border-radius: var(--r-md);
  color: var(--c-text);
  font-size: var(--t-sm);
  text-decoration: none;
}
.link:hover {
  background: var(--c-surface-2);
}

.note {
  font-size: var(--t-xs);
  line-height: 1.7;
}

.frame-wrap {
  position: relative;
  width: 100%;
  /* 手机上也给足高度：扫码界面是竖向的，太矮会看不到按钮 */
  height: min(78vh, 900px);
  min-height: 520px;
  overflow: hidden;
  border: 1px solid var(--c-border);
  border-radius: var(--r-md);
  background: var(--c-surface-2);
}
.frame-wrap iframe {
  display: block;
  width: 100%;
  height: 100%;
  border: 0;
}
</style>
