/**
 * 归档导出 + 冷数据提升（PLAN 阶段 9 交付物 3）。
 *
 * ## ⚠️ **与 PLAN 的一处偏离，必须说清**
 *
 * PLAN 写的是「HDD 归档导出（**Parquet**）」。**这里没有用 Parquet**，理由：
 *
 * 1. **仓库里没有任何 Parquet/Arrow 依赖**（`packages/store/package.json`
 *    只有 `@forlife/contracts` 一个依赖）；
 * 2. **手写 Parquet 写入器是不负责任的**：它要自己实现 Thrift 紧凑协议的
 *    文件元数据、列块编码（PLAIN / RLE / 字典）、可选压缩 ——
 *    **一个字段偏移写错，产出的文件就是"看起来像 Parquet 但读不出来"**，
 *    而归档的用途正是"很久以后才回来读"。**那种失败要几个月后才发现。**
 * 3. 归档的价值在**"数据完整 + 能读回来"**，不在格式本身。
 *
 * 所以这里导出的是 **NDJSON + manifest**：
 *  - NDJSON：一行一条、可流式写、可流式读，**任何语言都能读**；
 *  - manifest：记下**列名与类型**，将来要转 Parquet 时**有依据**。
 *
 * **要换成真 Parquet 时**：加一个依赖，写一个 `toParquet(archiveDir)` 转换器 ——
 * manifest 就是为这个准备的。**当前实现不挡这条路。**
 *
 * ## `recover(id)`：把冷数据提回热层
 *
 * 这是**唯一允许"往热处搬"的操作**，而且必须由**访问**触发 ——
 * 那才有依据。所以它**只接受单个 id**，没有"批量提升"：
 * 批量提升等于把沉降的成果一次抹掉，而没人知道为什么。
 *
 * @module @forlife/store/archive
 */
import { createHash } from 'node:crypto'
import { appendFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'

import { resolveTierRoots, type TierRoots } from './storage-tiers.ts'

/** 归档 manifest（**列名与类型**，将来转 Parquet 的依据）。 */
export interface ArchiveManifest {
  readonly version: 1
  /** 导出格式。**故意写死在文件里** —— 读的人不该去猜。 */
  readonly format: 'ndjson'
  readonly createdAt: string
  /** 导出的层（通常 cold）。 */
  readonly tier: string
  readonly rows: number
  readonly bytes: number
  /** 每列的名字与类型。 */
  readonly columns: readonly { readonly name: string; readonly type: string }[]
  /** 内容文件的 sha256（**校验用** —— 归档坏了要能发现）。 */
  readonly contentSha256: string
}

/** 一条归档记录。 */
interface ArchiveRow {
  readonly id: string
  readonly content: string
  readonly summary: string
  readonly entities: string
  readonly createdAt: string
  readonly storageTier: string
  readonly archivePath: string | null
}

/** 导出结果。 */
export interface ArchiveResult {
  readonly ok: boolean
  readonly reason: string
  readonly dir?: string
  readonly rows?: number
  readonly bytes?: number
}

/**
 * 把某一层的长期记忆导出成归档。
 *
 * **只导出、不删除源数据** —— 归档是"多一份"，不是"搬走"。
 * 删源是另一个操作（而且要有校验），不该顺手做。
 */
export async function archiveEntries(options: {
  readonly db: DatabaseSync
  readonly targetDir: string
  readonly tier?: string
  readonly now?: () => Date
  readonly log?: (message: string) => void
}): Promise<ArchiveResult> {
  const now = options.now ?? ((): Date => new Date())
  const log = options.log ?? ((): void => {})
  const tier = options.tier ?? 'cold'

  const rows = options.db
    .prepare(
      `SELECT id, content, summary, entities, created_at, storage_tier, archive_path
       FROM long_memory_entries WHERE storage_tier = ? ORDER BY created_at`,
    )
    .all(tier) as unknown as readonly {
    id: string
    content: string
    summary: string
    entities: string
    created_at: string
    storage_tier: string
    archive_path: string | null
  }[]

  if (rows.length === 0) {
    // **不是失败** —— 那一层没有东西可归档
    return { ok: true, reason: `${tier} 层没有可归档的条目（不是错误）`, rows: 0, bytes: 0 }
  }

  try {
    await mkdir(options.targetDir, { recursive: true })
  } catch (error) {
    return { ok: false, reason: `建目录失败：${String(error).slice(0, 120)}` }
  }

  const contentPath = join(options.targetDir, 'entries.ndjson')
  const mapped: ArchiveRow[] = rows.map((r) => ({
    id: r.id,
    content: r.content,
    summary: r.summary,
    entities: r.entities,
    createdAt: r.created_at,
    storageTier: r.storage_tier,
    archivePath: r.archive_path,
  }))
  const ndjson = mapped.map((r) => JSON.stringify(r)).join('\n') + '\n'

  try {
    await writeFile(contentPath, ndjson, 'utf8')
  } catch (error) {
    return { ok: false, reason: `写归档失败：${String(error).slice(0, 140)}` }
  }

  const bytes = Buffer.byteLength(ndjson, 'utf8')
  const contentSha256 = createHash('sha256').update(ndjson).digest('hex')
  const manifest: ArchiveManifest = {
    version: 1,
    format: 'ndjson',
    createdAt: now().toISOString(),
    tier,
    rows: mapped.length,
    bytes,
    // **列名与类型要写下来** —— 将来转 Parquet 时这就是依据，
    // 而不是"回头看代码里 SELECT 了什么"
    columns: [
      { name: 'id', type: 'string' },
      { name: 'content', type: 'string' },
      { name: 'summary', type: 'string' },
      { name: 'entities', type: 'string' },
      { name: 'createdAt', type: 'string' },
      { name: 'storageTier', type: 'string' },
      { name: 'archivePath', type: 'string?' },
    ],
    contentSha256,
  }
  await writeFile(join(options.targetDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')
  log(`已归档 ${tier} 层 ${String(mapped.length)} 条到 ${options.targetDir}（NDJSON + manifest，**不是 Parquet**，理由见模块头）`)
  return { ok: true, reason: `已归档 ${String(mapped.length)} 条（${String(bytes)} 字节）`, dir: options.targetDir, rows: mapped.length, bytes }
}

/** 读回归档并**校验 sha256**。 */
export async function readArchive(dir: string): Promise<{
  ok: boolean
  reason: string
  manifest?: ArchiveManifest
  rows?: readonly ArchiveRow[]
}> {
  let manifest: ArchiveManifest
  let ndjson: string
  try {
    manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')) as ArchiveManifest
    ndjson = await readFile(join(dir, 'entries.ndjson'), 'utf8')
  } catch (error) {
    return { ok: false, reason: `读归档失败：${String(error).slice(0, 140)}` }
  }

  // **必须校验** —— 归档坏了要能发现，而不是读出一半当成功
  const actual = createHash('sha256').update(ndjson).digest('hex')
  if (actual !== manifest.contentSha256) {
    return {
      ok: false,
      reason: `归档校验不符（manifest 记 ${manifest.contentSha256.slice(0, 12)}…，实得 ${actual.slice(0, 12)}…）`,
      manifest,
    }
  }

  const rows = ndjson
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as ArchiveRow)
  return { ok: true, reason: `归档可用（${String(rows.length)} 条，校验通过）`, manifest, rows }
}

/**
 * **把一条冷数据提回热层**（`recover`）。
 *
 * ## 为什么只接受单个 id
 *
 * 这是**唯一允许"往热处搬"的操作**。批量提升等于把沉降的成果一次抹掉，
 * 而**没人知道为什么** —— 所以它必须由**访问**触发（"我要读它了"），
 * 一次一个。
 *
 * ## 为什么要过 sha256
 *
 * 提升是**跨层复制 + 删源**。校验不过就保留源 —— 与沉降同一条纪律：
 * **半个文件比没有文件更危险**（它看起来是好的）。
 */
export async function recoverEntry(options: {
  readonly db: DatabaseSync
  readonly id: string
  readonly roots: TierRoots
  readonly moveFile: (input: {
    readonly from: string
    readonly to: string
    readonly expectedSha256: string
  }) => Promise<{ readonly ok: boolean; readonly reason: string }>
  readonly now?: () => Date
  readonly log?: (message: string) => void
}): Promise<{ ok: boolean; reason: string; toPath?: string }> {
  const now = options.now ?? ((): Date => new Date())
  const log = options.log ?? ((): void => {})

  const row = options.db
    .prepare('SELECT id, sha256, storage_path, storage_tier, created_at FROM media_assets WHERE id = ?')
    .get(options.id) as
    | { id: string; sha256: string; storage_path: string; storage_tier: string; created_at: string }
    | undefined

  if (row === undefined) {
    return { ok: false, reason: `没有这条 blob：${options.id}` }
  }
  if (row.storage_tier === 'hot') {
    // **已经在热层** —— 明确说清，而不是"成功"（那会让人以为搬过）
    return { ok: false, reason: '它已经在热层了，不需要提升' }
  }

  // 目标路径：hot 根下按 sha 前两位分片（与沉降同一套布局）
  const root = options.roots.roots.hot.replace(/[\\/]+$/, '')
  const sep = root.includes('\\') ? '\\' : '/'
  const dot = row.storage_path.lastIndexOf('.')
  const ext = dot === -1 ? '' : row.storage_path.slice(dot)
  const toPath = `${root}${sep}${row.sha256.slice(0, 2)}${sep}${row.sha256}${ext}`

  const moved = await options.moveFile({ from: row.storage_path, to: toPath, expectedSha256: row.sha256 })
  if (!moved.ok) {
    // **失败不动库** —— 源还在原处
    return { ok: false, reason: `提升失败（源保留在原处）：${moved.reason}` }
  }

  options.db
    .prepare("UPDATE media_assets SET storage_path = ?, storage_tier = 'hot', settled_at = NULL WHERE id = ?")
    .run(toPath, options.id)
  log(`已提升 ${options.id}：${row.storage_tier} → hot`)
  return { ok: true, reason: `已提升回热层：${toPath}`, toPath }
}

/**
 * 列出归档目录里的所有归档（**按时间倒序**）。
 *
 * 面板要显示"有哪些归档、各多少条" —— 否则归档就是"写了但没人知道"。
 */
export async function listArchives(baseDir: string): Promise<
  readonly { readonly name: string; readonly at: string; readonly rows: number; readonly bytes: number }[]
> {
  let entries: string[]
  try {
    entries = await readdir(baseDir)
  } catch {
    return []
  }
  const out: { name: string; at: string; rows: number; bytes: number }[] = []
  for (const name of entries) {
    try {
      const dir = join(baseDir, name)
      if (!(await stat(dir)).isDirectory()) continue
      const m = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')) as ArchiveManifest
      out.push({ name, at: m.createdAt, rows: m.rows, bytes: m.bytes })
    } catch {
      // 不是归档目录 / manifest 坏了 ⇒ 跳过（**不编造 0 条**）
    }
  }
  return out.sort((a, b) => (a.at < b.at ? 1 : -1))
}

/** 归档目录（从环境变量读，**不接受调用方传任意路径**）。 */
export function archiveDirFromEnv(env: Record<string, string | undefined>, stamp: string): string | undefined {
  const base = env['FORLIFE_ARCHIVE_DIR']
  if (base === undefined || base.trim() === '') return undefined
  return join(base.replace(/[\\/]+$/, ''), stamp)
}

export { resolveTierRoots }
