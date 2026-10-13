/**
 * 唤醒工具：`schedule_wake` / `register_watcher` / `list_wakes` / `cancel_wake` / `wake_now`
 * （PLAN 阶段 8 交付物 6）。
 *
 * ## 参数描述比参数本身重要
 *
 * 模型看到五个工具时，不会自己去想"定时和监视有什么区别"、
 * "`every` 与 `delaySeconds` 该用哪个"。所以描述里必须写**什么时候用哪个**：
 *  - `schedule_wake`：**到某个时间点**做一件事（一次性用 delaySeconds/at，重复用 everySeconds）；
 *  - `register_watcher`：**某个条件成立**时做一件事（文件出现/内容变化/端口通了）——
 *    它不是定时的，而是"盯着"。
 *
 * 写不清的话，模型会用 `schedule_wake` 每 30 秒轮询一次文件 ——
 * 那是**用定时器模拟监视器**，既费钱又慢（30 秒的延迟 vs 监视器的秒级）。
 *
 * ## 不猜默认值
 *
 * 缺 `delaySeconds` 又不给 `at` 时**直接拒绝**，而不是默认"1 分钟后"。
 * 猜错的话模型会以为自己设了个 10 分钟后的提醒，实际 1 分钟就响了 ——
 * 而它不会去核对，因为"成功了"。
 *
 * @module forlife-memory/wake-tools
 */
import type { ContentBlock } from '@deepseek-ai/dsh-llm'

import { createWakeTrigger, deleteWakeTrigger, getWakeTrigger, listWakeTriggers, type WakeTriggerRow } from '@forlife/store'

import type { MemoryRuntime } from './runtime.ts'
import type { DefineToolLike } from './tools.ts'

/** 工具名（测试与文档共用一份）。 */
export const WAKE_TOOL_NAMES = ['schedule_wake', 'register_watcher', 'list_wakes', 'cancel_wake', 'wake_now'] as const

/** 最小定时间隔（秒）。 */
export const MIN_SCHEDULE_SECONDS = 60

/** 把文本包成内容块。 */
function text(value: string): ContentBlock[] {
  return [{ type: 'text', text: value }]
}

/** 工具依赖的"引擎侧"能力（注入，便于测试）。 */
export interface WakeToolHost {
  /** 立刻触发（`wake_now` 用）。 */
  readonly fireNow: (triggerId: string, reason: string) => Promise<{ readonly decision: string; readonly reason: string }>
  /** 登记监视程序（`register_watcher` 用；由监督器实现，见交付物 3）。 */
  readonly registerProgram?: (
    input: {
      readonly name: string
      readonly contract: 'probe' | 'watcher' | 'service'
      readonly path: string
      readonly spec: unknown
    },
  ) => { readonly ok: boolean; readonly reason: string }
}

/** 从参数里算定时规格。 */
export function parseSchedule(input: Record<string, unknown>, now: Date): { ok: true; spec: unknown; nextFireAt: string } | { ok: false; reason: string } {
  const delay = input['delaySeconds']
  const at = input['at']
  const every = input['everySeconds']

  const delaySeconds = delay === undefined ? undefined : Number(delay)
  const everySeconds = every === undefined ? undefined : Number(every)

  if (delaySeconds !== undefined && !Number.isFinite(delaySeconds)) return { ok: false, reason: 'delaySeconds must be a number' }
  if (everySeconds !== undefined && !Number.isFinite(everySeconds)) return { ok: false, reason: 'everySeconds must be a number' }

  if (delaySeconds !== undefined && everySeconds !== undefined) {
    return { ok: false, reason: 'pass either delaySeconds (one-shot) or everySeconds (repeating), not both - with both, "when is the first one" is undefined' }
  }

  if (delaySeconds !== undefined) {
    if (delaySeconds < MIN_SCHEDULE_SECONDS) {
      // 不给一个"更合理的默认值"，而是**明确拒绝** —— 悄悄改成 60 秒的话，
      // 模型以为自己设了 10 秒，而实际 1 分钟才响，它不会去核对
      return { ok: false, reason: `delaySeconds cannot be less than ${String(MIN_SCHEDULE_SECONDS)} (a shorter schedule is pointless; use wake_now to do it right away)` }
    }
    return { ok: true, spec: { delaySeconds }, nextFireAt: new Date(now.getTime() + delaySeconds * 1000).toISOString() }
  }

  if (everySeconds !== undefined) {
    if (everySeconds < MIN_SCHEDULE_SECONDS) {
      return { ok: false, reason: `everySeconds cannot be less than ${String(MIN_SCHEDULE_SECONDS)} (flood protection)` }
    }
    return { ok: true, spec: { everyMs: everySeconds * 1000 }, nextFireAt: new Date(now.getTime() + everySeconds * 1000).toISOString() }
  }

  if (typeof at === 'string' && at !== '') {
    const when = new Date(at)
    if (Number.isNaN(when.getTime())) return { ok: false, reason: `at is not a valid time: ${at}` }
    if (when.getTime() <= now.getTime()) {
      // 过去的时间点要么是模型算错了、要么是时区理解错了 —— 直接拒绝比"顺延到明天"好
      return { ok: false, reason: `at is already in the past: ${at} (now ${now.toISOString()})` }
    }
    return { ok: true, spec: { at }, nextFireAt: when.toISOString() }
  }

  // **不猜默认值**
  return { ok: false, reason: 'pass one of delaySeconds (seconds from now), everySeconds (repeat every N seconds) or at (an exact time)' }
}

/** 一行摘要（给模型看的）。 */
export function describeTrigger(row: WakeTriggerRow): string {
  const spec = ((): Record<string, unknown> => {
    try {
      return JSON.parse(row.spec) as Record<string, unknown>
    } catch {
      return {}
    }
  })()
  const when =
    row.kind === 'timer'
      ? row.next_fire_at === null
        ? 'finished'
        : `next ${row.next_fire_at}`
      : row.kind === 'watcher'
        ? `watch ${String(spec['path'] ?? '(unspecified)')}`
        : row.kind
  const state = row.enabled === 1 ? '' : ' (disabled)'
  return `${row.title}${state} · ${row.kind} · ${when}`
}

/** 构造唤醒工具。 */
export function buildWakeTools(defineTool: DefineToolLike, runtime: MemoryRuntime, host: WakeToolHost): readonly unknown[] {
  const db = runtime.db
  const now = (): Date => new Date()

  const scheduleTool = defineTool({
    name: 'schedule_wake',
    description:
      'Schedule a future wake for yourself (do something at a point in time).' +
      'For a one-shot use delaySeconds (seconds from now) or at (an exact time); for a repeat use everySeconds (every N seconds).' +
      'The minimum is 60 seconds. **scope is required**: a wake has to be delivered to some conversation to have somewhere to go - ' +
      'without it, the wake is rejected as "nowhere to go" when it fires and the work you wrote will not be done (see the scope parameter).' +
      '**If you want "when some condition holds" rather than "at a point in time", use register_watcher** - ' +
      'simulating a watch with timed polling is both expensive and slow.',
    parameters: {
      title: { type: 'string', required: true, description: 'A short title for this wake (shown in the list).' },
      prompt: {
        type: 'string',
        required: true,
        description: 'What you should do when woken (written for your future self). An empty one wastes the wake, so it is required.',
      },
      delaySeconds: { type: 'number', description: 'Fire once after this many seconds (one-shot). Minimum 60.' },
      everySeconds: { type: 'number', description: 'Fire every this many seconds (repeating). Minimum 60.' },
      at: { type: 'string', description: 'An exact time (ISO 8601). Must be in the future.' },
      scope: {
        type: 'string',
        description:
          'Which conversation to wake (e.g. onebot11:88888). Warning: **omitting it = this wake has nowhere to go**:' +
          'the engine will reject it as "nowhere to go (scope=*)", the work you wrote will not be done, and only a record is left in the list.',
      },
      dailyLimit: { type: 'number', description: 'How many times it may fire per day (0 or omitted = unlimited). Flood protection.' },
      minIntervalMs: { type: 'number', description: 'Minimum interval between fires, in milliseconds (debounce).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          id: { type: 'string', required: true },
          message: { type: 'string', required: true },
        },
      },
      render: (_args: never, value: never): ContentBlock[] => {
        const v = value as { ok: boolean; message: string }
        return text(v.message)
      },
    },
    execute: async (args: never): Promise<unknown> => {
      const input = args as Record<string, unknown>
      runtime.recordToolCall()
      const parsed = parseSchedule(input, now())
      if (!parsed.ok) {
        return { ok: false, id: '', message: parsed.reason }
      }

      const created = createWakeTrigger(db, {
        kind: 'timer',
        scope: typeof input['scope'] === 'string' && input['scope'] !== '' ? input['scope'] : '*',
        title: String(input['title'] ?? ''),
        prompt: String(input['prompt'] ?? ''),
        spec: parsed.spec,
        createdBy: 'model',
        nextFireAt: parsed.nextFireAt,
        ...(input['dailyLimit'] === undefined ? {} : { dailyLimit: Number(input['dailyLimit']) }),
        ...(input['minIntervalMs'] === undefined ? {} : { minIntervalMs: Number(input['minIntervalMs']) }),
        now: now(),
      })
      if (!created.ok || created.row === undefined) {
        return { ok: false, id: '', message: created.reason }
      }
      const message = `Scheduled "${created.row.title}", next ${String(created.row.next_fire_at)} (id ${created.row.id})`
      return { ok: true, id: created.row.id, message }
    },
  })

  const watcherTool = defineTool({
    name: 'register_watcher',
    description:
      'Register a **condition watch**: wake me when a condition holds (a file appears / a file changes / a port opens / command output matches).' +
      'It is not a timer - it watches and calls you as soon as something changes (within seconds), which is faster and cheaper than timed polling.' +
      'Write a watch script (put it in the workspace); once registered, the **gateway-side supervisor** runs it.' +
      'Warning: whether the supervisor is enabled **depends on the deployment**: a successful registration only means "it was recorded",' +
      'so do not state "I am watching it" as a fact.',
    parameters: {
      name: { type: 'string', required: true, description: 'Name of the watch program (unique).' },
      path: { type: 'string', required: true, description: 'Relative path of the script inside the workspace.' },
      contract: {
        type: 'string',
        required: true,
        description:
          'Contract: probe (run once, look at the exit code) / watcher (long-running; one output line counts as a trigger) / service (long-running service, restarted when it dies).',
      },
      title: { type: 'string', required: true, description: 'A short title for this watch.' },
      prompt: { type: 'string', required: true, description: 'What you should do when woken.' },
      scope: {
        type: 'string',
        description:
          'Which conversation to wake (e.g. onebot11:88888). Warning: **omitting it = a triggered watch has nowhere to go**:' +
          'the watch source rejects it as "no bound conversation (scope=*)" and skips it, so nobody handles the event.',
      },
      dailyLimit: { type: 'number', description: 'How many times it may fire per day (0 or omitted = unlimited).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          id: { type: 'string', required: true },
          message: { type: 'string', required: true },
        },
      },
      render: (_args: never, value: never): ContentBlock[] => text((value as { message: string }).message),
    },
    execute: async (args: never): Promise<unknown> => {
      const input = args as Record<string, unknown>
      runtime.recordToolCall()

      const contract = String(input['contract'] ?? '')
      if (!['probe', 'watcher', 'service'].includes(contract)) {
        const reason = `contract must be one of probe / watcher / service; got "${contract}"`
        return { ok: false, id: '', message: reason }
      }
      if (host.registerProgram === undefined) {
        // **未装配就明确拒绝** —— 静默成功的话模型会以为监视在跑，而实际没有
        const reason = 'the watch supervisor is not enabled (the gateway side must be wired up), so this registration did not take effect'
        return { ok: false, id: '', message: reason }
      }

      const name = String(input['name'] ?? '')
      const program = host.registerProgram({
        name,
        contract: contract as 'probe' | 'watcher' | 'service',
        path: String(input['path'] ?? ''),
        spec: {},
      })
      if (!program.ok) return { ok: false, id: '', message: program.reason }

      const created = createWakeTrigger(db, {
        kind: 'watcher',
        scope: typeof input['scope'] === 'string' && input['scope'] !== '' ? input['scope'] : '*',
        title: String(input['title'] ?? ''),
        prompt: String(input['prompt'] ?? ''),
        spec: { program: name, contract, path: input['path'] },
        createdBy: 'model',
        ...(input['dailyLimit'] === undefined ? {} : { dailyLimit: Number(input['dailyLimit']) }),
        now: now(),
      })
      if (!created.ok || created.row === undefined) {
        return { ok: false, id: '', message: created.reason }
      }
      const message = `Watch registered: "${created.row.title}" (${contract}, id ${created.row.id})`
      return { ok: true, id: created.row.id, message }
    },
  })

  const listTool = defineTool({
    name: 'list_wakes',
    description: 'List the wakes and watches you scheduled (with the next fire time and enabled state).',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          rows: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                title: { type: 'string', required: true },
                kind: { type: 'string', required: true },
                enabled: { type: 'boolean', required: true },
                nextFireAt: { type: 'string', required: true },
                // ★ **必须回 prompt**（模型在真机上报出来的 bug）：
                // 模型安排唤醒时会写"到点要做什么"，而这里原来**不返回它** ——
                // 于是模型过一会儿醒来时完全不知道自己当初要做什么，
                // 真机里它只能回"我查不到它对应哪件事"。
                // 列唤醒列表的**主要用途**就是"看看我安排了什么、该做什么"，
                // 不给 prompt 等于让这个工具失去意义。
                prompt: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args: never, value: never): ContentBlock[] => {
        const v = value as { rows: readonly { id: string }[] }
        if (v.rows.length === 0) return text('You have not scheduled any wake yet.')
        // 摘要里要带"下次什么时候 / 路径 / 停用没"这类只有触发器行才知道的信息，
        // 所以在这里按 id 回查 —— execute 的返回值必须**只**是规范化 JSON（见 tools.ts 的约定）
        //
        // ★ **不能用 `!` 把可选性按下去**（模型在真机上报出来的 bug）：
        // `getWakeTrigger` 返回 `WakeTriggerRow | undefined`，行取不到时
        // `describeTrigger(undefined)` 会去读 `undefined.kind` ⇒ **抛异常** ⇒
        // **整个工具失败**，而不是"少显示一条"。
        // 这是"用 ! 按掉可选性"的典型代价：把一条数据的缺失放大成整个功能的失败。
        return text(
          v.rows
            .map((r) => {
              const full = getWakeTrigger(db, r.id)
              if (full === undefined) return `(${r.id} is gone; it may have just been cancelled)`
              // **带上 prompt** —— 模型要能看到自己当初写的任务
              // ★ **必须带上 id**（真机 bug）：cancel_wake / wake_now 都要求传 id，
              // 而它们的说明写的是"list_wakes 里有" —— 列表却不给 id 的话，
              // 模型看得见那条唤醒、却拿它毫无办法（只有"取不到"的分支才漏出 id）。
              return `${describeTrigger(full)} (id ${full.id})\n  work to do when it fires: ${full.prompt}`
            })
            .join('\n'),
        )
      },
    },
    execute: async (): Promise<unknown> => {
      runtime.recordToolCall()
      const rows = listWakeTriggers(db).map((row) => ({
        id: row.id,
        title: row.title,
        kind: row.kind,
        enabled: row.enabled === 1,
        nextFireAt: row.next_fire_at ?? '',
        // ★ 带上 prompt（模型要能看到自己当初写的任务，见 schema 里的说明）
        prompt: row.prompt,
      }))
      // 只返回与 schema 一致的规范化值 —— 不要包 {content, value}：
      // 宿主拿 execute 的返回**原样**跟 output.schema 校验，包一层会让 list_wakes 整个报校验错
      return { ok: true, rows }
    },
  })

  const cancelTool = defineTool({
    name: 'cancel_wake',
    description: 'Cancel a wake or watch you scheduled. **Once cancelled it really will not fire again** - if the work still needs doing, finish it before cancelling.',
    parameters: {
      id: { type: 'string', required: true, description: 'The id to cancel (see list_wakes).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          message: { type: 'string', required: true },
        },
      },
      render: (_args: never, value: never): ContentBlock[] => text((value as { message: string }).message),
    },
    execute: async (args: never): Promise<unknown> => {
      const input = args as Record<string, unknown>
      runtime.recordToolCall()
      const id = String(input['id'] ?? '')
      const existing = getWakeTrigger(db, id)
      if (existing === undefined) {
        const reason = `no such wake: ${id} (use list_wakes to see what exists)`
        return { ok: false, message: reason }
      }
      deleteWakeTrigger(db, id)
      const message = `Cancelled "${existing.title}"`
      return { ok: true, message }
    },
  })

  const nowTool = defineTool({
    name: 'wake_now',
    description:
      'Run a scheduled wake **right now** (without waiting for its time). Use it when you want to do that thing immediately.' +
      'It does not change the original schedule - it will still fire at its time.',
    parameters: {
      id: { type: 'string', required: true, description: 'The id to run immediately (see list_wakes).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          message: { type: 'string', required: true },
        },
      },
      render: (_args: never, value: never): ContentBlock[] => text((value as { message: string }).message),
    },
    execute: async (args: never): Promise<unknown> => {
      const input = args as Record<string, unknown>
      runtime.recordToolCall()
      const id = String(input['id'] ?? '')
      const result = await host.fireNow(id, 'the model asked to run it immediately')
      const ok = result.decision === 'fired'
      const message = ok ? 'Ran immediately' : `could not run: ${result.reason}`
      return { ok, message }
    },
  })

  return [scheduleTool, watcherTool, listTool, cancelTool, nowTool]
}
