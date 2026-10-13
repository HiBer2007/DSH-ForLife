/**
 * 「投喂前更新」—— **源刷新**（refresh-before-feed）。
 *
 * ## 为什么这是一个机制，而不是一句约定（用户 2026-10-09 的原话）
 *
 * > 以后务必在任何试图投喂前更新即可，不必限制立刻更新。
 *
 * 拆成两条：
 *  1. **不必"立刻"** —— 投喂进行中不需要持续轮询源；
 *  2. **必须"在投喂之前"** —— 刷新是投喂的**前置步骤**，不是一个"要用户记得去做"的任务。
 *
 * ★ 为什么这条是**防止丢数据**，不是洁癖：当晚用户让"清空重喂"，
 * 手上那份导出是**当天早些时候**的 281 段；投喂前拉了一次才发现源里**多了 6 条**
 * （就在大家干活这段时间聊的）。**清空重喂是破坏性操作** —— 不查就**永久丢**那 6 条。
 *
 * ## 形态：源适配器（`FeedRefreshSpec`）—— 为什么是这个粒度
 *
 * 喂食子系统的输入是文本/文件/流，**它不知道源在哪**（可能是 DeepSeek 导出、可能是别的）。
 * 所以"怎么刷新"必须由**声明**给出，而声明只有三种，刻意不多：
 *
 * | 声明 | 含义 | 谁来用 |
 * | :--- | :--- | :--- |
 * | `{kind:'none', reason}` | **无源**：输入本身就是内容（调用方刚给的文本） | 工具/两个 HTTP 入口、手打 `--text` |
 * | `{kind:'default'}` | 用**部署配置**的刷新命令（基线 + 环境变量） | CLI 的 `--refresh`（不写死命令） |
 * | `{kind:'command', command, args?}` | 跑一条命令把源拉新，成功之后才喂 | 明确知道源是什么的场合 |
 *
 * **为什么不做成"通用插件/脚本目录"**：刷新命令的**唯一难点是凭据**——
 * 而凭据必须留在 `.runtime/`（见 `docs/notes/deepseek-chat-export.md` 的纪律）。
 * 一个"源插件目录"不会让这件事更容易，只会多一层要维护的注册表。
 * 一条命令 + 一个环境变量就够了，而且**路径与凭据都不进仓库**。
 *
 * ## ★ 谁来保证"没人能绕过刷新"
 *
 * **不是文档，是 `feedInput()` 里的那道闸**（`resolveFeedRefresh`）：
 *
 *  - **内容型输入**（`text` / `items`）⇒ 自动声明"无源"（它**就是**当下给的内容，
 *    没有"陈旧"这个概念），理由会记进会话；
 *  - **文件 / 流**（`paths` / `stream`）⇒ **必须显式声明**：不声明直接**打回**。
 *    这是刻意的：文件是"某个源的快照"，而"忘了刷新"与"没有源"在代码里长得一模一样 ——
 *    只有让调用方**说出一句话**（命令 / reason），两者才分得开。
 *
 * ## ★ 两条"省事但会丢数据"的路，都堵掉了
 *
 *  1. **空结果**：DeepSeek 那个接口失败的方式是**安静地返回空数组 + HTTP 200**
 *     （文件 410 字节、不是 401 也不是 404）。而它的 `cache_version` 是**增量游标** ——
 *     传会话当前 version 会拿回 **0 条**。所以**判成功的标准是条数，不是 HTTP 200**。
 *     ⇒ 这里把"条数为 0"当**失败**处理，并在错误里点名那个坑（`cache_version=0`）。
 *  2. **刷新挂了**（网络断 / 凭据过期 / 超时）⇒ 默认**不喂**（`feed.refresh.required`）。
 *     想用本地那份陈旧的，必须**显式** `allowStale: true` —— 那时会在结果里如实标出来，
 *     并记进会话与台账（"这次投喂基于陈旧源"是事后最需要知道的一句话）。
 *
 * ## 台账（"旧 N → 新 M，+K"）
 *
 * 刷新命令按契约在输出里报一行条数（默认标记 `items=`，见基线 `feed.refresh.itemsMarker`；
 * 也可以带上 `version=` 报源自己的版本号）。这里把**上一次的条数**记在既有的 `forlife_state`
 * 上（键 = 刷新命令的短哈希，**不加表**），于是每次刷新都能给出：
 *
 * ```
 * 源已刷新：旧 281 条 → 新 287 条（+6）；命令 ...；耗时 3.2s
 * ```
 *
 * 命令没报条数时**如实说"没报"**，不编一个数字（编数字比不报更坏：它会长成"事实"）。
 *
 * @module @forlife/gateway/feed-refresh
 */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'

import type { DatabaseSync } from 'node:sqlite'

import { defaultFor } from '@forlife/contracts'

/** 一次源刷新的声明（见模块头的表）。 */
export type FeedRefreshSpec =
  /** **无源**：输入本身就是内容（调用方直接给的文本）。`reason` 会记进会话（审计用）。 */
  | { readonly kind: 'none'; readonly reason: string }
  /** 用**部署配置**的刷新命令（基线 `feed.refresh.command`，环境变量优先）。 */
  | {
      readonly kind: 'default'
      /** 把命令的 stdout 当作要喂的内容（与 `command` 变体同一个意思）。 */
      readonly useOutputAsText?: boolean
      /** **显式接受陈旧/可疑的源**（与 `command` 变体同一个意思）。 */
      readonly allowStale?: boolean
    }
  /** 跑一条命令把源拉新。 */
  | {
      readonly kind: 'command'
      readonly command: string
      /** 参数逐项给（不拼 shell 字符串 —— 引号/空格/注入都在这里被回避掉）。 */
      readonly args?: readonly string[]
      /** 超时（默认读基线 `feed.refresh.timeoutMs`）。 */
      readonly timeoutMs?: number
      /** 把命令的 **stdout 当作要喂的内容**（"刷新出来直接喂"，不留中间文件）。 */
      readonly useOutputAsText?: boolean
      /**
       * **显式接受陈旧/可疑的源**：刷新失败照样喂、报 0 条也照样喂。
       * 默认 `false` —— 因为"用陈旧数据重喂"是**破坏性**的（尤其清空重喂）。
       */
      readonly allowStale?: boolean
    }

/** 刷新的结果（`ok` 的含义是"**可以继续喂**"）。 */
export interface FeedRefreshOutcome {
  readonly ok: boolean
  /** 这次投喂基于什么源（审计口径）。 */
  readonly kind: 'none' | 'command'
  readonly reason: string
  /** 给调用者/模型看的人话（CLI/工具/HTTP 都显示它）。 */
  readonly note: string
  readonly command?: string
  readonly exitCode?: number
  readonly ms?: number
  /** 命令输出（截断后；排障用）。 */
  readonly output?: string
  /** 脚本报的条数（没报就是 `undefined` —— **不编数字**）。 */
  readonly items?: number
  /** 上一次刷新记录的条数（台账）。 */
  readonly previousItems?: number
  /** `items - previousItems`（两边都有才有）。 */
  readonly delta?: number
  /** 脚本报的源自己的版本号（`version=`）。 */
  readonly version?: string
  /** **是在接受陈旧/可疑源的前提下继续的**（`allowStale` 生效过）。 */
  readonly stale?: boolean
  /** `useOutputAsText` 时：命令的 stdout（要喂的内容）。 */
  readonly text?: string
  readonly at: string
}

/** 刷新失败/不可用时的统一形态。 */
function failed(reason: string, at: string, extra: Partial<FeedRefreshOutcome> = {}): FeedRefreshOutcome {
  return { ok: false, kind: 'command', reason, note: reason, at, ...extra }
}

/** 命令行的哪一段算"源的标签"（台账里给人看的可读部分；**不存整条命令**）。 */
function commandLabel(command: string): string {
  const parts = command.split(/[\\/]/)
  return parts[parts.length - 1] ?? command
}

/** 源的台账键：由**刷新命令**派生（"怎么拉它"就是源的身份；同名文件也可能换源）。 */
export function feedSourceLedgerKey(spec: { readonly command: string; readonly args?: readonly string[] }): string {
  const line = [spec.command, ...(spec.args ?? [])].join(' ')
  return `feed_source:${createHash('sha1').update(line).digest('hex').slice(0, 10)}`
}

/** 台账一行（上一次刷新拉到多少条）。 */
export interface FeedSourceState {
  readonly at: string
  readonly items?: number
  readonly version?: string
  readonly label?: string
}

/**
 * 读台账（缺键 / 坏 JSON / 字段不全都返回 `undefined`）。
 *
 * 为什么不抛：它会在**投喂前的热路径**上被调用，为了一个"上次多少条"的读数
 * 把整次投喂弄崩不值当（宁可这次报不出 delta）。
 */
export function readFeedSourceState(db: DatabaseSync, key: string): FeedSourceState | undefined {
  try {
    const row = db.prepare('SELECT value FROM forlife_state WHERE key = ?').get(key) as { value?: string } | undefined
    if (row?.value === undefined || row.value.trim() === '') return undefined
    const parsed: unknown = JSON.parse(row.value)
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const record = parsed as Record<string, unknown>
    const at = typeof record['at'] === 'string' ? record['at'] : ''
    if (at === '') return undefined
    return {
      at,
      ...(typeof record['items'] === 'number' && Number.isFinite(record['items']) ? { items: record['items'] } : {}),
      ...(typeof record['version'] === 'string' ? { version: record['version'] } : {}),
      ...(typeof record['label'] === 'string' ? { label: record['label'] } : {}),
    }
  } catch {
    return undefined
  }
}

/** 写台账（落**既有**的 `forlife_state`，不加表）。 */
export function writeFeedSourceState(db: DatabaseSync, key: string, state: FeedSourceState): void {
  db.prepare(
    `INSERT INTO forlife_state (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, JSON.stringify(state))
}

/**
 * 从刷新输出里解析条数与版本（**契约**，见模块头与 `docs/notes/deepseek-chat-export.md`）。
 *
 * 只认两种标记，刻意不猜：
 *  - 条数：`<feed.refresh.itemsMarker><整数>`（默认 `items=281`）；
 *  - 版本：`version=<非空白>`（DeepSeek 那边就是 `chat_session.version`）。
 *
 * @param output - 命令的 stdout+stderr。
 * @param marker - 条数标记（默认读基线）。
 * @returns 解析到的字段（都没有 ⇒ 空对象）。
 */
export function parseRefreshMarkers(output: string, marker?: string): { items?: number; version?: string } {
  const itemsMarker = marker ?? defaultFor<string>('feed.refresh.itemsMarker')
  const out: { items?: number; version?: string } = {}
  if (itemsMarker !== '') {
    const escaped = itemsMarker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    // 标记里的**等号两侧允许空白**（脚本爱写 `items = 281`、`条数：281` 都行）：
    // 这是"契约"不是"格式校验"，宽一点不会误判，而窄一点会让人白折腾半天
    const pattern = escaped.endsWith('=')
      ? `${escaped.slice(0, -1)}\\s*=\\s*(\\d+)`
      : `${escaped}\\s*[:：]?\\s*(\\d+)`
    const match = new RegExp(pattern).exec(output)
    if (match?.[1] !== undefined) out.items = Number(match[1])
  }
  const version = /version\s*[=:]\s*([^\s,;]+)/.exec(output)
  if (version?.[1] !== undefined) out.version = version[1]
  return out
}

/** 把 `pwsh -NoProfile -File x.ps1` 这样一行拆成命令 + 参数（支持单/双引号包住带空格的一段）。 */
export function splitCommandLine(line: string): { readonly command: string; readonly args: readonly string[] } {
  const parts: string[] = []
  let current = ''
  let quote: string | undefined
  for (const ch of line.trim()) {
    if (quote !== undefined) {
      if (ch === quote) quote = undefined
      else current += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (/\s/.test(ch)) {
      if (current !== '') parts.push(current)
      current = ''
      continue
    }
    current += ch
  }
  if (current !== '') parts.push(current)
  return { command: parts[0] ?? '', args: parts.slice(1) }
}

/** 跑的时长上限：给"输出里报了什么"留够余量，但不许把子进程挂死。 */
const MAX_BUFFER_BYTES = 4 * 1024 * 1024

/** 报告里保留的输出长度（排障够用；不要把整份导出塞进会话记录）。 */
const OUTPUT_EXCERPT_CHARS = 400

/** 跑一条命令（不经过 shell：参数逐项传，引号与注入问题在 `splitCommandLine` 那一层解决）。 */
function runCommand(
  command: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string; readonly error?: string; readonly timedOut?: boolean }> {
  return new Promise((resolve) => {
    execFile(
      command,
      [...args],
      { timeout: timeoutMs, maxBuffer: MAX_BUFFER_BYTES, windowsHide: true, encoding: 'utf8' },
      (error, stdout, stderr) => {
        const text = { stdout: stdout ?? '', stderr: stderr ?? '' }
        if (error === null) {
          resolve({ code: 0, ...text })
          return
        }
        const err = error as NodeJS.ErrnoException & { code?: number | string; killed?: boolean; signal?: string }
        const timedOut = err.killed === true || err.signal === 'SIGTERM'
        resolve({
          code: typeof err.code === 'number' ? err.code : 1,
          ...text,
          error: err.message,
          ...(timedOut ? { timedOut: true } : {}),
        })
      },
    )
  })
}

/** 取部署配置的刷新命令（环境变量优先，其次基线；都空 = 没配）。 */
export function configuredRefreshCommand(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env['FORLIFE_FEED_REFRESH_COMMAND']?.trim()
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv
  return defaultFor<string>('feed.refresh.command').trim()
}

/** 解析声明 → 可执行的刷新计划（**这是"没人能绕过刷新"的那道闸**）。 */
export function resolveFeedRefresh(
  spec: FeedRefreshSpec | undefined,
  input: { readonly hasContent: boolean; readonly hasFiles: boolean; readonly hasStream: boolean },
  env: NodeJS.ProcessEnv = process.env,
): { readonly ok: true; readonly spec: FeedRefreshSpec } | { readonly ok: false; readonly error: string } {
  if (spec !== undefined) {
    if (spec.kind === 'command') {
      if (spec.command.trim() === '') return { ok: false, error: '刷新声明不合法：command 是空的' }
      return { ok: true, spec }
    }
    if (spec.kind === 'default') {
      if (configuredRefreshCommand(env) === '') {
        return {
          ok: false,
          error:
            '刷新声明是 default，但部署没配刷新命令：设环境变量 FORLIFE_FEED_REFRESH_COMMAND，' +
            '或在 packages/contracts/plan-baseline.json 的 feed.refresh.command 里给一个（凭据不要写进仓库）',
        }
      }
      return { ok: true, spec }
    }
    if (spec.reason.trim() === '') {
      return { ok: false, error: '刷新声明不合法：kind=none 时必须给 reason（它要进会话记录，供事后追溯）' }
    }
    return { ok: true, spec }
  }

  // 没声明：内容型输入自动算"无源"（它**就是**当下给的内容，没有"陈旧"这回事）
  if (input.hasContent) {
    return { ok: true, spec: { kind: 'none', reason: '调用方直接给的内容（text/items），不来自外部源' } }
  }

  // 文件 / 流：**必须显式声明** —— "忘了刷新"与"没有源"在代码里长得一模一样，
  // 只有让调用方说出一句话，两者才分得开（见模块头）。
  const what = input.hasFiles ? '文件/目录' : '流'
  return {
    ok: false,
    error:
      `${what}是某个源的**快照**：投喂前必须先刷新它（refresh: {kind:'command'|'default'}）。` +
      '确认它没有外部源（例如刚手写的资料），就显式声明 refresh: {kind:\'none\', reason:\'…\'}。' +
      '为什么必须：用陈旧数据重喂是**破坏性**的（清空重喂会把源里新增的那些永久丢掉）。',
  }
}

/**
 * 执行刷新（`ok:false` ⇒ **调用方不许写任何记忆**）。
 *
 * @param db - 数据库连接（台账落在既有的 `forlife_state` 上）。
 * @param spec - 已解析过的声明（见 {@link resolveFeedRefresh}）。
 * @param options - `now` 便于测试注入时间；`env` 便于测试注入环境变量。
 * @returns 刷新结果（`ok` = 可以继续喂；`stale` = 是在接受陈旧源的前提下继续）。
 */
export async function runFeedRefresh(
  db: DatabaseSync,
  spec: FeedRefreshSpec,
  options: { readonly now?: Date; readonly env?: NodeJS.ProcessEnv } = {},
): Promise<FeedRefreshOutcome> {
  const at = (options.now ?? new Date()).toISOString()
  if (spec.kind === 'none') {
    return { ok: true, kind: 'none', reason: spec.reason, note: `无外部源：${spec.reason}`, at }
  }

  const allowStale = spec.kind === 'command' ? spec.allowStale === true : spec.kind === 'default' ? spec.allowStale === true : false
  const required = defaultFor<boolean>('feed.refresh.required')
  const resolved =
    spec.kind === 'default'
      ? {
          command: configuredRefreshCommand(options.env),
          args: [] as readonly string[],
          timeoutMs: undefined as number | undefined,
          useOutputAsText: spec.useOutputAsText === true,
        }
      : spec
  const timeoutMs = resolved.timeoutMs ?? defaultFor<number>('feed.refresh.timeoutMs')
  const command = resolved.command

  const started = Date.now()
  const result = await runCommand(command, resolved.args ?? [], timeoutMs)
  const ms = Date.now() - started
  const output = `${result.stdout}\n${result.stderr}`.trim()
  const excerpt = output.length > OUTPUT_EXCERPT_CHARS ? `${output.slice(0, OUTPUT_EXCERPT_CHARS)}…` : output
  const parsed = parseRefreshMarkers(output)
  const ledgerKey = feedSourceLedgerKey({ command, ...(resolved.args === undefined ? {} : { args: resolved.args }) })
  const previous = readFeedSourceState(db, ledgerKey)
  const common = {
    command,
    exitCode: result.code,
    ms,
    ...(excerpt === '' ? {} : { output: excerpt }),
    ...(parsed.items === undefined ? {} : { items: parsed.items }),
    ...(parsed.version === undefined ? {} : { version: parsed.version }),
    ...(previous?.items === undefined ? {} : { previousItems: previous.items }),
    ...(parsed.items === undefined || previous?.items === undefined ? {} : { delta: parsed.items - previous.items }),
    at,
  }

  /** 台账只在"真的拉到了东西"时更新（失败不写 —— 否则下次的"旧 N"会变成撒谎的基准）。 */
  const record = (): void => {
    writeFeedSourceState(db, ledgerKey, {
      at,
      ...(parsed.items === undefined ? {} : { items: parsed.items }),
      ...(parsed.version === undefined ? {} : { version: parsed.version }),
      label: commandLabel(command),
    })
  }
  const deltaNote = (): string => {
    if (parsed.items === undefined) return '脚本没报条数（约定见文档：输出一行 ' + defaultFor<string>('feed.refresh.itemsMarker') + '<n>）'
    if (previous?.items === undefined) return `拉到 ${String(parsed.items)} 条`
    const delta = parsed.items - previous.items
    const sign = delta > 0 ? `+${String(delta)}` : String(delta)
    return `旧 ${String(previous.items)} 条 → 新 ${String(parsed.items)} 条（${sign}）`
  }

  // ① 命令本身失败（非零退出 / 超时 / 起不来）
  if (result.code !== 0) {
    const why = result.timedOut === true ? `刷新命令超时（${String(timeoutMs)} ms）` : `刷新命令失败（退出码 ${String(result.code)}）`
    const reason = `${why}：${command}${excerpt === '' ? '' : `｜输出：${excerpt}`}`
    if (allowStale || !required) {
      return {
        ...failed(reason, at, common),
        ok: true,
        stale: true,
        reason,
        note: `${reason} ⇒ **按「接受陈旧源」继续**（allowStale 或 feed.refresh.required=false）：这次投喂基于**可能过期**的本地内容`,
      }
    }
    return failed(`${reason} ⇒ 没有写入任何记忆（用陈旧数据重喂是破坏性的，尤其清空重喂）`, at, common)
  }

  // ② 命令成功但**条数为 0**：DeepSeek 那个接口失败的样子就是"安静地空 200"
  //    （`cache_version` 传成会话当前 version 就会这样）⇒ 这是**失败**，不是"源是空的"。
  if (parsed.items === 0) {
    const reason =
      '刷新命令报告 **0 条** —— 这几乎不是「源是空的」，而是那个坑：' +
      'DeepSeek 的 `cache_version` 是**增量游标**，传会话当前 version 会拿回 0 条' +
      '（安静的空 200、文件 410 字节，最难查）⇒ 要全量就传 `cache_version=0`'
    const failure = `${reason}；**判刷新成功的标准是条数，不是 HTTP 200**`
    if (allowStale || !required) {
      return { ...failed(failure, at, common), ok: true, stale: true, note: `${failure} ⇒ 按「接受可疑源」继续（这次投喂可能什么都没拉到）` }
    }
    return failed(`${failure} ⇒ 没有写入任何记忆`, at, common)
  }

  // ③ 成功
  record()
  const text = resolved.useOutputAsText === true ? result.stdout : undefined
  const note = `源已刷新：${deltaNote()}；命令 ${commandLabel(command)}（${String(ms)} ms）`
  return {
    ok: true,
    kind: 'command',
    reason: '源已刷新',
    note,
    ...common,
    ...(text === undefined ? {} : { text }),
    ...(result.timedOut === true ? { stale: true } : {}),
  }
}
