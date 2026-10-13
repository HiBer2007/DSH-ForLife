/**
 * 队列层时序与过滤的测试 —— 用**假时钟**，不睡真实时间。
 *
 * 时序 bug 一旦混进真实链路，表现为"偶尔吞消息""偶尔并发写坏状态"，几乎无法定位；
 * 所以这里把每个边界都钉死：窗口内重置、窗口关闭结算、跨会话互不影响、
 * 串行保证、失败不卡队列、噪音判定的豁免优先级。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { classifyNoise, Debouncer, DEFAULT_NOISE_RULES, KeyedMutex, type NoiseMessage } from '../src/timing.ts'

/** 可控假时钟。 */
function fakeClock(): {
  now: () => number
  setTimer: (callback: () => void, ms: number) => unknown
  clearTimer: (handle: unknown) => void
  advance: (ms: number) => void
  pending: () => number
} {
  let current = 1_000_000
  let seq = 0
  const timers = new Map<number, { at: number; callback: () => void }>()
  return {
    now: () => current,
    setTimer: (callback, ms) => {
      const id = ++seq
      timers.set(id, { at: current + ms, callback })
      return id
    },
    clearTimer: (handle) => {
      timers.delete(handle as number)
    },
    advance: (ms) => {
      current += ms
      for (const [id, timer] of [...timers.entries()]) {
        if (timer.at <= current) {
          timers.delete(id)
          timer.callback()
        }
      }
    },
    pending: () => timers.size,
  }
}

test('防抖：同会话连发 5 条合并为一轮（PLAN §8.2/§8.4）', () => {
  const clock = fakeClock()
  const flushes: { key: string; ids: readonly string[] }[] = []
  const debouncer = new Debouncer({
    windowMs: 3000,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    onFlush: (key, ids) => flushes.push({ key, ids }),
  })

  // 每 500ms 发一条，一共 5 条 —— 每次都在窗口内，计时不断被重置
  for (let i = 1; i <= 5; i++) {
    assert.equal(debouncer.push('onebot11:g1', `msg${String(i)}`), i, `第 ${String(i)} 条应累积到 ${String(i)} 条`)
    clock.advance(500)
  }
  assert.equal(flushes.length, 0, '窗口内不应结算（这正是"合并为一轮"）')

  clock.advance(3000) // 静默 3 秒
  assert.equal(flushes.length, 1)
  assert.deepEqual(flushes[0]?.ids, ['msg1', 'msg2', 'msg3', 'msg4', 'msg5'])
  assert.equal(flushes[0]?.key, 'onebot11:g1')
})

test('防抖：跨会话互不影响，各自独立计时', () => {
  const clock = fakeClock()
  const flushes: string[] = []
  const debouncer = new Debouncer({
    windowMs: 3000,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    onFlush: (key) => flushes.push(key),
  })

  debouncer.push('A', 'a1')
  clock.advance(2000)
  debouncer.push('B', 'b1') // B 开启自己的窗口，不该重置 A
  clock.advance(1500) // A 到 3.5s ⇒ A 结算；B 才 1.5s

  assert.deepEqual(flushes, ['A'], 'A 应当先结算，B 仍在窗口内')
  clock.advance(2000)
  assert.deepEqual(flushes, ['A', 'B'])
  assert.equal(debouncer.pendingCount(), 0)
})

test('防抖：静默期恰好 3 秒时结算（边界）', () => {
  const clock = fakeClock()
  const flushes: string[][] = []
  const debouncer = new Debouncer({
    windowMs: 3000,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    onFlush: (_key, ids) => flushes.push([...ids]),
  })
  debouncer.push('A', 'a1')
  clock.advance(2999)
  assert.equal(flushes.length, 0, '差 1 毫秒不算到点')
  clock.advance(1)
  assert.equal(flushes.length, 1, '到点必须结算')
})

test('防抖：手动 flush 立即结算，且不重复结算', () => {
  const clock = fakeClock()
  const flushes: string[][] = []
  const debouncer = new Debouncer({
    windowMs: 3000,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    onFlush: (_key, ids) => flushes.push([...ids]),
  })
  debouncer.push('A', 'a1')
  assert.deepEqual(debouncer.flush('A'), ['a1'])
  assert.equal(debouncer.flush('A').length, 0, '重复 flush 不该再结算')
  clock.advance(5000)
  assert.equal(flushes.length, 1, '原定时器必须被清掉，不能二次触发')
  assert.equal(clock.pending(), 0, '不该留下悬挂定时器')
})

test('串行：同 key 顺序执行、跨 key 并行', async () => {
  const mutex = new KeyedMutex()
  const order: string[] = []
  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

  const task = (name: string, ms: number): Promise<void> =>
    mutex.run('same', async () => {
      order.push(`${name}:start`)
      await sleep(ms)
      order.push(`${name}:end`)
    })

  // 后提交的虽然更快，但必须等前面的结束
  await Promise.all([task('slow', 40), task('fast', 1)])
  assert.deepEqual(order, ['slow:start', 'slow:end', 'fast:start', 'fast:end'], '同 key 必须严格串行')

  // 跨 key 并行：用**交叉等待**做确定性断言，而不是掐墙钟。
  // 两个任务各自等对方先开始 —— 真并行时两边都能等到；一旦被串行化就会互等死锁。
  // （原先用"两个 30ms 任务总耗时 < 55ms"断言，在整套测试并发跑时会抖，属于坏测试。）
  let signalA: () => void = () => {}
  let signalB: () => void = () => {}
  const aStarted = new Promise<void>((resolve) => {
    signalA = resolve
  })
  const bStarted = new Promise<void>((resolve) => {
    signalB = resolve
  })
  const guard = new Promise<never>((_resolve, reject) => {
    setTimeout(() => reject(new Error('跨 key 被串行化了：两个任务互等超时')), 2000)
  })
  await Promise.race([
    Promise.all([
      mutex.run('k1', async () => {
        signalA()
        await bStarted
      }),
      mutex.run('k2', async () => {
        signalB()
        await aStarted
      }),
    ]),
    guard,
  ])
})

test('串行：前一个任务失败不会卡住该会话（重要）', async () => {
  const mutex = new KeyedMutex()
  await assert.rejects(() => mutex.run('k', async () => Promise.reject(new Error('第一次失败'))), /第一次失败/)
  const result = await mutex.run('k', async () => '第二次成功')
  assert.equal(result, '第二次成功', '一次失败之后必须还能继续处理该会话')
})

test('串行：队列排空后清理 key（不无限增长）', async () => {
  const mutex = new KeyedMutex()
  await mutex.run('k', async () => undefined)
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(mutex.activeKeys(), 0, '排空后应清理')
})

test('噪音过滤：被 @ / 拍一拍 / @全体 永远不算噪音（优先级最高）', () => {
  const base: NoiseMessage = { text: '嗯', isGroup: true, mentionedMe: false, mentionedAll: false, isPoke: false }
  assert.equal(classifyNoise({ ...base, mentionedMe: true }).noise, false, '@我 是明确信号')
  assert.equal(classifyNoise({ ...base, isPoke: true }).noise, false, '拍一拍是明确信号')
  assert.equal(classifyNoise({ ...base, mentionedAll: true }).noise, false, '@全体 是明确信号')
  assert.equal(classifyNoise(base).noise, true, '同样两字，没被 @ 就是噪音')
})

test('噪音过滤：空消息、纯表情、群里两字以内', () => {
  const base: NoiseMessage = { text: '', isGroup: true, mentionedMe: false, mentionedAll: false, isPoke: false }
  assert.equal(classifyNoise(base).rule, 'empty')
  assert.equal(classifyNoise({ ...base, text: '   ' }).rule, 'empty')
  assert.equal(classifyNoise({ ...base, text: '😂😂' }).rule, 'pure-emoji')
  assert.equal(classifyNoise({ ...base, text: '嗯嗯' }).rule, 'too-short-in-group')

  // 私聊里的两字不是噪音（私聊本来就该理）
  assert.equal(classifyNoise({ ...base, text: '嗯嗯', isGroup: false }).noise, false)
  // 群里有实质内容的长句不是噪音
  assert.equal(classifyNoise({ ...base, text: '这个防抖窗口应该设多久比较合适' }).noise, false)
  // 带媒体的消息不是噪音（表情/文件要走媒体路径）
  assert.equal(classifyNoise({ ...base, text: '', mediaKind: 'image' }).noise, false)
})

test('噪音过滤：说话人白名单优先于规则', () => {
  const message: NoiseMessage = { text: '嗯', isGroup: true, mentionedMe: false, mentionedAll: false, isPoke: false, senderId: '10001' }
  assert.equal(classifyNoise(message).noise, true, '默认是噪音')
  const verdict = classifyNoise(message, { allowedSenders: ['10001'] })
  assert.equal(verdict.noise, false)
  assert.equal(verdict.rule, 'allowlist')
})

test('噪音过滤：规则可替换（配置化）', () => {
  const message: NoiseMessage = { text: '很长的正常消息内容', isGroup: true, mentionedMe: false, mentionedAll: false, isPoke: false }
  assert.equal(classifyNoise(message).noise, false, '默认规则下不是噪音')
  const verdict = classifyNoise(message, { rules: [{ name: 'block-all', test: () => true }] })
  assert.equal(verdict.noise, true)
  assert.equal(verdict.rule, 'block-all')
  assert.ok(DEFAULT_NOISE_RULES.length >= 3, '默认规则集应包含基础规则')
})

