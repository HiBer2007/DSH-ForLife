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

  if (delaySeconds !== undefined && !Number.isFinite(delaySeconds)) return { ok: false, reason: 'delaySeconds 必须是数字' }
  if (everySeconds !== undefined && !Number.isFinite(everySeconds)) return { ok: false, reason: 'everySeconds 必须是数字' }

  if (delaySeconds !== undefined && everySeconds !== undefined) {
    return { ok: false, reason: 'delaySeconds（一次性）与 everySeconds（重复）只能给一个 —— 两个都给的话"第一次什么时候"就说不清了' }
  }

  if (delaySeconds !== undefined) {
    if (delaySeconds < MIN_SCHEDULE_SECONDS) {
      // 不给一个"更合理的默认值"，而是**明确拒绝** —— 悄悄改成 60 秒的话，
      // 模型以为自己设了 10 秒，而实际 1 分钟才响，它不会去核对
      return { ok: false, reason: `delaySeconds 不能小于 ${String(MIN_SCHEDULE_SECONDS)}（太短的定时没有意义，用 wake_now 立刻做）` }
    }
    return { ok: true, spec: { delaySeconds }, nextFireAt: new Date(now.getTime() + delaySeconds * 1000).toISOString() }
  }

  if (everySeconds !== undefined) {
    if (everySeconds < MIN_SCHEDULE_SECONDS) {
      return { ok: false, reason: `everySeconds 不能小于 ${String(MIN_SCHEDULE_SECONDS)}（防刷屏）` }
    }
    return { ok: true, spec: { everyMs: everySeconds * 1000 }, nextFireAt: new Date(now.getTime() + everySeconds * 1000).toISOString() }
  }

  if (typeof at === 'string' && at !== '') {
    const when = new Date(at)
    if (Number.isNaN(when.getTime())) return { ok: false, reason: `at 不是合法时间：${at}` }
    if (when.getTime() <= now.getTime()) {
      // 过去的时间点要么是模型算错了、要么是时区理解错了 —— 直接拒绝比"顺延到明天"好
      return { ok: false, reason: `at 已经是过去时间：${at}（现在是 ${now.toISOString()}）` }
    }
    return { ok: true, spec: { at }, nextFireAt: when.toISOString() }
  }

  // **不猜默认值**
  return { ok: false, reason: '必须给 delaySeconds（多少秒后）、everySeconds（每多少秒）或 at（具体时刻）之一' }
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
        ? '已结束'
        : `下次 ${row.next_fire_at}`
      : row.kind === 'watcher'
        ? `监视 ${String(spec['path'] ?? '(未指定)')}`
        : row.kind
  const state = row.enabled === 1 ? '' : '（已停用）'
  return `${row.title}${state} · ${row.kind} · ${when}`
}

/** 构造唤醒工具。 */
export function buildWakeTools(defineTool: DefineToolLike, runtime: MemoryRuntime, host: WakeToolHost): readonly unknown[] {
  const db = runtime.db
  const now = (): Date => new Date()

  const scheduleTool = defineTool({
    name: 'schedule_wake',
    description:
      '给自己安排一次未来的唤醒（到某个时间点做一件事）。' +
      '一次性用 delaySeconds（多少秒后）或 at（具体时刻）；重复用 everySeconds（每多少秒）。' +
      '最小 60 秒。**如果你要的是"某个条件成立时"而不是"某个时间点"，用 register_watcher** —— ' +
      '用定时轮询去模拟监视既费钱又慢。',
    parameters: {
      title: { type: 'string', required: true, description: '给这次唤醒起个短标题（列表里显示）。' },
      prompt: {
        type: 'string',
        required: true,
        description: '唤醒后你自己要做什么（写给未来的你看的）。空的话这次唤醒就是纯浪费，所以必填。',
      },
      delaySeconds: { type: 'number', description: '多少秒后触发一次（一次性）。最小 60。' },
      everySeconds: { type: 'number', description: '每多少秒触发一次（重复）。最小 60。' },
      at: { type: 'string', description: '具体时刻（ISO 8601）。必须是未来时间。' },
      scope: { type: 'string', description: '要唤醒哪个会话；不给表示与具体会话无关。' },
      dailyLimit: { type: 'number', description: '每天最多醒几次（0 或省略 = 不限）。防刷屏用。' },
      minIntervalMs: { type: 'number', description: '两次唤醒之间的最小间隔（毫秒），防抖。' },
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
      const message = `已安排「${created.row.title}」，下次 ${String(created.row.next_fire_at)}（id ${created.row.id}）`
      return { ok: true, id: created.row.id, message }
    },
  })

  const watcherTool = defineTool({
    name: 'register_watcher',
    description:
      '登记一个**条件监视**：某个条件成立时唤醒你（文件出现 / 文件内容变化 / 端口通了 / 命令输出匹配）。' +
      '它不是定时的 —— 它盯着，一有变化就叫你（秒级），比定时轮询既快又省。' +
      '要写一个监视脚本（放工作区里），登记后由监督器常驻运行、崩溃会自动重启。',
    parameters: {
      name: { type: 'string', required: true, description: '监视程序的名字（唯一）。' },
      path: { type: 'string', required: true, description: '脚本在工作区里的相对路径。' },
      contract: {
        type: 'string',
        required: true,
        description:
          '契约：probe（跑一次、看退出码）/ watcher（常驻、输出一行就算触发）/ service（常驻服务，挂了就重启）。',
      },
      title: { type: 'string', required: true, description: '给这个监视起个短标题。' },
      prompt: { type: 'string', required: true, description: '被唤醒后你自己要做什么。' },
      scope: { type: 'string', description: '要唤醒哪个会话；不给表示与具体会话无关。' },
      dailyLimit: { type: 'number', description: '每天最多醒几次（0 或省略 = 不限）。' },
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
        const reason = `contract 必须是 probe / watcher / service 之一，收到「${contract}」`
        return { ok: false, id: '', message: reason }
      }
      if (host.registerProgram === undefined) {
        // **未装配就明确拒绝** —— 静默成功的话模型会以为监视在跑，而实际没有
        const reason = '监视程序监督器未启用（需要 gateway 侧装配），本次登记未生效'
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
      const message = `已登记监视「${created.row.title}」（${contract}，id ${created.row.id}）`
      return { ok: true, id: created.row.id, message }
    },
  })

  const listTool = defineTool({
    name: 'list_wakes',
    description: '列出你自己安排的唤醒与监视（含下次触发时间与启用状态）。',
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
        if (v.rows.length === 0) return text('你还没有安排任何唤醒。')
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
              if (full === undefined) return `（${r.id} 已取不到，可能刚被取消）`
              // **带上 prompt** —— 模型要能看到自己当初写的任务
              // ★ **必须带上 id**（真机 bug）：cancel_wake / wake_now 都要求传 id，
              // 而它们的说明写的是"list_wakes 里有" —— 列表却不给 id 的话，
              // 模型看得见那条唤醒、却拿它毫无办法（只有"取不到"的分支才漏出 id）。
              return `${describeTrigger(full)}（id ${full.id}）\n  到点要做的事：${full.prompt}`
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
    description: '取消一条你自己安排的唤醒或监视。**取消后就真的不会再醒了** —— 如果那件事还需要做，先做完再取消。',
    parameters: {
      id: { type: 'string', required: true, description: '要取消的 id（list_wakes 里有）。' },
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
        const reason = `没有这条唤醒：${id}（用 list_wakes 看看有哪些）`
        return { ok: false, message: reason }
      }
      deleteWakeTrigger(db, id)
      const message = `已取消「${existing.title}」`
      return { ok: true, message }
    },
  })

  const nowTool = defineTool({
    name: 'wake_now',
    description:
      '**立刻**执行一条已安排的唤醒（不用等到点）。用在"我现在就想做那件事"的时候。' +
      '它不会改变原来的周期 —— 该到点还是会到点。',
    parameters: {
      id: { type: 'string', required: true, description: '要立刻执行的 id（list_wakes 里有）。' },
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
      const result = await host.fireNow(id, '模型主动立刻执行')
      const ok = result.decision === 'fired'
      const message = ok ? '已立刻执行' : `没能执行：${result.reason}`
      return { ok, message }
    },
  })

  return [scheduleTool, watcherTool, listTool, cancelTool, nowTool]
}
