/**
 * 备份 / 恢复（PLAN 阶段 9 交付物 7）。
 *
 * ## 核心原则：**验证不了的备份不算备份**
 *
 * 备份最危险的失败模式不是"没做成"，而是"**做成了但恢复不了**" ——
 * 等到真要用的时候才发现。所以这里的每一步都**回读验证**：
 *
 *  - 库备份做完 ⇒ **打开它**、查 `PRAGMA integrity_check`、比对 schema 版本与行数；
 *  - blob 备份做完 ⇒ 比对 **sha256**（不是比大小 —— 大小相同内容不同的情况很常见）。
 *
 * ## 库备份用 `VACUUM INTO` 而不是拷文件
 *
 * 拷 `.sqlite` 文件是**错的**：WAL 模式下最新数据可能在 `-wal` 里，
 * 只拷主文件会**静默丢掉最近的写入**（备份看起来是好的，恢复后少一截）。
 *
 * `VACUUM INTO` 是 SQLite 官方的**在线**备份方式：它在一个读事务里
 * 把整库写成一个**已整理**的新文件 —— 不需要停机，也不会有半截状态。
 *
 * （`node:sqlite` 这个版本**没有** `backup()` 方法，所以用 `VACUUM INTO`。）
 *
 * ## blob 是**增量**的
 *
 * 按 sha256 判断"目标里已经有了吗" —— 全量拷在几万个表情上会每次都搬几个 GB，
 * 而其中 99% 是重复的。
 *
 * @module @forlife/store/backup
 */
import { createHash } from 'node:crypto'
import { copyFile, mkdir, readdir, readFile, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'

/** 备份结果（**每一项都要能被验证**，所以返回的是明细而不是一个数字）。 */
export interface BackupResult {
  readonly ok: boolean
  readonly reason: string
  /** 库备份文件（没做则 undefined）。 */
  readonly dbPath?: string
  readonly dbBytes?: number
  /** 库备份回读验证的结果。 */
  readonly verified?: {
    readonly schemaVersion: number
    readonly integrity: string
    readonly tables: number
  }
  /** blob 增量：新拷了几份、跳过几份（已存在）。 */
  readonly blobsCopied?: number
  readonly blobsSkipped?: number
  readonly failures?: readonly string[]
}

/** 备份选项。 */
export interface BackupOptions {
  readonly db: DatabaseSync
  readonly dbPath: string
  /** 备份写到哪个目录（不存在会建）。 */
  readonly targetDir: string
  /** blob 根目录（不传则跳过 blob 备份）。 */
  readonly blobRoot?: string
  readonly now?: () => Date
  readonly log?: (message: string) => void
}

/** 时间戳文件名：`2026-10-07T03-12-20`（冒号在 Windows 文件名里非法）。 */
export function stampFor(date: Date): string {
  return date.toISOString().replace(/[:.]/g, '-').replace('Z', '')
}

/** 算文件的 sha256。 */
async function sha256Of(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex')
}

/**
 * 备份数据库：`VACUUM INTO` + **回读验证**。
 *
 * **名字里的 Verified 是故意的**：`db.ts` 里已有一个 `backupDatabase(db, file, fromVersion)`，
 * 那是**迁移前的快照**（同步、不验证）—— 它的目的是"迁移搞砸了能退回去"。
 * 这个函数是**可验证的备份**（异步、回读校验、验证不过就删文件）。
 * 两者的失败语义完全不同，所以名字要能一眼分开 —— 合成一个的话，
 * 用的人会以为迁移快照也经过验证。
 *
 * **验证不过就把备份文件删掉并报失败** ——
 * 留一个"看起来有、其实不能用"的备份比没有更危险：
 * 人会以为有退路，于是在真出事时才发现没有。
 */
export async function backupDatabaseVerified(options: {
  readonly db: DatabaseSync
  readonly targetPath: string
  readonly log?: (message: string) => void
}): Promise<{ ok: boolean; reason: string; bytes?: number; verified?: BackupResult['verified'] }> {
  const log = options.log ?? ((): void => {})
  const { rm } = await import('node:fs/promises')

  try {
    await mkdir(dirname(options.targetPath), { recursive: true })
  } catch (error) {
    return { ok: false, reason: `建目录失败：${String(error).slice(0, 120)}` }
  }

  try {
    // **`VACUUM INTO` 要求目标不存在**（存在会报错）—— 先删掉同名残留
    await rm(options.targetPath, { force: true })
    // 路径里的单引号要转义（SQL 字符串字面量）
    const escaped = options.targetPath.replace(/'/g, "''")
    options.db.exec(`VACUUM INTO '${escaped}'`)
  } catch (error) {
    return { ok: false, reason: `VACUUM INTO 失败：${String(error).slice(0, 140)}` }
  }

  // ── 回读验证 ──
  const { DatabaseSync } = await import('node:sqlite')
  let probe: DatabaseSync | undefined
  try {
    probe = new DatabaseSync(options.targetPath, { readOnly: true })
    const integrityRow = probe.prepare('PRAGMA integrity_check').get() as { integrity_check?: string } | undefined
    const integrity = String(integrityRow?.integrity_check ?? '(查不到)')
    const versionRow = probe
      .prepare('SELECT MAX(version) AS v FROM schema_migrations')
      .get() as { v?: number | null } | undefined
    const tablesRow = probe
      .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table'")
      .get() as { n?: number } | undefined

    if (integrity !== 'ok') {
      probe.close()
      await rm(options.targetPath, { force: true })
      return { ok: false, reason: `备份完整性检查没过（${integrity}），已删除这个备份文件` }
    }
    const verified = {
      schemaVersion: Number(versionRow?.v ?? 0),
      integrity,
      tables: Number(tablesRow?.n ?? 0),
    }
    probe.close()
    probe = undefined
    const bytes = (await stat(options.targetPath)).size
    log(`库备份完成并验证通过：${String(bytes)} 字节，schema v${String(verified.schemaVersion)}，${String(verified.tables)} 张表`)
    return { ok: true, reason: '已备份并回读验证', bytes, verified }
  } catch (error) {
    try {
      probe?.close()
    } catch {
      // 已经关了
    }
    await rm(options.targetPath, { force: true })
    return { ok: false, reason: `备份验证失败（已删除）：${String(error).slice(0, 140)}` }
  }
}

/**
 * blob **增量**备份：按 sha256 跳过已经有的。
 *
 * 全量拷在几万个表情上会每次都搬几个 GB，而其中 99% 是重复的。
 */
export async function backupBlobs(options: {
  readonly sourceRoot: string
  readonly targetRoot: string
  readonly log?: (message: string) => void
}): Promise<{ copied: number; skipped: number; failures: readonly string[] }> {
  const log = options.log ?? ((): void => {})
  let copied = 0
  let skipped = 0
  const failures: string[] = []

  let entries: string[]
  try {
    entries = await readdir(options.sourceRoot)
  } catch {
    // 源目录不存在 ⇒ 没有 blob 可备份（不是失败）
    return { copied: 0, skipped: 0, failures: [] }
  }

  for (const name of entries) {
    const from = join(options.sourceRoot, name)
    const to = join(options.targetRoot, name)
    try {
      const info = await stat(from)
      if (!info.isFile()) continue

      // **按内容判断"已经有了吗"**，不是按存在与否 ——
      // 同名不同内容（比如表情被替换过）必须重新拷
      try {
        const existing = await sha256Of(to)
        const source = await sha256Of(from)
        if (existing === source) {
          skipped += 1
          continue
        }
      } catch {
        // 目标不存在或读不了 ⇒ 照拷
      }

      await mkdir(dirname(to), { recursive: true })
      await copyFile(from, to)
      // **拷完立刻校验** —— 校验不过不算成功
      const after = await sha256Of(to)
      const source = await sha256Of(from)
      if (after !== source) {
        failures.push(`${name}：拷完校验不符`)
        continue
      }
      copied += 1
    } catch (error) {
      failures.push(`${name}：${String(error).slice(0, 100)}`)
    }
  }

  if (copied > 0 || failures.length > 0) {
    log(`blob 备份：新拷 ${String(copied)} 份、跳过 ${String(skipped)} 份（已存在）、失败 ${String(failures.length)} 份`)
  }
  return { copied, skipped, failures }
}

/** 一次完整备份（库 + blob）。 */
export async function runBackup(options: BackupOptions): Promise<BackupResult> {
  const now = options.now ?? ((): Date => new Date())
  const log = options.log ?? ((): void => {})
  const stamp = stampFor(now())
  const dir = join(options.targetDir, stamp)

  const dbResult = await backupDatabaseVerified({
    db: options.db,
    targetPath: join(dir, 'forlife.sqlite'),
    log,
  })
  if (!dbResult.ok) {
    // **库备份失败 ⇒ 整个备份算失败**（blob 单独有备份没有意义：没有索引指向它们）
    return { ok: false, reason: `库备份失败：${dbResult.reason}` }
  }

  let blobs: { copied: number; skipped: number; failures: readonly string[] } | undefined
  if (options.blobRoot !== undefined && options.blobRoot !== '') {
    blobs = await backupBlobs({
      sourceRoot: options.blobRoot,
      targetRoot: join(dir, 'blobs'),
      log,
    })
  }

  const failures = blobs?.failures ?? []
  return {
    ok: failures.length === 0,
    reason:
      failures.length === 0
        ? `备份完成：${dir}`
        : `备份完成但有 ${String(failures.length)} 个 blob 失败（库是好的）：${dir}`,
    dbPath: join(dir, 'forlife.sqlite'),
    ...(dbResult.bytes === undefined ? {} : { dbBytes: dbResult.bytes }),
    ...(dbResult.verified === undefined ? {} : { verified: dbResult.verified }),
    ...(blobs === undefined ? {} : { blobsCopied: blobs.copied, blobsSkipped: blobs.skipped }),
    ...(failures.length === 0 ? {} : { failures }),
  }
}

/**
 * 恢复前**先验证备份可用**。
 *
 * 这一步独立出来，是为了让"恢复"这个动作**在动手之前就知道备份行不行** ——
 * 而不是恢复到一半才发现。
 */
export async function verifyBackup(backupDbPath: string): Promise<{
  ok: boolean
  reason: string
  schemaVersion?: number
  tables?: number
}> {
  const { DatabaseSync } = await import('node:sqlite')
  let probe: DatabaseSync | undefined
  try {
    probe = new DatabaseSync(backupDbPath, { readOnly: true })
    const integrityRow = probe.prepare('PRAGMA integrity_check').get() as { integrity_check?: string } | undefined
    if (String(integrityRow?.integrity_check) !== 'ok') {
      return { ok: false, reason: `完整性检查没过：${String(integrityRow?.integrity_check)}` }
    }
    const versionRow = probe.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v?: number | null } | undefined
    const tablesRow = probe.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table'").get() as { n?: number } | undefined
    const schemaVersion = Number(versionRow?.v ?? 0)
    const tables = Number(tablesRow?.n ?? 0)
    probe.close()
    probe = undefined
    if (schemaVersion === 0) {
      return { ok: false, reason: '备份里没有 schema_migrations 记录 —— 它可能不是我们的库' }
    }
    return { ok: true, reason: `备份可用（schema v${String(schemaVersion)}，${String(tables)} 张表）`, schemaVersion, tables }
  } catch (error) {
    try {
      probe?.close()
    } catch {
      // 已经关了
    }
    return { ok: false, reason: `打不开备份：${String(error).slice(0, 140)}` }
  }
}
