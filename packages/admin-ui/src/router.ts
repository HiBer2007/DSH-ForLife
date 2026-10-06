/**
 * 路由表 —— 六个一级页 + 总览/日志/设置。
 *
 * 页面**全部懒加载**：手机端首屏只下载外壳与总览，切到哪页才下载哪页。
 *
 * `meta.title` 同时用于顶栏标题、浏览器标题、侧栏导航文案与面包屑 ——
 * 只写一处，三处都跟着变，避免"改了一处忘了另一处"。
 */
import { createRouter, createWebHashHistory, type RouteRecordRaw } from 'vue-router'

/** 导航分组：手机上分组标题就是小标题，桌面上是侧栏里的分组间隔。 */
export interface NavItem {
  readonly path: string
  readonly title: string
  readonly icon: string
  /** 未完成时显示"建设中"角标，并且页面里会明确说明还差什么。 */
  readonly pending?: boolean
}

export interface NavGroup {
  readonly label: string
  readonly items: readonly NavItem[]
}

/** 侧栏导航结构的唯一真源（顺序即显示顺序）。 */
export const NAV_GROUPS: readonly NavGroup[] = [
  {
    label: '总览',
    items: [{ path: '/', title: '运行总览', icon: 'overview' }],
  },
  {
    label: '对话',
    items: [
      { path: '/conversations', title: '会话与队列', icon: 'chat' },
      { path: '/takeover', title: '接管台', icon: 'chat' },
      { path: '/napcat', title: 'NapCat', icon: 'external' },
      { path: '/wake', title: '唤醒与自唤醒', icon: 'routing' },
    ],
  },
  {
    label: '记忆',
    items: [
      { path: '/memory', title: '记忆条目', icon: 'memory' },
      { path: '/compaction', title: '压缩日志', icon: 'compaction' },
    ],
  },
  {
    label: '模型',
    items: [
      { path: '/routing', title: '路由与端点', icon: 'endpoint' },
      { path: '/prompts', title: '提示词', icon: 'prompt' },
    ],
  },
  {
    label: '资源',
    items: [
      { path: '/media', title: '表情与媒体', icon: 'media' },
      { path: '/storage', title: '存储与迁移', icon: 'storage' },
    ],
  },
  {
    label: '运维',
    items: [
      { path: '/logs', title: '实时日志', icon: 'logs' },
      { path: '/settings', title: '设置', icon: 'settings' },
    ],
  },
]

const routes: readonly RouteRecordRaw[] = [
  { path: '/', name: 'overview', component: () => import('./views/OverviewView.vue'), meta: { title: '运行总览' } },
  { path: '/conversations', name: 'conversations', component: () => import('./views/ConversationsView.vue'), meta: { title: '会话与队列' } },
  { path: '/wake', name: 'wake', component: () => import('./views/WakeView.vue'), meta: { title: '唤醒与自唤醒' } },
  { path: '/memory', name: 'memory', component: () => import('./views/MemoryView.vue'), meta: { title: '记忆条目' } },
  { path: '/routing', name: 'routing', component: () => import('./views/RoutingView.vue'), meta: { title: '路由与端点' } },
  { path: '/compaction', name: 'compaction', component: () => import('./views/CompactionView.vue'), meta: { title: '压缩日志' } },
  { path: '/prompts', name: 'prompts', component: () => import('./views/PromptsView.vue'), meta: { title: '提示词' } },
  { path: '/takeover', name: 'takeover', component: () => import('./views/TakeoverView.vue'), meta: { title: '接管台' } },
  { path: '/napcat', name: 'napcat', component: () => import('./views/NapcatView.vue'), meta: { title: 'NapCat' } },
  { path: '/media', name: 'media', component: () => import('./views/MediaView.vue'), meta: { title: '表情与媒体' } },
  { path: '/storage', name: 'storage', component: () => import('./views/StorageView.vue'), meta: { title: '存储与迁移' } },
  { path: '/logs', name: 'logs', component: () => import('./views/LogsView.vue'), meta: { title: '实时日志' } },
  { path: '/settings', name: 'settings', component: () => import('./views/SettingsView.vue'), meta: { title: '设置' } },
  // 兜底：不认识的路径回总览（路由从第一天就用稳定命名，不做历史重定向）
  { path: '/:pathMatch(.*)*', redirect: '/' },
]

/**
 * 用 hash 模式还是 history 模式？
 *
 * 用 **hash**：面板挂在 `/admin/` 下，Caddy 只反代这一个前缀，
 * history 模式需要服务端把 `/admin/xxx` 全部回落到 index.html（还要小心别把
 * `/admin/api/*` 也回落进去）。hash 模式零服务端配合，刷新/分享链接都不会 404。
 */
export const router = createRouter({
  history: createWebHashHistory('/admin/'),
  routes: [...routes],
  scrollBehavior: () => ({ top: 0 }),
})

router.afterEach((to) => {
  const title = typeof to.meta.title === 'string' ? to.meta.title : undefined
  document.title = title === undefined ? 'DSH-ForLife 控制台' : `${title} · DSH-ForLife 控制台`
})
