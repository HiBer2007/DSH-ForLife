<script setup lang="ts">
/**
 * 应用外壳：登录门禁 + 侧栏导航 + 顶栏 + 内容区。
 *
 * 三条要求在这里落地的方式：
 *  - **手机端**：`<900px` 时侧栏变成抽屉（汉堡键唤出、点遮罩/点导航项关闭），
 *    顶栏固定在顶部，内容区单独滚动，`env(safe-area-inset-*)` 避开刘海与home条；
 *  - **深色模式**：外壳本身不含任何颜色值，全部走令牌，所以主题切换零改动；
 *  - **美观**：导航分组、当前项高亮（左侧强调条）、统一圆角与过渡。
 */
import petIcon from './assets/pet.ico'
import { computed, onMounted, ref, watch } from 'vue'
import { RouterLink, RouterView, useRoute } from 'vue-router'

import AppIcon from './components/AppIcon.vue'
import ThemeControl from './components/ThemeControl.vue'
import { useAuth } from './composables/useAuth.ts'
import { useNow, useRefreshActivity } from './composables/useRefreshActivity.ts'
import { formatRefreshAge } from './refresh-activity.ts'
import { NAV_GROUPS } from './router.ts'
import LoginView from './views/LoginView.vue'

const auth = useAuth()
const route = useRoute()

/** 手机上侧栏是否展开。桌面端这个值不起作用（CSS 里侧栏常驻）。 */
const navOpen = ref(false)

// ── 顶栏的「刷新指示器 + 最后刷新时间」（2026-10-09 用户要求）──────────────────
//
// 数据源**不是**这里新起的：`useRefreshActivity()` 读的是 `useAsyncData()` 每个
// 数据源早就持有的 `loading` / 上次成功时间（见 `refresh-activity.ts`）。
// 登记表靠"页面卸载就注销"自然收敛 ⇒ 聚合出来的**就是"当前这一页"**：
// 切页后上一页的数据源已经不在表里，顶栏不会报一个已经不在屏幕上的数字。
//
// 为什么显示**相对时间**（"刚刚 / 12 秒前"）而不是绝对时刻：
// 相对时间会自己走，"轮询死了"这件事因此**直接看得见**（数字冻在"47 秒前"不动）；
// 绝对时刻永远是同一串字符，刷没刷肉眼分不出来。
const activity = useRefreshActivity()
/** 每秒走一次的"现在" —— 相对时间必须自己走。 */
const now = useNow(1000)

const lastRefreshText = computed(() => formatRefreshAge(activity.value.lastSuccessAt, now.value))

/** 鼠标悬停时给全话（顶栏放不下）：刷新中 / 这一页有没有自动刷新的数据源。 */
const refreshTitle = computed(() => {
  const { refreshing, sources, lastSuccessAt } = activity.value
  if (sources === 0) return '这一页没有自动刷新的数据源（顶栏只报告当前页面的刷新情况）'
  const head = refreshing ? '正在刷新…' : '当前没有正在进行的刷新'
  if (lastSuccessAt === undefined) return `${head}｜这一页还没有成功取到过数据`
  return `${head}｜最后刷新 ${new Date(lastSuccessAt).toLocaleTimeString('zh-CN', { hour12: false })}｜共 ${String(sources)} 个数据源`
})

const pageTitle = computed(() => (typeof route.meta.title === 'string' ? route.meta.title : 'DSH-ForLife 控制台'))

// 切页就收起抽屉，否则手机上点完导航还要手动关一次
watch(() => route.fullPath, () => {
  navOpen.value = false
})

// 抽屉展开时锁住背景滚动（否则手机上会"穿透滚动"到底层页面）
watch(navOpen, (open) => {
  document.body.style.overflow = open ? 'hidden' : ''
})

onMounted(() => {
  void auth.refresh()
})

async function onLogout(): Promise<void> {
  await auth.logout()
  navOpen.value = false
}
</script>

<template>
  <!-- ① 还不知道登录态：给一个中性的启动态，避免闪一下登录页 -->
  <div v-if="auth.state.value === 'unknown'" class="boot">
    <div class="boot-inner">
      <div class="boot-spinner" />
      <p class="muted">正在连接…</p>
    </div>
  </div>

  <!-- ② 未登录：整屏登录页 -->
  <LoginView v-else-if="!auth.isAuthenticated.value" />

  <!-- ③ 已登录：外壳 -->
  <div v-else class="shell" :data-nav-open="navOpen">
    <a class="skip-link" href="#main">跳到主内容</a>

    <!-- 手机端遮罩：点一下关抽屉 -->
    <div v-if="navOpen" class="scrim" @click="navOpen = false" />

    <aside class="sidebar" aria-label="主导航">
      <div class="brand">
        <img class="brand-mark" :src="petIcon" alt="" aria-hidden="true" />
        <span class="brand-text">
          <strong>DSH-ForLife</strong>
          <small>控制台</small>
        </span>
      </div>

      <nav class="nav">
        <template v-for="group in NAV_GROUPS" :key="group.label">
          <p class="nav-group">{{ group.label }}</p>
          <RouterLink
            v-for="item in group.items"
            :key="item.path"
            :to="item.path"
            class="nav-item"
            :class="{ 'nav-item-active': route.path === item.path }"
          >
            <AppIcon :name="item.icon" :size="17" class="nav-icon" />
            <span class="nav-label">{{ item.title }}</span>
            <span v-if="item.pending" class="nav-soon" title="该页尚未实现，点进去会说明还差什么">建设中</span>
          </RouterLink>
        </template>
      </nav>

      <div class="sidebar-foot">
        <ThemeControl />
        <button type="button" class="logout" @click="onLogout">
          <AppIcon name="logout" :size="16" />
          <span>退出登录</span>
        </button>
      </div>
    </aside>

    <div class="main">
      <header class="topbar">
        <button
          type="button"
          class="icon-btn nav-toggle"
          :aria-expanded="navOpen"
          aria-label="打开导航"
          @click="navOpen = !navOpen"
        >
          <AppIcon :name="navOpen ? 'close' : 'menu'" :size="20" />
        </button>
        <h1 class="page-title">{{ pageTitle }}</h1>
        <span class="spacer" />
        <!--
          刷新指示器 + 最后刷新时间（用户 2026-10-09 要求）。

          ⚠️ **不许改变自身尺寸**：这里是顶栏，任何宽高变化都会把标题和整个内容区推一下
          —— 那正是用户报的"刷新时界面跳动"。所以：
           - 图标只在 `data-refreshing` 时**转 + 变色**（transform / color 不参与布局）；
           - 时间文案每秒都在变，所以给它 `min-width` + `tabular-nums`（见样式），
             宽度由 CSS 固定，不由文字长度决定。
        -->
        <div class="refresh" :data-refreshing="activity.refreshing" :title="refreshTitle">
          <AppIcon name="refresh" :size="15" class="refresh-icon" />
          <span class="refresh-label">最后刷新</span>
          <span class="refresh-age">{{ lastRefreshText }}</span>
        </div>
        <slot name="topbar-actions" />
      </header>

      <main id="main" class="content">
        <RouterView v-slot="{ Component }">
          <component :is="Component" />
        </RouterView>
      </main>
    </div>
  </div>
</template>

<style scoped>
/* ── 启动态 ─────────────────────────────────────────────────── */
.boot {
  display: grid;
  place-items: center;
  height: 100%;
}
.boot-inner {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--s-3);
}
.boot-spinner {
  width: 28px;
  height: 28px;
  border: 2px solid var(--c-border-strong);
  border-top-color: var(--c-brand);
  border-radius: 50%;
  animation: spin 700ms linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

/* ── 外壳骨架 ───────────────────────────────────────────────── */
.shell {
  display: grid;
  grid-template-columns: var(--w-sidebar) minmax(0, 1fr);
  height: 100%;
  height: 100dvh; /* 手机上避开地址栏伸缩导致的 100vh 抖动 */
}

.skip-link {
  position: absolute;
  left: -9999px;
  top: 0;
  z-index: 100;
  padding: var(--s-2) var(--s-4);
  background: var(--c-surface);
  border-radius: 0 0 var(--r-md) 0;
}
.skip-link:focus {
  left: 0;
}

.scrim {
  position: fixed;
  inset: 0;
  z-index: 40;
  background: rgb(0 0 0 / 45%);
  backdrop-filter: blur(1px);
}

/* ── 侧栏 ───────────────────────────────────────────────────── */
.sidebar {
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: var(--c-surface);
  border-right: 1px solid var(--c-border);
}

.brand {
  display: flex;
  align-items: center;
  gap: var(--s-3);
  padding: var(--s-4);
  padding-top: max(var(--s-4), env(safe-area-inset-top));
  border-bottom: 1px solid var(--c-border);
}
.brand-mark {
  display: block;
  flex: none;
  width: 32px;
  height: 32px;
  border-radius: var(--r-md);
  /* 不再垫品牌色：那是给文字色块用的，垫在图片下会在透明像素处透出来 */
  object-fit: contain;
}
.brand-text {
  display: flex;
  flex-direction: column;
  line-height: 1.2;
}
.brand-text strong {
  font-size: var(--t-md);
}
.brand-text small {
  color: var(--c-text-3);
  font-size: var(--t-xs);
}

.nav {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: var(--s-3) var(--s-2) var(--s-4);
}
.nav-group {
  padding: var(--s-3) var(--s-3) var(--s-1);
  color: var(--c-text-3);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}
.nav-item {
  position: relative;
  display: flex;
  align-items: center;
  gap: var(--s-3);
  /* 手机上这是主要导航目标：44px 才够手指点 */
  min-height: var(--touch-min);
  padding: 0 var(--s-3);
  border-radius: var(--r-md);
  color: var(--c-text-2);
  font-size: var(--t-base);
  text-decoration: none;
  transition: background var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease);
}
.nav-item:hover {
  background: var(--c-surface-2);
  color: var(--c-text);
  text-decoration: none;
}
.nav-icon {
  flex: none;
  color: var(--c-text-3);
}
.nav-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.nav-item-active {
  background: var(--c-brand-soft);
  color: var(--c-brand-text);
  font-weight: 600;
}
.nav-item-active .nav-icon {
  color: var(--c-brand);
}
/* 当前项左侧强调条：比整块换色更克制，也更像"当前位置" */
.nav-item-active::before {
  content: '';
  position: absolute;
  left: 0;
  top: 50%;
  translate: 0 -50%;
  width: 3px;
  height: 18px;
  border-radius: 0 var(--r-xs) var(--r-xs) 0;
  background: var(--c-brand);
}
.nav-soon {
  flex: none;
  padding: 1px 5px;
  border-radius: var(--r-xs);
  background: var(--c-surface-3);
  color: var(--c-text-3);
  font-size: 10px;
  font-weight: 500;
}

.sidebar-foot {
  display: flex;
  flex-direction: column;
  gap: var(--s-2);
  padding: var(--s-3);
  padding-bottom: max(var(--s-3), env(safe-area-inset-bottom));
  border-top: 1px solid var(--c-border);
}
.logout {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--s-2);
  min-height: 38px;
  border: 1px solid var(--c-border);
  border-radius: var(--r-md);
  background: transparent;
  color: var(--c-text-2);
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease);
}
.logout:hover {
  background: var(--c-err-soft);
  border-color: transparent;
  color: var(--c-err);
}

/* ── 主区 ───────────────────────────────────────────────────── */
.main {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}

.topbar {
  display: flex;
  align-items: center;
  gap: var(--s-3);
  flex: none;
  height: var(--h-topbar);
  padding: 0 var(--s-5);
  padding-top: env(safe-area-inset-top);
  background: color-mix(in srgb, var(--c-surface) 85%, transparent);
  backdrop-filter: blur(8px);
  border-bottom: 1px solid var(--c-border);
  position: sticky;
  top: 0;
  z-index: 20;
}
.page-title {
  font-size: var(--t-md);
  font-weight: 600;
}

/* ── 顶栏的刷新指示器 + 最后刷新时间 ─────────────────────────────
 *
 * 关键约束：**这一块在任何状态下都必须占同样的宽高**。
 * 顶栏是 sticky 的，它一变尺寸，下面的内容区就跟着挪 —— 用户报的"刷新时跳动"
 * 正是这么来的。所以：
 *  - "正在刷新"只表达为**颜色 + 旋转**（两者都不参与布局，不会 reflow）；
 *  - 时间文案的宽度交给 `min-width`，不交给文字长度。
 */
.refresh {
  display: inline-flex;
  align-items: center;
  gap: var(--s-2);
  flex: none;
  color: var(--c-text-3);
  font-size: var(--t-xs);
  white-space: nowrap;
}
.refresh-icon {
  flex: none;
}
.refresh[data-refreshing='true'] {
  color: var(--c-brand);
}
.refresh[data-refreshing='true'] .refresh-icon {
  /* 复用启动态那个 `spin`（同一个 scoped 样式块里已定义） */
  animation: spin 900ms linear infinite;
}
.refresh-age {
  /* ★ 固定宽度 + 等宽数字：文案每秒都在变（"刚刚" → "12 秒前" → "13:45:02"），
     宽度不定的话它会一直推挤左边的"最后刷新"，整条顶栏跟着抖。
     5.5em 按最长的那几种写法留（"59 分钟前" ≈ 5 个全角字符）。 */
  display: inline-block;
  min-width: 5.5em;
  text-align: right;
  color: var(--c-text-2);
  font-variant-numeric: tabular-nums;
}

.icon-btn {
  display: grid;
  place-items: center;
  width: var(--touch-min);
  height: var(--touch-min);
  margin-left: calc(-1 * var(--s-2));
  border: none;
  border-radius: var(--r-md);
  background: transparent;
  color: var(--c-text-2);
  cursor: pointer;
}
.icon-btn:hover {
  background: var(--c-surface-2);
  color: var(--c-text);
}
/* 桌面端不需要汉堡键：侧栏常驻 */
.nav-toggle {
  display: none;
}

.content {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: var(--s-5);
  padding-bottom: max(var(--s-5), env(safe-area-inset-bottom));
  -webkit-overflow-scrolling: touch;
}

/* ── 手机端：侧栏变抽屉 ─────────────────────────────────────── */
@media (max-width: 899px) {
  .shell {
    grid-template-columns: minmax(0, 1fr);
  }
  .sidebar {
    position: fixed;
    inset: 0 auto 0 0;
    z-index: 50;
    width: min(84vw, 300px);
    translate: -100% 0;
    transition: translate var(--dur) var(--ease);
    box-shadow: var(--sh-3);
  }
  .shell[data-nav-open='true'] .sidebar {
    translate: 0 0;
  }
  .nav-toggle {
    display: grid;
  }
  .topbar {
    padding: 0 var(--s-3);
  }
  .content {
    padding: var(--s-4) var(--s-3);
  }
}

/* 更窄的屏幕上顶栏放不下"最后刷新"这四个字：只留图标 + 时间。
   注意这条只在**断点**上生效，不会随刷新状态变化 —— 所以不会造成刷新时的跳动。 */
@media (max-width: 640px) {
  .refresh-label {
    display: none;
  }
  .refresh-age {
    min-width: 4.5em;
  }
}

/* 桌面上把顶栏的汉堡键位置让给标题，避免左边多出一块空白 */
@media (min-width: 900px) {
  .page-title {
    margin-left: 0;
  }
}
</style>
