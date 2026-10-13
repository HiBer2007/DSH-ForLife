/**
 * 采集端日志的**入口校验与归一**（`FIX_PLAN.md` §57 待办①）。
 *
 * ## 为什么需要它（§57 的活证据）
 *
 * `qq`（NapCat）与 gateway **不共享任何卷** ⇒ 它的 stdout（16,310 行，其中 2,526 行
 * 含 `error|warn|fail|断开|掉线|重连`）**在我们的日志库里一条都没有**。
 * 2026-10-11 真发生过：gateway 重建时 NapCat 反向 WS **连败 3 次**（每 3 秒重试），
 * 第 4 次接上 —— ★ 那 3 次失败**在网关日志、面板、库里一点都看不到**。
 *
 * ⇒ 设计（§57）：**宿主侧采集端**读 `docker logs`，归一成 `LogRecord`，POST 给 gateway。
 *   ★ 宿主侧读 ⇒ 不用给容器加权限、**不用重建 qq**（用户红线）。
 *   这个模块是那个入口的**判据层**：什么能收、什么必须拒、拒了要说什么。
 *
 * ## 三条纪律
 *
 * 1. ★ **只收认识的等级**（`LOG_LEVELS` 那七级）—— 采集端写错一个字就整条丢，
 *    并且**说清收到的是什么**（"拒了但不知道为什么"比丢日志更难查）；
 * 2. ★ **模块名要洗**：面板按 module 筛，而 module 是**外部输入** ⇒
 *    只留 `[a-z0-9._-]`、小写、≤ 64 字符（否则一个恶意/手滑的模块名会把筛选器搞乱）；
 * 3. ★ **正文走 `cleanLogText`**（§55 待办①的卫生：Markdown/换行/笔记在入口处清掉），
 *    并截断到 `MAX_INGEST_TEXT`（**带标记**，不静默丢尾巴）。
 *
 * @module @forlife/gateway/admin/log-ingest
 */
import { cleanLogText } from './log-hygiene.ts'
import { isLogLevel, type LogLevel } from './log-levels.ts'
import type { LogRecord } from './log.ts'

/** 一次请求最多几条（采集端自己分批；超了**整请求拒**，不悄悄截断）。 */
export const MAX_INGEST_RECORDS = 200

/** 单条正文上限（超出截断并加标记）。 */
export const MAX_INGEST_TEXT = 2000

/** 模块名上限。 */
export const MAX_MODULE_LENGTH = 64

/** 一条记录被拒的原因（给人看的一句话）。 */
export interface IngestRejection {
  /** 它在数组里的下标（采集端要能对上自己发的是哪一条）。 */
  readonly index: number
  readonly reason: string
}

/** 一批的结果。 */
export interface IngestOutcome {
  readonly accepted: number
  readonly rejected: readonly IngestRejection[]
}

/** 单条校验的结果。 */
export type ParsedRecord = { readonly ok: true; readonly record: LogRecord } | { readonly ok: false; readonly reason: string }

/**
 * 洗模块名。
 *
 * @param raw - 原始输入。
 * @returns 洗过的模块名；**洗不出东西**时返回 `undefined`（调用方据此拒绝）。
 */
export function sanitizeModule(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_MODULE_LENGTH)
  return cleaned === '' ? undefined : cleaned
}

/**
 * 校验并归一**一条**记录。
 *
 * @param raw - 采集端发来的对象。
 * @param index - 它在数组里的下标（拒绝时回填）。
 * @param now - 缺时间戳时的兜底时刻（测试可注入）。
 * @returns 归一结果。
 */
export function parseIngestRecord(raw: unknown, index: number, now: () => Date = () => new Date()): ParsedRecord {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reason: `第 ${String(index)} 条不是对象` }
  }
  const row = raw as Record<string, unknown>

  const level = row['level']
  if (!isLogLevel(level)) {
    return { ok: false, reason: `第 ${String(index)} 条的 level 不认识：${JSON.stringify(level)}（只认七级）` }
  }

  const module = sanitizeModule(row['module'])
  if (module === undefined) {
    return { ok: false, reason: `第 ${String(index)} 条的 module 洗不出可用名字：${JSON.stringify(row['module'])}` }
  }

  const rawText = row['text']
  if (typeof rawText !== 'string' || rawText.trim() === '') {
    return { ok: false, reason: `第 ${String(index)} 条的 text 为空` }
  }
  const cleaned = cleanLogText(rawText)
  const text =
    cleaned.length > MAX_INGEST_TEXT
      ? `${cleaned.slice(0, MAX_INGEST_TEXT)}…（已截断，原文 ${String(cleaned.length)} 字符）`
      : cleaned

  // ★ 时间戳：给不出合法值就**用收到的时刻**（而不是丢掉整条 —— 时间不准总比没有强，
  //   但**不能静默**：末尾标出来，排障时一眼看到"这条的时间是补的"）。
  const rawAt = row['at']
  let at: string
  if (typeof rawAt === 'string' && !Number.isNaN(Date.parse(rawAt))) {
    at = new Date(rawAt).toISOString()
  } else {
    at = now().toISOString()
    return { ok: true, record: { level, module, text: `${text}（采集端未给合法时间戳，已用接收时刻）`, at } }
  }

  return { ok: true, record: { level: level as LogLevel, module, text, at } }
}

/**
 * 校验并归一**一批**记录。
 *
 * ★ 单条坏了只丢那一条（`rejected` 里说清为什么），**不整批失败** ——
 *   否则 NapCat 里一行畸形日志就能让整批 199 条好日志一起丢。
 * ★ 但 `records.length > MAX_INGEST_RECORDS` 是**整请求拒**（那是采集端的分批 bug，
 *   该让它看见并改，而不是我们悄悄截断）。
 *
 * @param raw - 请求体里的 `records`。
 * @param now - 兜底时刻。
 * @returns 归一后的记录与拒绝清单；`fatal` 非空表示整请求该被拒。
 */
export function parseIngestBatch(
  raw: unknown,
  now: () => Date = () => new Date(),
): { readonly records: readonly LogRecord[]; readonly outcome: IngestOutcome; readonly fatal?: string } {
  if (!Array.isArray(raw)) {
    return { records: [], outcome: { accepted: 0, rejected: [] }, fatal: 'records 必须是数组' }
  }
  if (raw.length === 0) {
    return { records: [], outcome: { accepted: 0, rejected: [] }, fatal: 'records 是空的（采集端应当跳过空批，而不是发上来）' }
  }
  if (raw.length > MAX_INGEST_RECORDS) {
    return {
      records: [],
      outcome: { accepted: 0, rejected: [] },
      fatal: `一批最多 ${String(MAX_INGEST_RECORDS)} 条，收到 ${String(raw.length)} 条（采集端要自己分批）`,
    }
  }

  const records: LogRecord[] = []
  const rejected: IngestRejection[] = []
  for (const [index, item] of raw.entries()) {
    const parsed = parseIngestRecord(item, index, now)
    if (parsed.ok) records.push(parsed.record)
    else rejected.push({ index, reason: parsed.reason })
  }
  return { records, outcome: { accepted: records.length, rejected } }
}
