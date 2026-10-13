/**
 * headless 驱动的**命令行契约**（回归测试）。
 *
 * ## 为什么要专门钉这一条
 *
 * 这条契约已经在真机上踩过两次，而且**两次的症状都不像"参数写错了"**：
 *
 * 1. 提示词当命令行参数传、又开着 `shell: true` ⇒ Windows 的 `cmd.exe` 在第一个换行处
 *    把命令截断，模型只收到模板第一行 —— 看起来像"系统唤醒没有内容"。
 * 2. 改成走 stdin 之后，args 里仍留着一个 `headless`。可启动器里
 *    `dsh <name>` 只是 `--profile <name>` 的缩写（`dsh/lib/bin.js:128`），
 *    **并没有 `headless` 子命令** —— 于是它被 headless 应用当成**任务位置参数**：
 *    `program.args = ['headless']` ⇒ `task = 'headless'` ⇒ stdin 里那整段提示词被忽略。
 *    真机表现：每一轮唤醒只收到一个词「headless」。
 *
 * 两次都不会被"跑一遍看结果"以外的单测抓到，除非把**实参形状**钉死。
 * 所以这里断言的是 args 的精确值，而不是"包含哪些词"。
 */
import assert from 'node:assert/strict'
import type { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'

import { HeadlessTurnDriver } from '../src/driver.ts'

/** 一次 spawn 的实参（只记我们断言得到的那部分）。 */
interface SpawnCall {
  readonly bin: string
  readonly args: readonly string[]
  readonly options: { readonly stdio?: unknown; readonly shell?: unknown }
}

/** 假子进程：只实现驱动真正用到的那几个面。 */
class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly stdin = new PassThrough()

  kill(): boolean {
    setImmediate(() => this.emit('close', 1))
    return true
  }
}

/**
 * 造一个 `spawn` 替身：记下实参、把 stdin 收全，再吐一行 NDJSON 并关闭。
 *
 * @param exitCode - 假子进程的退出码。
 * @returns 替身、收到的 spawn 实参、收到的 stdin 全文。
 */
function makeSpawn(exitCode = 0): { spawnImpl: typeof spawn; calls: SpawnCall[]; prompts: string[] } {
  const calls: SpawnCall[] = []
  const prompts: string[] = []
  const spawnImpl = ((bin: string, args: readonly string[], options: SpawnCall['options']) => {
    calls.push({ bin, args, options })
    const child = new FakeChild()
    let prompt = ''
    child.stdin.setEncoding('utf8')
    child.stdin.on('data', (chunk: string) => {
      prompt += chunk
    })
    child.stdin.on('finish', () => {
      prompts.push(prompt)
      // **先让 stdout 的数据投到 'data' 监听者，再关进程** ——
      // 同一 tick 里 emit('close') 会让 Promise 先 resolve，消费方读到空 segments。
      void delay(10).then(() => {
        child.stdout.write(`${JSON.stringify({ type: 'text', text: `收到：${prompt}` })}\n`)
        child.stdout.write(`${JSON.stringify({ type: 'usage', input_tokens: 7, output_tokens: 3 })}\n`)
        child.emit('close', exitCode)
      })
    })
    return child
  }) as unknown as typeof spawn
  return { spawnImpl, calls, prompts }
}

/** 一条多行提示词 —— 与 `buildWakePrompt()` 的形状一致（且**第一行不是命令**）。 */
const MULTILINE_PROMPT = [
  '[系统唤醒] 这不是用户发来的消息，而是你自己之前设的触发器到点了。',
  '',
  '## 触发',
  '- 标题：验收①真机：stdin 正确传参后',
  '- 原因：定时到点',
  '',
  '## 你当时要自己做的事',
  '这是定时唤醒验收。请只回一句：验收①通过。',
].join('\n')

test('headless 驱动：任务不占命令行位置参数，多行提示词整段走 stdin', async () => {
  const { spawnImpl, calls, prompts } = makeSpawn()
  const driver = new HeadlessTurnDriver({ spawnImpl })

  const outcome = await driver.run({
    turnId: 'turn_test',
    conversation: { platform: 'onebot11', chatId: '2166227840', kind: 'private' },
    messages: [],
    prompt: MULTILINE_PROMPT,
    signal: new AbortController().signal,
  })

  const call = calls[0]
  assert.ok(call !== undefined, '应当 spawn 过一次')
  // ★ 精确断言：位置参数一个都不能有（既没有 headless，也没有 `-`，更没有提示词）。
  assert.deepEqual([...call.args], ['--profile', 'forlife-headless', '--json'])
  assert.ok(
    !call.args.some((argument) => argument.includes('\n')),
    '提示词绝不能进 args：多行过 shell 会在换行处被截断',
  )

  assert.equal(call.options.shell, true, 'Windows 上 dsh 是垫片，仍要走 shell')
  assert.deepEqual(call.options.stdio, ['pipe', 'pipe', 'pipe'], 'stdin 必须是 pipe，否则写不进提示词')
  assert.equal(prompts[0], MULTILINE_PROMPT, 'stdin 必须收到完整提示词（换行不截断）')

  assert.equal(outcome.segments?.join('\n'), `收到：${MULTILINE_PROMPT}`)
  assert.equal(outcome.tokensIn, 7)
  assert.equal(outcome.tokensOut, 3)
  assert.equal(outcome.error, undefined)
})

test('headless 驱动：换 profile 也不会多出位置参数', async () => {
  const { spawnImpl, calls } = makeSpawn()
  const driver = new HeadlessTurnDriver({ spawnImpl, profile: 'forlife-qq' })

  await driver.run({
    turnId: 'turn_test2',
    conversation: { platform: 'onebot11', chatId: '1', kind: 'group' },
    messages: [],
    prompt: '一句话任务',
    signal: new AbortController().signal,
  })

  assert.deepEqual([...(calls[0]?.args ?? [])], ['--profile', 'forlife-qq', '--json'])
})
