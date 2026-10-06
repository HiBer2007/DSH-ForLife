/**
 * 容器尺寸监听 —— 图表要按**真实像素**绘制。
 *
 * 为什么不用 `viewBox` + `preserveAspectRatio="none"` 自适应：
 * 那会把线宽和圆点一起拉伸变形（横线粗、竖线细），一眼就看出是"凑出来的"。
 * 用 ResizeObserver 拿到真实宽度后按像素画，才能保证描边均匀、文字不被压扁。
 */
import { onBeforeUnmount, onMounted, ref, type Ref } from 'vue'

export function useElementSize<T extends HTMLElement>(): {
  readonly element: Ref<T | undefined>
  readonly width: Ref<number>
  readonly height: Ref<number>
} {
  const element = ref<T>()
  const width = ref(0)
  const height = ref(0)
  let observer: ResizeObserver | undefined

  onMounted(() => {
    const target = element.value
    if (target === undefined) return
    observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (entry === undefined) return
      width.value = entry.contentRect.width
      height.value = entry.contentRect.height
    })
    observer.observe(target)
    width.value = target.clientWidth
    height.value = target.clientHeight
  })

  onBeforeUnmount(() => {
    observer?.disconnect()
  })

  return { element, width, height }
}
