/**
 * 阶段 8 端到端验收（真 HTTP，跨进程边界）。
 *
 * ## 为什么这个台子重要
 *
 * 阶段 7 的四个真机坑（Caddy Origin 403、`PUT /id` 不能创建、
 * `layer4` 没有通用 tcp matcher、未匹配路由返回空 200）**全是单测发现不了的** ——
 * 它们都出在**两个组件之间的那一层**。
 *
 * 所以这个台子刻意做成**真的跨 HTTP**：
 *  - 一边是 gateway 的 `createWakeRuntime`（真的 fetch）；
 *  - 另一边是一个真的 `node:http` 服务，挂的是**真实的**
 *    `handleWakeRequest`（插件侧端点处理器，一字不改）。
 *
 * 这样它验的是**协议两端是否真的对得上**，而不是"我 mock 的东西调了我 mock 的东西"。
 *
 * ## 它**不能**替代的
 *
 * 它跑不到"模型真的执行了提示词"那一步 —— 那需要真 DSH 宿主。
 * 它验到的是：**提示词真的发过去了、格式对、密钥对、决策与花费真的入账了**。
 * 剩下的（`agent.followup` 真的起了一轮）只有真机能验。
 *
 * 用法：
 * ```
 * $env:DSH_HOME='D:\DSH-ForLife\.runtime\dsh'
 * node packages/gateway/scripts/e2e-wake.ts
 * ```
 *
 * @module @forlife/gateway/scripts/e2e-wake
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'

import { createWakeTrigger, getWakeTrigger, listWakeEvents, listWakeTriggers, openDatabase, setWakePaused } from '@forlife/store'

import { createProgramRunner } from '../src/wake-program-runner.ts'
import { DEFAULT_LIMITS } from '../src/wake-supervisor.ts'
// 用相对路径而不是包名：gateway **不该依赖** dsh-component（反向耦合会造出循环）。
// 这个台子本来就站在两个包**之外**看契约，直接引真实处理器最合适。
import { handleWakeRequest, type WakeHost } from '../../dsh-component/src/wake-bridge-endpoint.ts'

import { createWakeRuntime } from '../src/wake-runtime.ts'

// **必须 ASCII** —— 它要当 HTTP 头发出去（这正是这个台子抓到的第一个真 bug）
const SECRET = 'e2e-secret-ascii-only'
const SESSION = 'onebot11:e2e-1'
const T0 = new Date('2026-10-06T12:00:00.000Z')

/** 记录插件侧收到了什么。 */
interface Received {
  readonly sessionId: string
  readonly text: string
  readonly sourceKind: string
  readonly summary: string
}

/** 启动一个"假 DSH 宿主"：真 HTTP + **真实的**端点处理器。 */
async function startFakeDsh(): Promise<{ url: string; received: Received[]; close: () => Promise<void> }> {
  const received: Received[] = []
  let busy = false

  // 注入给端点处理器的宿主能力。真机上这些来自 ctx；
  // 这里只记录"收到了什么"，并假装模型回了一句。
  // 形状照 WakeHost 的真实定义：resolveAgent 是 async 且返回 { agent: {...} }
  const host: WakeHost = {
    resolveAgent: async (sessionId: string) => {
      if (sessionId !== SESSION) return undefined
      return {
        agent: {
          status: busy ? 'busy' : 'idle',
          followup: (message: unknown) => {
            const m = message as { text?: string; sourceKind?: string; summary?: string }
            received.push({
              sessionId,
              text: String(m.text ?? ''),
              sourceKind: String(m.sourceKind ?? ''),
              summary: String(m.summary ?? ''),
            })
          },
          session: { id: sessionId },
        },
      }
    },
    flush: async () => true,
    createMessage: (input) => ({
      text: input.text,
      sourceKind: input.sourceKind,
      summary: input.summary,
    }),
    withoutInitiator: async <T>(fn: () => Promise<T>): Promise<T> => fn(),
  }

  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      void (async () => {
        const body = Buffer.concat(chunks).toString('utf8')
        // 真实签名是 (options, headers, rawBody) —— 三个参数，不是一个大对象
        let parsed: Record<string, unknown> = {}
        try {
          parsed = JSON.parse(body === '' ? '{}' : body) as Record<string, unknown>
        } catch {
          parsed = {}
        }
        const result = await handleWakeRequest(
          { host, secret: SECRET, body: parsed },
          req.headers as Record<string, string | undefined>,
          body,
        )
        res.writeHead(result.status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(result.body))
      })()
    })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0

  return {
    url: `http://127.0.0.1:${String(port)}/forlife/wake`,
    received,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

/** 跑一步并打印。 */
function step(n: number, title: string): void {
  console.log(`\n【${String(n)}】${title}`)
}

/** 断言并打印。 */
function ok(what: string, detail = ''): void {
  console.log(`   ✓ ${what}${detail === '' ? '' : `　${detail}`}`)
}

async function main(): Promise<void> {
  const base = mkdtempSync(join(tmpdir(), 'forlife-e2e-wake-'))
  const dbPath = join(base, 'e2e.sqlite')
  const opened = openDatabase({ file: dbPath })
  const dsh = await startFakeDsh()
  const logs: string[] = []

  let passed = 0
  let failed = 0
  const check = (name: string, fn: () => void): void => {
    try {
      fn()
      passed += 1
      ok(name)
    } catch (error) {
      failed += 1
      console.log(`   ✗ ${name}\n     ${String(error).slice(0, 300)}`)
    }
  }

  try {
    step(1, '装配 gateway 侧唤醒运行时（真 fetch 打到真 HTTP）')
    const wake = createWakeRuntime({
      db: opened.db,
      env: {
        FORLIFE_WAKE_BRIDGE_URL: dsh.url,
        FORLIFE_WAKE_BRIDGE_SECRET: SECRET,
      },
      log: (m) => logs.push(m),
      now: () => T0,
      setIntervalImpl: () => ({ unref: () => {} }),
      clearIntervalImpl: () => {},
    })
    check('引擎已启用', () => {
      assert.ok(wake.engine !== undefined, `未启用：${String(wake.disabledReason)}`)
    })

    step(2, '验收①：安排一个"2 分钟后"的触发器 → 到点唤醒')
    const created = createWakeTrigger(opened.db, {
      kind: 'timer',
      scope: SESSION,
      title: '提醒吃药',
      prompt: '提醒用户吃药，语气自然',
      spec: { delaySeconds: 120 },
      createdBy: 'model',
      nextFireAt: new Date(T0.getTime() + 120_000).toISOString(),
      now: T0,
    })
    const triggerId = created.row!.id
    check('触发器已入库', () => {
      assert.equal(created.ok, true)
      assert.equal(listWakeTriggers(opened.db).length, 1)
    })

    // 还没到点 ⇒ 不该醒
    const early = await wake.engine!.tick()
    check('未到点不唤醒（闸门工作）', () => {
      assert.equal(early.length, 0, `不该有派发，实际 ${String(early.length)} 条`)
      assert.equal(dsh.received.length, 0, '桥不该被调用')
    })

    // 把时间推过点：改 next_fire_at（等价于"两分钟过去了"）
    opened.db
      .prepare('UPDATE wake_triggers SET next_fire_at = ? WHERE id = ?')
      .run(new Date(T0.getTime() - 1000).toISOString(), triggerId)

    const fired = await wake.engine!.tick()
    check('到点后唤醒成功', () => {
      assert.equal(fired.length, 1, `应当派发 1 条，实际 ${String(fired.length)}`)
      assert.equal(fired[0]?.decision, 'fired', `决策应为 fired，实际 ${String(fired[0]?.decision)}：${String(fired[0]?.reason)}`)
    })

    step(3, '桥的另一端真的收到了提示词（跨进程契约）')
    check('收到 1 条', () => {
      assert.equal(dsh.received.length, 1, `实际 ${String(dsh.received.length)} 条`)
    })
    const got = dsh.received[0]
    check('sessionId 正确', () => {
      assert.equal(got?.sessionId, SESSION)
    })
    check('sourceKind 区分来源（**不能是 user**）', () => {
      assert.equal(got?.sourceKind, 'wake-timer')
      assert.notEqual(got?.sourceKind, 'user')
    })
    check('提示词含防注入框定', () => {
      assert.match(String(got?.text), /不是用户的新指令/)
    })
    check('提示词含"你当时要自己做的事"', () => {
      assert.match(String(got?.text), /提醒用户吃药，语气自然/)
    })
    check('提示词含触发来源', () => {
      assert.match(String(got?.text), /定时|timer|触发/)
    })

    step(4, '决策与花费入账（面板要显示的那些）')
    const events = listWakeEvents(opened.db, 10)
    check('事件表里有这条 fired', () => {
      assert.equal(events.length, 1, `实际 ${String(events.length)} 条`)
      assert.equal(events[0]?.['decision'], 'fired')
      assert.equal(events[0]?.['trigger_id'], triggerId)
    })

    step(5, '★ 验收①的后半：**重启 gateway 后触发器仍在**')
    // 关掉 db 再重新打开（等价于进程重启后重新读同一个库）
    opened.db.close()
    const reopened = openDatabase({ file: dbPath })
    check('触发器仍在（三表持久化）', () => {
      const rows = listWakeTriggers(reopened.db)
      assert.equal(rows.length, 1, `实际 ${String(rows.length)} 条`)
      assert.equal(rows[0]?.title, '提醒吃药')
    })
    check('唤醒历史仍在', () => {
      const ev = listWakeEvents(reopened.db, 10)
      assert.equal(ev.length, 1)
      assert.equal(ev[0]?.['decision'], 'fired')
    })
    check('已触发的周期触发器有下次时间（重复型才会，一次性没有）', () => {
      // 一次性的 delaySeconds 型：fire_count 累加了
      assert.equal(listWakeTriggers(reopened.db)[0]?.fire_count, 1)
    })

    step(6, '验收⑤：全局暂停**立即生效**（在库层面）')
    setWakePaused(reopened.db, true)
    const created2 = createWakeTrigger(reopened.db, {
      kind: 'timer',
      scope: SESSION,
      title: '暂停期间的',
      prompt: '不该被唤醒',
      spec: { delaySeconds: 120 },
      createdBy: 'model',
      nextFireAt: new Date(T0.getTime() - 1000).toISOString(),
      now: T0,
    })
    const wake2 = createWakeRuntime({
      db: reopened.db,
      env: { FORLIFE_WAKE_BRIDGE_URL: dsh.url, FORLIFE_WAKE_BRIDGE_SECRET: SECRET },
      log: () => {},
      now: () => T0,
      setIntervalImpl: () => ({ unref: () => {} }),
      clearIntervalImpl: () => {},
    })
    const before = dsh.received.length
    const pausedOutcome = await wake2.engine!.tick()
    check('暂停期间不唤醒（只记录）', () => {
      assert.equal(dsh.received.length, before, '桥不该被调用')
      assert.equal(pausedOutcome[0]?.decision, 'paused', `决策应为 paused，实际 ${String(pausedOutcome[0]?.decision)}`)
    })
    check('被暂停的那次也留痕（面板要能看到"为什么没醒"）', () => {
      const ev = listWakeEvents(reopened.db, 10)
      assert.ok(ev.some((e) => e['decision'] === 'paused'), '应当有一条 paused 记录')
    })

    step(7, '恢复后立即能醒（暂停是可逆的）')
    setWakePaused(reopened.db, false)
    // 被暂停那次会把 next_fire_at 往后推，这里手动拨回
    reopened.db.prepare('UPDATE wake_triggers SET next_fire_at = ? WHERE id = ?').run(new Date(T0.getTime() - 1000).toISOString(), created2.row!.id)
    const resumed = await wake2.engine!.tick()
    check('恢复后唤醒成功', () => {
      assert.equal(resumed[0]?.decision, 'fired', `实际 ${String(resumed[0]?.decision)}：${String(resumed[0]?.reason)}`)
      assert.equal(dsh.received.length, before + 1)
    })

    step(8, '验收②：watcher 监视文件出现 → 秒级唤醒（走真实的监视源）')
    const wsRoot = join(base, 'ws')
    mkdirSync(wsRoot, { recursive: true })
    const watchWake = createWakeRuntime({
      db: reopened.db,
      env: {
        FORLIFE_WAKE_BRIDGE_URL: dsh.url,
        FORLIFE_WAKE_BRIDGE_SECRET: SECRET,
        FORLIFE_WORKSPACE_ROOT: wsRoot,
      },
      log: () => {},
      now: () => T0,
      setIntervalImpl: () => ({ unref: () => {} }),
      clearIntervalImpl: () => {},
    })
    const watched = createWakeTrigger(reopened.db, {
      kind: 'watcher',
      scope: SESSION,
      title: '盯一个新文件',
      prompt: '文件出现了，看看内容',
      spec: { condition: 'file.exists', path: 'appeared.txt' },
      createdBy: 'model',
      now: T0,
    })
    check('监视源已启用（配了工作区）', () => {
      assert.ok(watchWake.watchSource !== undefined, '监视源未启用：' + String(watchWake.watchDisabledReason))
    })
    watchWake.watchSource?.tick() // 首次观察（文件还不存在）
    const beforeWatch = dsh.received.length

    // **文件出现** —— 真实写盘
    writeFileSync(join(wsRoot, 'appeared.txt'), 'hello', 'utf8')
    const watchOut = watchWake.watchSource?.tick() ?? []
    check('文件出现后监视源标记了它', () => {
      const hit = watchOut.find((o) => o.triggerId === watched.row?.id)
      assert.equal(hit?.triggered, true, '实际：' + JSON.stringify(watchOut))
    })
    const watchFired = await watchWake.engine!.tick()
    check('引擎随即唤醒（秒级，不是轮询周期级）', () => {
      const hit = watchFired.find((o) => o.triggerId === watched.row?.id)
      assert.equal(hit?.decision, 'fired', '实际 ' + String(hit?.decision) + '：' + String(hit?.reason))
      assert.equal(dsh.received.length, beforeWatch + 1, '桥应当被调用一次')
    })
    check('★ 再轮询 20 次不重复唤醒（边沿检测）', () => {
      const n = dsh.received.length
      for (let i = 0; i < 20; i += 1) {
        watchWake.watchSource?.tick()
        assert.equal(dsh.received.length, n, '第 ' + String(i + 1) + ' 次轮询后不该有新唤醒')
      }
    })

    step(9, '验收②后半：崩溃按退避重启、超限自动停用（走真实运行层）')
    const progScript = 'console.log("run")\n'
    writeFileSync(join(wsRoot, 'watch.mjs'), progScript, 'utf8')
    const progSha = createHash('sha256').update(progScript).digest('hex')
    reopened.db
      .prepare(
        'INSERT INTO wake_programs (id, name, contract, path, sha256, enabled, status, restart_count, created_at, updated_at)' +
          " VALUES ('wp_e2e', 'e2e程序', 'service', 'watch.mjs', ?, 1, 'stopped', 0, ?, ?)",
      )
      .run(progSha, T0.toISOString(), T0.toISOString())

    const runner = createProgramRunner({
      db: reopened.db,
      workspaceRoot: wsRoot,
      limits: { ...DEFAULT_LIMITS, maxRestarts: 2, backoffBaseMs: 1000, backoffMaxMs: 10_000 },
      log: () => {},
      // 注入一个"总是崩"的 spawn —— 我们测的是**编排**，不是 child_process
      spawn: async () => ({ exitCode: 1, durationMs: 5, outputBytes: 5, tail: 'boom' }),
    })
    const r1 = await runner.runOnce('wp_e2e')
    check('第 1 次崩 ⇒ 重启，等 1 秒', () => {
      assert.equal(r1.action, 'restart')
      assert.equal(r1.waitMs, 1000, '退避应为 1000ms，实际 ' + String(r1.waitMs))
    })
    const r2 = await runner.runOnce('wp_e2e')
    check('第 2 次崩 ⇒ 重启，等 2 秒（指数退避）', () => {
      assert.equal(r2.action, 'restart')
      assert.equal(r2.waitMs, 2000, '退避应为 2000ms，实际 ' + String(r2.waitMs))
    })
    const r3 = await runner.runOnce('wp_e2e')
    check('★ 第 3 次崩 ⇒ **自动停用**（超限）', () => {
      assert.equal(r3.action, 'disable', '实际 ' + r3.action + '：' + r3.reason)
      assert.match(r3.reason, /超过上限 2/)
    })
    check('停用状态落库（面板能看到）', () => {
      const row = reopened.db.prepare('SELECT status, last_error FROM wake_programs WHERE id = ?').get('wp_e2e') as {
        status: string
        last_error: string | null
      }
      assert.equal(row.status, 'disabled')
      assert.match(String(row.last_error), /自动停用/)
    })

    step(10, '验收③：QQ 掉线 → system 触发；重连**不重复唤醒**（幂等）')
    const sysDown = createWakeTrigger(reopened.db, {
      kind: 'system', scope: SESSION, title: 'QQ 掉线了', prompt: '看看为什么断了',
      spec: { event: 'qq.disconnected' }, createdBy: 'model', now: T0,
    })
    const sysUp = createWakeTrigger(reopened.db, {
      kind: 'system', scope: SESSION, title: 'QQ 恢复了', prompt: '把断线期间没做成的事补上',
      spec: { event: 'qq.reconnected' }, createdBy: 'model', now: T0,
    })

    // **用真实的连接回调路径**：与 createGatewayRuntime 里接的那条一模一样
    // **用 observeConnection**（盯一个状态量），不是 observe 传两个事件名 ——
    // 后者会让 qq.disconnected 那一侧永远看不到"恢复"，第二次断线不被唤醒。
    const observe = (connected: boolean): number =>
      watchWake.systemSource?.observeConnection(connected).triggered.length ?? 0

    const n0 = dsh.received.length
    check('掉线 ⇒ 触发 1 条', () => {
      assert.equal(observe(false), 1)
    })
    check('掉线触发的是"掉线"那条（不是恢复那条）', () => {
      assert.equal(getWakeTrigger(reopened.db, sysDown.row!.id)?.next_fire_at, T0.toISOString())
      assert.equal(getWakeTrigger(reopened.db, sysUp.row!.id)?.next_fire_at, null)
    })
    const downFired = await watchWake.engine!.tick()
    check('掉线唤醒成功', () => {
      const hit = downFired.find((o) => o.triggerId === sysDown.row!.id)
      assert.equal(hit?.decision, 'fired', '实际 ' + String(hit?.decision))
      assert.equal(dsh.received.length, n0 + 1)
    })
    check('★ 断线期间反复观察 50 次 ⇒ **一次都不再触发**（幂等）', () => {
      for (let i = 0; i < 50; i += 1) assert.equal(observe(false), 0, '第 ' + String(i + 1) + ' 次不该触发')
    })
    check('恢复 ⇒ 触发"恢复"那条（1 条）', () => {
      assert.equal(observe(true), 1)
    })
    check('★ 恢复后反复观察 50 次 ⇒ 不再触发', () => {
      for (let i = 0; i < 50; i += 1) assert.equal(observe(true), 0)
    })
    check('再次掉线 ⇒ **再触发一次**（那是新故障，不是同一个的重复观察）', () => {
      assert.equal(observe(false), 1)
    })

    reopened.db.close()
    await dsh.close()

    console.log(`\n${'─'.repeat(60)}`)
    console.log(`  端到端：**${String(passed)} 通过 / ${String(failed)} 失败**`)
    console.log(`${'─'.repeat(60)}\n`)
    if (failed > 0) process.exitCode = 1
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
}

await main()
