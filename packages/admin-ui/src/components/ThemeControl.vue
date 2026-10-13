<script setup lang="ts">
/**
 * 主题切换：跟随系统 / 浅色 / 深色 三态分段控件。
 *
 * 手机端放侧栏抽屉底部（拇指够得到），桌面端也放侧栏 —— 位置一致，不用记两套。
 */
import AppIcon from './AppIcon.vue'
import { useTheme } from '../composables/useTheme.ts'

const theme = useTheme()

const ICONS: Record<string, string> = { system: 'monitor', light: 'sun', dark: 'moon' }
</script>

<template>
  <div class="theme" role="radiogroup" aria-label="界面主题">
    <button
      v-for="item in theme.modes"
      :key="item.value"
      type="button"
      role="radio"
      class="theme-btn"
      :aria-checked="theme.mode.value === item.value"
      :data-active="theme.mode.value === item.value"
      :title="item.label"
      @click="theme.setMode(item.value)"
    >
      <AppIcon :name="ICONS[item.value] ?? 'monitor'" :size="15" />
      <span>{{ item.label }}</span>
    </button>
  </div>
</template>

<style scoped>
.theme {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 2px;
  padding: 2px;
  background: var(--c-surface-2);
  border-radius: var(--r-md);
}

.theme-btn {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  /* 手机上这是拇指目标，不能小于 36px；横向已由三等分撑开 */
  min-height: 40px;
  padding: var(--s-1) 2px;
  border: none;
  border-radius: var(--r-sm);
  background: transparent;
  color: var(--c-text-3);
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease);
}

.theme-btn span {
  font-size: 10px;
  line-height: 1.2;
}

.theme-btn:hover {
  color: var(--c-text);
}

.theme-btn[data-active='true'] {
  background: var(--c-surface);
  color: var(--c-text);
  box-shadow: var(--sh-1);
}
</style>
