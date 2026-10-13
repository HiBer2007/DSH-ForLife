<script setup lang="ts">
/**
 * 右键菜单的渲染组件。
 *
 * 与 `useContextMenu` 分工：composable 管**交互与状态**（什么时候弹、弹在哪、怎么关），
 * 组件管**长什么样**。这样同一套交互能用在任何页面上，外观也只有一处要改。
 *
 * 一个必须做的事：**菜单渲染后要按实际尺寸再夹一次坐标**。
 * composable 里那次夹用的是估算尺寸（还不知道菜单多宽），
 * 靠近屏幕右下角时仍然可能被裁掉一截。
 */
import { nextTick, ref, watch } from 'vue'

import type { ContextMenuState } from '../composables/useContextMenu.ts'

const props = defineProps<{
  readonly state: ContextMenuState
  readonly onClose: () => void
  readonly onClamp: (width: number, height: number) => void
}>()

const root = ref<HTMLElement | null>(null)

watch(
  () => props.state.open,
  async (open) => {
    if (!open) return
    await nextTick()
    const element = root.value
    if (element === null) return
    // 按**实际**尺寸再夹一次（composable 那次用的是估算值）
    props.onClamp(element.offsetWidth, element.offsetHeight)
  },
)

/** 执行菜单项：先关菜单再执行 —— 否则动作里弹的对话框会被菜单盖住。 */
async function run(item: ContextMenuState['items'][number]): Promise<void> {
  if (item.disabled === true) return
  props.onClose()
  await item.run()
}
</script>

<template>
  <Teleport to="body">
    <div
      v-if="state.open"
      ref="root"
      class="ctx-menu"
      role="menu"
      :style="{ left: `${state.x}px`, top: `${state.y}px` }"
      @click.stop
      @contextmenu.prevent
    >
      <button
        v-for="item in state.items"
        :key="item.key"
        type="button"
        role="menuitem"
        class="ctx-item"
        :data-danger="item.danger === true"
        :disabled="item.disabled === true"
        @click="run(item)"
      >
        <span class="ctx-label">{{ item.label }}</span>
        <span v-if="item.hint" class="ctx-hint">{{ item.hint }}</span>
      </button>
    </div>
  </Teleport>
</template>

<style scoped>
.ctx-menu {
  position: fixed;
  z-index: 1000;
  min-width: 160px;
  max-width: 260px;
  padding: 4px;
  background: var(--c-surface);
  border: 1px solid var(--c-border-strong);
  border-radius: var(--r-md);
  box-shadow: var(--sh-2, 0 8px 24px rgb(0 0 0 / 18%));
  /* 菜单项要够大：手机上手指点得中（触摸目标 ≥44px 是既定的无障碍约定） */
  animation: ctx-in 90ms ease-out;
}

@keyframes ctx-in {
  from {
    opacity: 0;
    transform: scale(0.97);
  }
}

.ctx-item {
  display: flex;
  align-items: baseline;
  gap: var(--s-2);
  width: 100%;
  min-height: var(--touch-min, 44px);
  padding: 0 var(--s-3);
  border: none;
  border-radius: var(--r-sm);
  background: transparent;
  color: var(--c-text);
  font-size: var(--t-sm);
  text-align: left;
  cursor: pointer;
}
.ctx-item:hover:not(:disabled) {
  background: var(--c-surface-2);
}
.ctx-item:disabled {
  color: var(--c-text-3);
  cursor: default;
}
.ctx-item[data-danger='true'] {
  color: var(--c-err, #d9534f);
}

.ctx-label {
  flex: 1;
  min-width: 0;
}
.ctx-hint {
  color: var(--c-text-3);
  font-size: var(--t-xs);
  white-space: nowrap;
}
</style>
