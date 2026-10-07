/**
 * blob 沉降任务（PLAN 阶段 9 交付物 1 的后半）。
 *
 * ## 它做什么
 *
 * 扫描 `media_assets` 里"该往冷层搬"的 blob，按 `decideSettle` 的策略
 * 把它们从当前层搬到目标层，并更新 `storage_tier` / `settled_at`。
 *
 * ## 三条安全约束（都是"宁可不动，也不能丢"）
 *
 * 1. **先校验再删源** —— 不是 `rename`，而是
 *    `copy → 校验 sha256 → 删源`。
 *    `rename` 跨文件系统会失败，而"失败了但源已经被删"是最坏的结果。
 *    **校验不过就保留源、报失败**。
 * 2. **只往冷处搬** —— `decideSettle` 已经保证（它只认更冷的层）。
 *    这条在任务里再断言一次：**搬热是"提升"，属于另一个操作**（交付物 3 的 `recover`），
 *    混在一起的话，一个策略 bug 就能把冷数据全拉回 SSD 撑爆。
 * 3. **一条失败不拖垮整批** —— 单个文件坏了不该让其余 999 条也停在那儿。
 *    但失败要**逐条记账**（返回结果里有），而不是静默跳过。
 *
 * ## 为什么 `moveFile` 是注入的
 *
 * 真实实现要碰磁盘；测试要能在**不碰磁盘**的前提下验证
 * "校验失败会保留源""只往冷处搬""一条失败不拖垮整批"这些**判断**。
 * 把磁盘操作注入进来，判断逻辑就成了纯函数。
 *
 * @module @forlife/store/settle
 */
import type { DatabaseSync } from 'node:sqlite'

import { decideSettle, type SettlePolicy, type StorageTier, type TierRoots } from './storage-tiers.ts'

/** 一条 blob 的沉降候选（从库里读出来的事实）。 */
export interface BlobCandidate {
  readonly id: string
  readonly sha256: string
  readonly storagePath: string
  readonly tier: StorageTier
  readonly sizeBytes: number
  readonly createdAt: string
}

/** 一次搬迁的结果。 */
export interface MoveOutcome {
  readonly ok: boolean
  readonly reason: string
  /** 校验用的 sha256（**搬完必须等于源**）。 */
  readonly verifiedSha256?: string
}

/** 搬迁实现（注入：真实实现碰磁盘，测试用替身）。 */
export type MoveFile = (input: {
  readonly from: string
  readonly to: string
  readonly expectedSha256: string
}) => Promise<MoveOutcome>

/** 一条处理结果。 */
export interface SettleOutcome {
  readonly id: string
  readonly action: 'moved' | 'skipped' | 'failed'
  readonly from: StorageTier
  readonly to: StorageTier
  readonly reason: string
  readonly toPath?: string
}

/** 沉降选项。 */
export interface SettleOptions {
  readonly db: DatabaseSync
  readonly roots: TierRoots
  readonly policy: SettlePolicy
  readonly moveFile: MoveFile
  readonly now?: () => Date
  /** 一次最多处理几条（防一次搬太多把 IO 打满）。 */
  readonly limit?: number
  readonly log?: (message: string) => void
}

/** 读候选：**只读还没在最冷层的**（已经在最冷层的没什么可搬）。 */
export function listBlobCandidates(db: DatabaseSync, coldest: StorageTier, limit: number): readonly BlobCandidate[] {
  // ★ **必须把 snake_case 映射成 camelCase**（踩过的坑）：
  // SQL 返回的键是**列名**（`storage_tier` / `size_bytes` / `created_at`），
  // 直接当 `BlobCandidate` 用的话 `blob.tier` / `blob.sizeBytes` / `blob.createdAt`
  // **全是 undefined** ⇒ `decideSettle` 拿到 NaN ⇒ 永远回"时间解析不了" ⇒
  // **生产上一条都不会沉降，而失败原因看起来像"数据有问题"**。
  // 这类"字段名对不上"的 bug 不会抛异常，只会静默不干活。
  const rows = db
    .prepare(
      // **注意：media_assets 没有 last_accessed_at 列** ——
      // 所以 blob 的沉降**只能按创建时间算**（不按"多久没被访问"）。
      // 这是个**已知限制**：一个天天被读的老文件也会被沉下去。
      // 记在这里而不是假装有访问时间 —— 假装的话，策略看起来更聪明，
      // 而实际行为与文档不符。
      `SELECT id, sha256, storage_path, storage_tier, size_bytes, created_at
       FROM media_assets
       WHERE storage_tier != ?
       ORDER BY created_at
       LIMIT ?`,
    )
    .all(coldest, limit) as unknown as readonly {
    id: string
    sha256: string
    storage_path: string
    storage_tier: StorageTier
    size_bytes: number
    created_at: string
  }[]
  return rows.map((r) => ({
    id: r.id,
    sha256: r.sha256,
    storagePath: r.storage_path,
    tier: r.storage_tier,
    sizeBytes: r.size_bytes,
    createdAt: r.created_at,
  }))
}

/** 目标路径：`<tier 根>/<sha256 前两位>/<sha256><扩展名>`（分片目录，避免单目录几万文件）。 */
export function tierPathFor(roots: TierRoots, tier: StorageTier, sha256: string, fromPath: string): string {
  const dot = fromPath.lastIndexOf('.')
  const ext = dot === -1 ? '' : fromPath.slice(dot)
  const root = roots.roots[tier].replace(/[\\/]+$/, '')
  const sep = root.includes('\\') ? '\\' : '/'
  return `${root}${sep}${sha256.slice(0, 2)}${sep}${sha256}${ext}`
}

/**
 * 跑一轮沉降。
 *
 * **返回每条的结果**（而不是一个汇总数字）—— 因为"搬了 3 条、失败 2 条"
 * 里最有价值的是**那 2 条为什么失败**。
 */
export async function settleBlobs(options: SettleOptions): Promise<readonly SettleOutcome[]> {
  const now = options.now ?? ((): Date => new Date())
  const log = options.log ?? ((): void => {})
  const limit = options.limit ?? 50
  const at = now()

  // **最冷层**：没有比它更冷的了，已经在它上面的不用动
  // **最冷层**：cold 退回了（没配）就用 warm；warm 也退回了就只剩 hot
  const fellBackTiers = new Set(options.roots.fellBack.map((f) => f.tier))
  const coldest: StorageTier = fellBackTiers.has('cold') ? (fellBackTiers.has('warm') ? 'hot' : 'warm') : 'cold'
  const candidates = listBlobCandidates(options.db, coldest, limit)
  const outcomes: SettleOutcome[] = []

  for (const blob of candidates) {
    const decision = decideSettle(
      {
        tier: blob.tier,
        createdAt: blob.createdAt,
        bytes: blob.sizeBytes,
        // **只能给创建时间**：media_assets 不记录访问时间（见 listBlobCandidates 的注释）。
        // 给 createdAt 等于告诉 decideSettle"从没被访问过" —— 那是**事实**，
        // 不是猜测。给别的值才是编造。
        lastAccessedAt: blob.createdAt,
      },
      at,
      options.policy,
    )

    if (decision.target === undefined) {
      outcomes.push({
        id: blob.id,
        action: 'skipped',
        from: blob.tier,
        to: blob.tier,
        reason: decision.reason,
      })
      continue
    }

    // ★ **再断言一次只往冷处搬** —— 策略 bug 不该能把冷数据拉回 SSD
    const order: Record<StorageTier, number> = { hot: 0, warm: 1, cold: 2 }
    // ★ **夹到实际存在的最冷层**：cold 退回（没配）时 `decideSettle` 仍会说 "cold"，
    // 但物理路径会落到 warm。那时若照记 `storage_tier='cold'`，
    // **库里记的层与文件实际所在不符 —— 那是撒谎**，而排障的人会照着库去 cold 目录找。
    const target = order[decision.target] > order[coldest] ? coldest : decision.target
    if (order[target] <= order[blob.tier]) {
      outcomes.push({
        id: blob.id,
        action: 'skipped',
        from: blob.tier,
        to: blob.tier,
        reason: `拒绝搬到更热或同层（${blob.tier} → ${target}）：搬热是"提升"，属于 recover 而不是沉降`,
      })
      continue
    }

    const toPath = tierPathFor(options.roots, target, blob.sha256, blob.storagePath)
    let moved: MoveOutcome
    try {
      moved = await options.moveFile({ from: blob.storagePath, to: toPath, expectedSha256: blob.sha256 })
    } catch (error) {
      moved = { ok: false, reason: `搬迁抛异常：${String(error).slice(0, 140)}` }
    }

    if (!moved.ok) {
      // **失败不动库** —— 源还在原处，下一轮还能重试
      outcomes.push({ id: blob.id, action: 'failed', from: blob.tier, to: target, reason: moved.reason })
      log(`沉降失败（${blob.id}）：${moved.reason}`)
      continue
    }

    // 校验通过才更新库（moveFile 的契约是"校验不过就不算成功"）
    options.db
      .prepare('UPDATE media_assets SET storage_path = ?, storage_tier = ?, settled_at = ? WHERE id = ?')
      .run(toPath, target, at.toISOString(), blob.id)
    outcomes.push({
      id: blob.id,
      action: 'moved',
      from: blob.tier,
      to: target,
      reason: decision.reason,
      toPath,
    })
    log(`已沉降 ${blob.id}：${blob.tier} → ${target}`)
  }

  return outcomes
}

/**
 * 真实搬迁：`copy → 校验 sha256 → 删源`。
 *
 * **为什么不 `rename`**：跨文件系统（SSD → HDD 正是这种）会 EXDEV 失败；
 * 而"失败了但源已经被删"是最坏的结果。所以走"复制-校验-删"。
 *
 * **校验不过 ⇒ 删掉目标、保留源、报失败** ——
 * 半个文件比没有文件更危险（它看起来是好的）。
 */
export async function moveFileWithVerify(input: {
  readonly from: string
  readonly to: string
  readonly expectedSha256: string
}): Promise<MoveOutcome> {
  const { copyFile, mkdir, readFile, rm } = await import('node:fs/promises')
  const { createHash } = await import('node:crypto')
  const { dirname } = await import('node:path')

  try {
    await mkdir(dirname(input.to), { recursive: true })
    await copyFile(input.from, input.to)
  } catch (error) {
    return { ok: false, reason: `复制失败：${String(error).slice(0, 140)}` }
  }

  let actual: string
  try {
    actual = createHash('sha256').update(await readFile(input.to)).digest('hex')
  } catch (error) {
    return { ok: false, reason: `校验读取失败：${String(error).slice(0, 140)}` }
  }

  if (actual !== input.expectedSha256) {
    // **删掉目标、保留源** —— 半个文件比没有文件更危险（它看起来是好的）
    try {
      await rm(input.to, { force: true })
    } catch {
      // 删不掉也不该让整个任务崩；源还在，数据没丢
    }
    return {
      ok: false,
      reason: `校验不符（期望 ${input.expectedSha256.slice(0, 12)}…，实得 ${actual.slice(0, 12)}…），已保留源文件`,
      verifiedSha256: actual,
    }
  }

  try {
    await rm(input.from, { force: true })
  } catch (error) {
    // 源删不掉：目标已经是好的，数据没丢，只是多占一份
    return { ok: true, reason: `已复制并校验通过，但源文件删不掉（多占一份）：${String(error).slice(0, 100)}`, verifiedSha256: actual }
  }
  return { ok: true, reason: '已复制、校验通过、源已删除', verifiedSha256: actual }
}
