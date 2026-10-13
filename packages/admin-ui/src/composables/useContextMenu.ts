/**
 * 右键菜单（含**移动端长按**）。
 *
 * ## 为什么必须把长按做进来
 *
 * 用户要求「所有地方应该有右键菜单的都应该要有」。但**手机上根本没有右键** ——
 * 只做 `contextmenu` 的话，这些功能在移动端等于不存在，
 * 而这个面板明确要求支持手机端。所以长按是**必需品，不是加分项**。
 *
 * ## 为什么做成 composable 而不是每页写一遍
 *
 * 菜单要处理一堆容易写漏的细节：边界翻转（贴着屏幕右边弹出去会被裁掉）、
 * 点击外部关闭、Esc 关闭、滚动关闭、长按与滚动的冲突（手指滑一下不该弹菜单）。
 * 每页重写一遍，迟早会有一页漏掉其中几条，表现是"那个页面的菜单怪怪的"。
 *
 * ## 一个容易忽略的冲突：长按 vs 滚动
 *
 * 手指按在列表上想滚动时也会触发 `touchstart`。如果不处理，
 * **每次滚动都会弹出菜单**。这里的做法是：手指移动超过阈值（10px）就取消长按计时，
 * 也就是"滚动优先"——因为滚动是更高频的操作，误弹菜单比不弹更烦人。
 *
 * @module admin-ui/composables/useContextMenu
 */
import { onBeforeUnmount, ref, type Ref } from 'vue'

/** 一个菜单项。 */
export interface ContextMenuItem {
  readonly key: string
  readonly label: string
  /** 危险操作（删除等）会标红，避免误点。 */
  readonly danger?: boolean
  readonly disabled?: boolean
  /** 次要说明（如"当前已启用"）。 */
  readonly hint?: string
  readonly run: () => void | Promise<void>
}

/** 菜单状态。 */
export interface ContextMenuState {
  readonly open: boolean
  readonly x: number
  readonly y: number
  readonly items: readonly ContextMenuItem[]
  /** 触发菜单的那一行（页面用它知道"对谁操作"）。 */
  readonly payload: unknown
}

/** 长按判定阈值。 */
const LONG_PRESS_MS = 500
/** 手指移动超过这个距离就认为是滚动，取消长按。 */
const MOVE_TOLERANCE_PX = 10
/** 菜单离屏幕边缘的最小距离（防止贴边被裁）。 */
const EDGE_MARGIN_PX = 8

/**
 * 创建右键菜单。
 *
 * @returns 菜单状态与绑定函数。
 */
export function useContextMenu(): {
  readonly state: Ref<ContextMenuState>
  /** 给元素绑 `@contextmenu`。 */
  readonly onContextMenu: (event: MouseEvent, items: readonly ContextMenuItem[], payload?: unknown) => void
  /** 给元素绑 `@touchstart` / `@touchmove` / `@touchend`（移动端长按）。 */
  readonly touchHandlers: (items: readonly ContextMenuItem[], payload?: unknown) => {
    onTouchstart: (event: TouchEvent) => void
    onTouchmove: (event: TouchEvent) => void
    onTouchend: () => void
    onTouchcancel: () => void
  }
  readonly close: () => void
  /** 菜单打开时把坐标夹进视口（组件在渲染后调用，因为它知道菜单实际尺寸）。 */
  readonly clampToViewport: (width: number, height: number) => void
} {
  const state = ref<ContextMenuState>({ open: false, x: 0, y: 0, items: [], payload: undefined })

  const close = (): void => {
    state.value = { ...state.value, open: false }
  }

  /** 打开菜单（坐标先按视口夹一次，菜单渲染后再按实际尺寸夹一次）。 */
  const openAt = (x: number, y: number, items: readonly ContextMenuItem[], payload: unknown): void => {
    state.value = {
      open: true,
      x: Math.min(x, Math.max(EDGE_MARGIN_PX, window.innerWidth - 200)),
      y: Math.min(y, Math.max(EDGE_MARGIN_PX, window.innerHeight - 120)),
      items,
      payload,
    }
  }

  const onContextMenu = (event: MouseEvent, items: readonly ContextMenuItem[], payload?: unknown): void => {
    // 必须阻止默认菜单，否则浏览器的原生菜单会盖在我们的上面
    event.preventDefault()
    event.stopPropagation()
    openAt(event.clientX, event.clientY, items, payload)
  }

  // ── 移动端长按 ──────────────────────────────────────────────────────
  let timer: ReturnType<typeof setTimeout> | undefined
  let startX = 0
  let startY = 0
  let longPressed = false

  const cancelTimer = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
  }

  const touchHandlers = (items: readonly ContextMenuItem[], payload?: unknown) => ({
    onTouchstart: (event: TouchEvent): void => {
      const touch = event.touches[0]
      if (touch === undefined) return
      startX = touch.clientX
      startY = touch.clientY
      longPressed = false
      cancelTimer()
      timer = setTimeout(() => {
        longPressed = true
        // 长按触发时给一次轻微反馈（有振动 API 就用，没有就算了）
        if (typeof navigator.vibrate === 'function') navigator.vibrate(10)
        openAt(startX, startY, items, payload)
      }, LONG_PRESS_MS)
    },
    onTouchmove: (event: TouchEvent): void => {
      const touch = event.touches[0]
      if (touch === undefined) return
      // 滚动优先：手指移动超过阈值 ⇒ 取消长按。
      // 不这么做的话，**每次滚动都会弹菜单**，比不弹更烦人。
      if (Math.abs(touch.clientX - startX) > MOVE_TOLERANCE_PX || Math.abs(touch.clientY - startY) > MOVE_TOLERANCE_PX) {
        cancelTimer()
      }
    },
    onTouchend: (): void => {
      cancelTimer()
      // 长按已经弹了菜单 ⇒ 阻止随后的 click，否则会"点穿"到底下的元素上
      if (longPressed) longPressed = false
    },
    onTouchcancel: (): void => {
      cancelTimer()
    },
  })

  const clampToViewport = (width: number, height: number): void => {
    if (!state.value.open) return
    const maxX = Math.max(EDGE_MARGIN_PX, window.innerWidth - width - EDGE_MARGIN_PX)
    const maxY = Math.max(EDGE_MARGIN_PX, window.innerHeight - height - EDGE_MARGIN_PX)
    state.value = {
      ...state.value,
      x: Math.min(state.value.x, maxX),
      y: Math.min(state.value.y, maxY),
    }
  }

  // ── 全局关闭 ────────────────────────────────────────────────────────
  const onDocumentClick = (): void => close()
  const onKeydown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') close()
  }
  const onScroll = (): void => close()

  if (typeof document !== 'undefined') {
    document.addEventListener('click', onDocumentClick)
    document.addEventListener('keydown', onKeydown)
    // capture: true —— 滚动发生在内层容器里时也要能收到（冒泡收不到）
    window.addEventListener('scroll', onScroll, true)
  }

  onBeforeUnmount(() => {
    cancelTimer()
    if (typeof document !== 'undefined') {
      document.removeEventListener('click', onDocumentClick)
      document.removeEventListener('keydown', onKeydown)
      window.removeEventListener('scroll', onScroll, true)
    }
  })

  return { state, onContextMenu, touchHandlers, close, clampToViewport }
}
