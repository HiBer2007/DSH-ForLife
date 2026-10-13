/**
 * 长期记忆的 **HDD 沉降**（PLAN §6.3 的"扫描"那一半）。
 *
 * ## 验收标准在说什么
 *
 * PLAN 原文：「**触发**：中期→长期沉降时，**或定时任务扫描
 * `last_accessed_at > 90天` 的长期条目**。**操作**：全文与向量迁移到 HDD 归档目录，
 * 表内 `content` 置空、`storage_tier='hdd'`。」
 *
 * 交付物里早就有 `listSettleCandidates`（扫）与 `markLongSettled`（改库），
 * 但**没有任何东西调用它们** —— 也就是说"定时任务扫描"这一半从来没发生过。
 * 这个模块就是那一半：**扫 → 写归档 → 校验 → 置空**。
 * 定时器不在这里（见文件末尾"分工"）。
 *
 * ## 三条安全纪律（顺序错了就是**静默的数据丢失**）
 *
 * 1. **先写归档、读回校验、最后才置空** —— 反过来（先置空再写）的话，
 *    写失败时正文两头都没有，而**条目还在、检索还命中**：
 *    用户看到的是"这条记忆是空的"，而不是"沉降失败了"。
 * 2. **校验不过 ⇒ 删掉半成品文件、保留库内正文、报失败** ——
 *    与 `settle.ts`（blob 沉降）同一条纪律：**半个文件比没有文件更危险**，
 *    它看起来是好的。
 * 3. **正文本来就不在库里的条目不动** —— 把 NULL 置成 NULL 不是沉降，
 *    是把一个空壳标成"已归档"（将来 `loadLongEntry` 取不回来，而没人知道为什么）。
 *
 * ## 归档文件：**一条一个文件**，不是批量 NDJSON
 *
 * 路径：`<cold 根>/longterm/<安全 id>-<sha1(id) 前 8 位>.txt`。
 *
 * 为什么不复用 `archive.ts` 的批量导出（NDJSON + manifest）：
 * `loadLongEntry` 的契约（见 `cold-load.ts` 模块头）是
 * **`archive_path` 指向的那个文件"就是这条的正文"**。
 * 若把批量 NDJSON 的路径写进去，回读会把**整个归档文件**当成这一条的正文 ——
 * 那比"读不出来"更糟：它是**静默返回错误内容**。
 * 批量导出（交付物 3）是"多一份给人看/给将来转 Parquet"的东西，两件事互不影响。
 *
 * ## `hdd` 是**逻辑冷层**，物理位置由 `FORLIFE_ROOT_COLD` 决定
 *
 * 单盘部署（没配 cold ⇒ 退回 warm/hot）时，归档会落在**同一块盘**上。
 * 库里只有 `ssd` / `hdd` 两个值，表达不了"落在哪块盘" —— 所以
 * **调用方要在日志里说清"退回了"**，而不是假装有 HDD（见 `settle-loop.ts` 的日志）。
 *
 * ## 分工
 *
 * | 谁 | 做什么 |
 * |---|---|
 * | 本模块 | **一次**扫描 + 搬运（纯函数式的输入输出，可注入文件端口便于测试）|
 * | `packages/gateway/src/settle-loop.ts` | **定时**那一半（每 30 分钟一轮，与 blob 沉降/碎片维护同一个循环）|
 *
 * 放 gateway 而不是插件侧的理由见 `settle-loop.ts` 里的注释（那里有完整论证）。
 *
 * @module @forlife/store/long-settle
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'

import { defaultFor } from '@forlife/contracts'

import { listSettleCandidates, markLongSettled } from './repository.ts'

/** 沉降策略（**默认值只能从 plan-baseline 派生**，见 EXECUTION_PLAN §2.6）。 */
export interface LongSettlePolicy {
  /** 多少天没访问就沉（PLAN §6.3：90 天）。 */
  readonly afterDays: number
  /** 一次最多搬几条（EXECUTION_PLAN §2.4：200）。 */
  readonly batchSize: number
}

/** 默认策略：`tiering.settleAfterDays` / `tiering.settleBatchSize`。 */
export const DEFAULT_LONG_SETTLE_POLICY: LongSettlePolicy = {
  afterDays: defaultFor<number>('tiering.settleAfterDays'),
  batchSize: defaultFor<number>('tiering.settleBatchSize'),
}

/** 从环境变量读策略（不配则用基线值）。 */
export function longSettlePolicyFromEnv(env: Record<string, string | undefined>): LongSettlePolicy {
  const num = (key: string, fallback: number): number => {
    const raw = Number(env[key] ?? '')
    // **非法值一律回落**：0 或负数会让"多少天没访问"的比较全部反过来
    return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback
  }
  return {
    afterDays: num('FORLIFE_LONG_SETTLE_AFTER_DAYS', DEFAULT_LONG_SETTLE_POLICY.afterDays),
    batchSize: num('FORLIFE_LONG_SETTLE_BATCH', DEFAULT_LONG_SETTLE_POLICY.batchSize),
  }
}

/**
 * 归档文件的读写端口（注入：真实实现碰磁盘，测试要能在**不碰磁盘**的前提下
 * 验证"写失败不动库""校验不过保留正文"这些判断）。
 */
export interface ColdArchivePort {
  write(path: string, text: string): Promise<void>
  read(path: string): Promise<string>
  remove(path: string): Promise<void>
}

/** 默认端口：真实文件系统。 */
export const defaultColdArchivePort: ColdArchivePort = {
  write: async (path, text): Promise<void> => {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, text, 'utf8')
  },
  read: (path): Promise<string> => readFile(path, 'utf8'),
  remove: async (path): Promise<void> => {
    await rm(path, { force: true })
  },
}

/** 一条的处理结果。 */
export interface LongSettleOutcome {
  readonly id: string
  readonly action: 'settled' | 'skipped' | 'failed'
  readonly reason: string
  /** 只有 `settled` 才有：正文现在在这个文件里。 */
  readonly archivePath?: string
  readonly bytes?: number
}

/** 沉降选项。 */
export interface LongSettleOptions {
  readonly db: DatabaseSync
  /** **冷层根**（`resolveTierRoots(env).roots.cold` 的值）；归档落在它下面的 `longterm/`。 */
  readonly coldRoot: string
  readonly policy?: LongSettlePolicy
  readonly port?: ColdArchivePort
  readonly now?: () => Date
  readonly log?: (message: string) => void
}

/**
 * 归档路径：`<cold 根>/longterm/<安全 id>-<sha1(id) 前 8 位>.txt`。
 *
 * **id 不能直接拼进路径** —— 一个含 `..` 或分隔符的 id 能把文件写到冷层根之外。
 * 安全化之后仍可能撞名（不同 id → 同一个安全 id），所以再拼一段 id 的 sha1。
 */
export function longArchivePath(coldRoot: string, id: string): string {
  const root = coldRoot.replace(/[\\/]+$/, '')
  const sep = root.includes('\\') ? '\\' : '/'
  // 点也一并换掉：`..` 这种"只由点组成的段"是路径逃逸的经典写法
  const safe = id.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80)
  const digest = createHash('sha1').update(id).digest('hex').slice(0, 8)
  return `${root}${sep}longterm${sep}${safe}-${digest}.txt`
}

/** 正文的 sha256（校验用；与 `settle.ts` 的"校验通过才删源"同一条纪律）。 */
function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * 跑一轮长期记忆的 HDD 沉降。
 *
 * **返回每条的结果**（而不是一个汇总数字）—— "沉了 3 条、失败 2 条"里
 * 最有价值的是**那 2 条为什么失败**（失败意味着那条记忆还在 SSD 上，
 * 而且下一轮还会被扫到：这是可重试的，不是数据丢失）。
 */
export async function settleLongEntries(options: LongSettleOptions): Promise<readonly LongSettleOutcome[]> {
  const policy = options.policy ?? DEFAULT_LONG_SETTLE_POLICY
  const port = options.port ?? defaultColdArchivePort
  const now = options.now ?? ((): Date => new Date())
  const log = options.log ?? ((): void => {})
  const outcomes: LongSettleOutcome[] = []

  // `listSettleCandidates` 的语义：`storage_tier='ssd'` 且
  // `coalesce(last_accessed_at, created_at) < cutoff`（没访问过就看创建时间）。
  const candidates = listSettleCandidates(options.db, policy.afterDays, policy.batchSize, now())

  for (const row of candidates) {
    // ① 已经有归档文件 ⇒ 不动（重复沉降会把归档路径覆盖掉，而旧文件变成孤儿）
    if (row.archive_path !== null && row.archive_path !== '') {
      outcomes.push({ id: row.id, action: 'skipped', reason: `已经有归档文件（${row.archive_path}），不重复沉降` })
      continue
    }

    // ② 正文不在库里 ⇒ **绝不动它**（纪律 3）
    if (row.content === null || row.content === '') {
      outcomes.push({
        id: row.id,
        action: 'skipped',
        reason: '正文已不在库内（content 为空）—— 置空它等于把条目变成一个取不回来的空壳，不是沉降',
      })
      continue
    }

    const content = row.content
    const archivePath = longArchivePath(options.coldRoot, row.id)
    const expected = sha256(content)

    // ③ 先写归档。**写失败 ⇒ 不动库**（正文还在原处，下一轮还能重试）
    try {
      await port.write(archivePath, content)
    } catch (error) {
      outcomes.push({ id: row.id, action: 'failed', reason: `写归档失败（库内正文未动）：${String(error).slice(0, 140)}` })
      log(`长期沉降失败（${row.id}）：写归档失败 —— 正文仍在库内`)
      continue
    }

    // ④ **读回校验** —— 校验不过就不能置空，否则正文两头都没有
    let readBack: string
    try {
      readBack = await port.read(archivePath)
    } catch (error) {
      await bestEffortRemove(port, archivePath)
      outcomes.push({
        id: row.id,
        action: 'failed',
        reason: `归档读回失败（已删掉半成品文件、库内正文未动）：${String(error).slice(0, 140)}`,
      })
      log(`长期沉降失败（${row.id}）：归档读不回来 —— 正文仍在库内`)
      continue
    }

    if (sha256(readBack) !== expected) {
      await bestEffortRemove(port, archivePath)
      outcomes.push({
        id: row.id,
        action: 'failed',
        reason: `归档校验不符（期望 ${expected.slice(0, 12)}…，实得 ${sha256(readBack).slice(0, 12)}…），已删掉半成品文件、库内正文未动`,
      })
      log(`长期沉降失败（${row.id}）：归档校验不符 —— 正文仍在库内`)
      continue
    }

    // ⑤ 校验通过才置空（`markLongSettled`：content=NULL + storage_tier='hdd' + archive_path）
    markLongSettled(options.db, row.id, archivePath)
    const bytes = Buffer.byteLength(content, 'utf8')
    outcomes.push({
      id: row.id,
      action: 'settled',
      reason: `${String(policy.afterDays)} 天没访问（或创建），正文已移入归档并校验通过`,
      archivePath,
      bytes,
    })
    log(`已沉降长期条目 ${row.id}：正文 ${String(bytes)} 字节 → ${archivePath}`)
  }

  return outcomes
}

/** 删掉半成品文件（删不掉也不该让整轮崩：库内正文还在，数据没丢）。 */
async function bestEffortRemove(port: ColdArchivePort, path: string): Promise<void> {
  try {
    await port.remove(path)
  } catch {
    // 忽略：半成品文件留着只是多占空间，而库内正文没有被置空
  }
}
