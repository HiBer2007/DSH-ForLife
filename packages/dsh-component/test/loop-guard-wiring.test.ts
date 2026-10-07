/**
 * 死循环监控的**接线守卫**测试。
 *
 * ## 为什么要有这一条
 *
 * `loop-guard.test.ts` 验的是**检测器本身**（纯函数，13/13）。
 * 它**证明不了"检测器被调用了"** —— 而**接线正是本项目反复出问题的地方**
 * （`whitelist` 参数被丢、`onConnectionState` 被构造函数丢掉，
 * **两次都是单测全绿**）。
 *
 * 所以这一条**读源码断言接线还在**。它不好看，但它拦的正是
 * "功能写好了、测试全绿、而线上根本没跑"这一类问题。
 *
 * ## 最值得守的三条
 *
 * 1. **检查要在入队之前** —— 一旦入队，那条重复消息就会**真的发出去**，
 *    而"发出去的收不回来"；
 * 2. **要把理由告诉模型** —— 悄悄丢掉的话，它不知道发生了什么，
 *    只会换个说法**接着循环**；
 * 3. **`loopGuard` 必须是长期实例**（不是每次调用 new 一个）——
 *    循环是"跨多次输出"才显形的，每次新建就永远看不出循环。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8')

test('★★ 接线守卫：`qq_reply` 真的调了 loopGuard', () => {
  const src = read('../src/qq-tools.ts')
  assert.match(src, /runtime\.loopGuard\.feed\(/, '**loopGuard 必须真的被调用**')
})

test('★★ 检查在**入队之前**（一旦入队，重复消息就会真的发出去）', () => {
  const src = read('../src/qq-tools.ts')
  const checkAt = src.indexOf('runtime.loopGuard.feed(')
  const enqueueAt = src.indexOf('enqueueOutbound(runtime.db', checkAt)
  assert.ok(checkAt > 0, '找不到检查')
  assert.ok(enqueueAt > checkAt, '**检查必须在 enqueueOutbound 之前** —— 否则拦不住')
})

test('★★ 判定后要**把理由告诉模型**（悄悄丢掉会让它接着循环）', () => {
  const src = read('../src/qq-tools.ts')
  assert.match(src, /检测到你在重复输出/, '**必须告诉模型"你被中止了、为什么"**')
  assert.match(src, /不要再重复/, '要给模型明确的下一步指示')
})

test('★ 拦下时**不入队**（返回 ok:false 且 outboxId 为空）', () => {
  const src = read('../src/qq-tools.ts')
  const start = src.indexOf('runtime.loopGuard.feed(')
  // **只看 loop-guard 那一段**（到它自己的 return 结束）。
  //
  // ⚠️ 第一版是从 feed 切到 enqueueOutbound —— 而 `outboxId: ''` 在
  // **另一个** return 里也有（`!target.ok` 那处），于是断言**匹配错了地方**，
  // **回退验证没变红**。那正是"永远不失败的检查"。
  const seg = src.slice(start, src.indexOf('请**不要再重复**', start) + 60)
  assert.match(seg, /ok: false/, '拦下时要报失败')
  assert.match(seg, /outboxId: ''/, '**outboxId 必须为空** —— 有 id 就意味着入了队')
})

test('★★ `loopGuard` 是**长期实例**（每次 new 一个就永远看不出循环）', () => {
  const src = read('../src/runtime.ts')
  assert.match(src, /readonly loopGuard = new LoopGuard\(\)/, '**必须是字段初始化，不是每次调用新建**')
})

test('★ runtime 真的导入了 LoopGuard', () => {
  const src = read('../src/runtime.ts')
  assert.match(src, /^\s*LoopGuard,$/m, '**导入了才算接上**')
})
