/**
 * 主题：system / light / dark 三态。
 *
 * 为什么要三态而不是一个"深色开关"：手机上大多数人希望**跟随系统**（晚上自动变深），
 * 偶尔又想强行指定。三态能同时满足，而且和 `<html data-theme>` 一一对应，
 * CSS 侧不需要知道任何 JS 逻辑。
 *
 * 首屏防闪白在 `index.html` 里用内联脚本做掉了，这里只负责之后的切换与持久化。
 */
import { computed, ref, watchEffect, type ComputedRef } from 'vue'

export type ThemeMode = 'system' | 'light' | 'dark'

const STORAGE_KEY = 'forlife-theme'

/** 三态在界面上的顺序与文案（顺序即"从跟随到强制"）。 */
export const THEME_MODES: readonly { readonly value: ThemeMode; readonly label: string }[] = [
  { value: 'system', label: '跟随系统' },
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' },
]

function readSaved(): ThemeMode {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved === 'light' || saved === 'dark' || saved === 'system') return saved
  } catch {
    // 隐私模式：读不到就用跟随系统
  }
  return 'system'
}

const mode = ref<ThemeMode>(readSaved())
/** 系统当前是否深色（跟随系统时用来算"实际是不是深色"）。 */
const systemDark = ref(matchMedia('(prefers-color-scheme: dark)').matches)

matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (event) => {
  systemDark.value = event.matches
})

/** 实际生效的深浅（用于图标、图表等需要知道"现在是深是浅"的地方）。 */
const isDark = computed(() => mode.value === 'dark' || (mode.value === 'system' && systemDark.value))

watchEffect(() => {
  const root = document.documentElement
  root.dataset.theme = mode.value
  root.style.colorScheme = isDark.value ? 'dark' : 'light'
  try {
    localStorage.setItem(STORAGE_KEY, mode.value)
  } catch {
    // 存不下就算了，不影响使用
  }
})

export function useTheme(): {
  readonly mode: ComputedRef<ThemeMode>
  readonly isDark: ComputedRef<boolean>
  readonly modes: typeof THEME_MODES
  setMode: (next: ThemeMode) => void
  /** 在浅/深之间直接对调（顶栏那个一键按钮用）。 */
  toggle: () => void
} {
  return {
    mode: computed(() => mode.value),
    isDark,
    modes: THEME_MODES,
    setMode(next) {
      mode.value = next
    },
    toggle() {
      // 注意：从 system 切走时，要对调到"当前实际样子"的反面，否则用户按一下没反应
      mode.value = isDark.value ? 'light' : 'dark'
    },
  }
}
