/**
 * 轮询节奏（`poll-schedule.ts`）的测试 —— **可见性、失败退避、卸载清理**。
 *
 * ## 为什么必须测这一层（而不是只测页面）
 *
 * 「运行总览不实时刷新」的形态不是"没有定时器"：定时器**看起来在跑**
 * （`setInterval` 在那儿、控制台没有任何报错），但页面上最大的一块
 * ——「运行图表」（走 `/series`）——**从打开页面起一次都没刷过**，
 * 因为刷新写死在页面里，只覆盖了一半数据源。
 *
 * 单测抓不到这种"接线只接了一半"，读数守卫也抓不到。所以这里把节奏抽成
 * 状态机（`Poller`），用**假时钟**把它钉死：可见性、退避、清理各一条。
 *
 * ## 这份测试怎么判
 *
 * 假时钟把"时间"握在手里 ⇒ 可以精确断言"第 N 次请求发生在第几毫秒"，
 * 而不是 `sleep(1000)` 之后猜。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { Poller, type PollClock } from '../src/poll-schedule.ts'

/** 让 `await task()` 的微任务链跑完（假时钟不推进时间，只让在飞的落地）。 */
async function settle(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve)
  })
}

/** 假时钟：时间由测试推进，"到点执行"与真实定时器同语义。 */
class FakeClock implements PollClock {
  #now = 0
  #nextId = 1
  readonly #timers = new Map<number, { at: number; handler: () => void }>()

  setTimeout(handler: () => void, ms: number): number {
    const id = this.#nextId
    this.#nextId += 1
    this.#timers.set(id, { at: this.#now + ms, handler })
    return id
  }

  clearTimeout(id: number): void {
    this.#timers.delete(id)
  }

  /** 还没到点的定时器有几个（"卸载后不许留定时器"就靠它验）。 */
  get pending(): number {
    return this.#timers.size
  }

  /** 把时间往前推 `ms`，沿途到点的一个个执行（执行中新建的按新时间算）。 */
  async advance(ms: number): Promise<void> {
    const target = this.#now + ms
    for (;;) {
      const due = [...this.#timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((a, b) => a[1].at - b[1].at)[0]
      if (due === undefined) break
      const [id, timer] = due
      this.#timers.delete(id)
      this.#now = timer.at
      timer.handler()
      await settle()
    }
    this.#now = target
  }

  /** 不推进时间，只让在飞的回调落地。 */
  async flush(): Promise<void> {
    await settle()
  }
}

/** 记数的取数函数（成功）。 */
function counter(): { readonly calls: number; readonly task: () => Promise<boolean> } {
  let calls = 0
  return {
    get calls(): number {
      return calls
    },
    task: async (): Promise<boolean> => {
      calls += 1
      return true
    },
  }
}

test('★ `start()` 不立即拉；到点才拉一次（首次取数由 useAsyncData 负责，免得开局打两次）', async () => {
  const clock = new FakeClock()
  const hits = counter()
  const poller = new Poller({ baseMs: 1000, task: hits.task, clock })

  poller.start()
  assert.equal(hits.calls, 0, 'start() 不该立刻发请求')

  await clock.advance(999)
  assert.equal(hits.calls, 0, '没到点不许拉')

  await clock.advance(1)
  assert.equal(hits.calls, 1, '到点要拉一次')

  await clock.advance(1000)
  assert.equal(hits.calls, 2, '之后每个间隔一次')

  poller.stop()
})

test('★★★ 不可见时**一个请求都不发**且不留定时器；切回来**立刻补一次**', async () => {
  const clock = new FakeClock()
  const hits = counter()
  const poller = new Poller({ baseMs: 1000, task: hits.task, clock })

  poller.start()
  await clock.advance(1000)
  assert.equal(hits.calls, 1)

  poller.pause()
  assert.equal(clock.pending, 0, '暂停要**连定时器一起清掉**（不是留着空转再判断）')
  await clock.advance(60 * 60 * 1000)
  assert.equal(hits.calls, 1, '不可见期间一个请求都不许发（手机后台省电省流量）')

  poller.resume()
  await clock.flush()
  assert.equal(hits.calls, 2, '**切回前台要立刻补一次** —— 等一个间隔的话，用户看到的还是旧数字')

  await clock.advance(1000)
  assert.equal(hits.calls, 3, '补完之后回到正常节奏')

  poller.stop()
})

test('★★★ 失败要退避（2×、4×…封顶），成功**立刻**回到正常间隔', async () => {
  const clock = new FakeClock()
  let ok = false
  let calls = 0
  const poller = new Poller({
    baseMs: 1000,
    maxMs: 8000,
    clock,
    task: async (): Promise<boolean> => {
      calls += 1
      return ok
    },
  })

  poller.start()
  await clock.advance(1000)
  assert.equal(calls, 1)
  assert.equal(poller.failures, 1)
  assert.equal(poller.delayMs, 2000, '失败一次 ⇒ 退避到 2 倍')

  await clock.advance(2000)
  assert.equal(poller.delayMs, 4000, '连续失败 ⇒ 继续翻倍')

  await clock.advance(4000)
  assert.equal(poller.delayMs, 8000)

  await clock.advance(8000)
  assert.equal(calls, 4)
  assert.equal(poller.delayMs, 8000, '**退避必须封顶**（不能无限涨）')

  ok = true
  await clock.advance(8000)
  assert.equal(poller.failures, 0, '成功要清零失败计数')
  assert.equal(poller.delayMs, 1000, '**成功后立刻回到正常间隔**（否则会一直慢下去）')

  poller.stop()
})

test('★★★ `stop()` 之后一个请求都不许再发（含"在飞的那次回来"也不许重排）', async () => {
  const clock = new FakeClock()
  let calls = 0
  let release: (() => void) | undefined
  const poller = new Poller({
    baseMs: 1000,
    clock,
    task: () =>
      new Promise<boolean>((resolve) => {
        calls += 1
        release = (): void => {
          resolve(true)
        }
      }),
  })

  poller.start()
  await clock.advance(1000)
  assert.equal(calls, 1, '第一次已经在飞')

  poller.stop()
  release?.()
  await clock.flush()
  assert.equal(clock.pending, 0, '在飞的那次回来也**不许再排定时器**（否则就是卸载后的泄漏）')

  await clock.advance(60 * 60 * 1000)
  assert.equal(calls, 1, 'stop() 之后一个请求都不许再发')
})

test('★★ 上一次还没回来时**不叠着发**（慢接口 + 短间隔）', async () => {
  const clock = new FakeClock()
  let calls = 0
  let resolveTask: (() => void) | undefined
  const poller = new Poller({
    baseMs: 1000,
    clock,
    task: () =>
      new Promise<boolean>((resolve) => {
        calls += 1
        resolveTask = (): void => {
          resolve(true)
        }
      }),
  })

  poller.start()
  await clock.advance(5000)
  assert.equal(calls, 1, '上一次没回来时不许叠着发（服务慢的时候会自己把自己打垮）')

  resolveTask?.()
  await clock.flush()
  await clock.advance(1000)
  assert.equal(calls, 2, '上一次回来之后，节奏照旧')

  poller.stop()
})

test('★ `canPoll()` 为假时"跳过这一拍"，但**必须留下一次**（不许静默死掉）', async () => {
  const clock = new FakeClock()
  let visible = false
  const hits = counter()
  const poller = new Poller({ baseMs: 1000, clock, canPoll: () => visible, task: hits.task })

  poller.start()
  await clock.advance(1000)
  assert.equal(hits.calls, 0, '不可见时不许发请求')
  assert.equal(clock.pending, 1, '跳过之后必须还留着下一次 —— 否则回到前台就再也不刷了')

  visible = true
  await clock.advance(1000)
  assert.equal(hits.calls, 1)

  poller.stop()
})

test('★ `start()` / `stop()` 幂等（重复调用不炸、也不排出两个定时器）', async () => {
  const clock = new FakeClock()
  const hits = counter()
  const poller = new Poller({ baseMs: 1000, task: hits.task, clock })

  poller.start()
  poller.start()
  assert.equal(clock.pending, 1, '重复 start 不该排出两个定时器')

  await clock.advance(1000)
  assert.equal(hits.calls, 1, '也不该拉两次')

  poller.stop()
  poller.stop()
  await clock.advance(10_000)
  assert.equal(hits.calls, 1, 'stop 之后连重复调用也不该复活')
  assert.equal(clock.pending, 0)
})
