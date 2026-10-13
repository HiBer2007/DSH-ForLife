/**
 * 长期记忆 HDD 沉降（PLAN §6.3 的"扫描"那一半）的测试。
 *
 * ## 最值得守的四条
 *
 * 1. **先写归档、读回校验、最后才置空** —— 顺序错了（先置空）时，
 *    写失败会让正文两头都没有，而**条目还在、检索还命中**：
 *    用户看到的是"这条记忆是空的"，不是"沉降失败了"。
 * 2. **校验不过 ⇒ 删掉半成品、保留库内正文、报失败** ——
 *    与 blob 沉降同一条纪律：半个文件比没有文件更危险。
 * 3. **正文本来就不在库里的条目不动** —— 把 NULL 置成 NULL 不是沉降，
 *    是给一个空壳贴上"已归档"的标签。
 * 4. **90 天 / 200 条这两个数来自 plan-baseline** —— 不在代码里另写一个。
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'

import {
  DEFAULT_LONG_SETTLE_POLICY,
  insertLongEntry,
  loadLongEntry,
  longArchivePath,
  longSettlePolicyFromEnv,
  openDatabase,
  searchLongFts,
  settleLongEntries,
  type ColdArchivePort,
} from '../src/index.ts'

const tempDir = (): string => mkdtempSync(join(tmpdir(), 'forlife-longsettle-'))

/** Windows 上刚关掉的 SQLite 文件仍可能被杀毒/索引器短暂持有（环境问题，不是测试失败）。 */
async function cleanup(dir: string): Promise<void> {
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true })
      return
    } catch {
      await delay(40)
    }
  }
}

const DAY = 86_400_000
const OLD = (days: number): string => new Date(Date.now() - days * DAY).toISOString()

/**
 * 造一条"该沉降"的长期条目。
 *
 * **走真实写入路径**（`insertLongEntry` 会同步 FTS 索引）—— 直接 INSERT 的话，
 * "沉降后 FTS 仍命中"那一条就证明不了什么。
 */
function addOldLong(
  opened: ReturnType<typeof openDatabase>,
  id: string,
  content: string,
  opts: { days?: number; tier?: 'ssd' | 'hdd'; archivePath?: string | null } = {},
): void {
  insertLongEntry(opened.db, {
    id,
    content,
    summary: `摘要 ${id}`,
    ...(opts.tier === undefined ? {} : { storageTier: opts.tier }),
  })
  const days = opts.days ?? 100
  opened.db
    .prepare('UPDATE long_memory_entries SET created_at = ?, last_accessed_at = ?, archive_path = ? WHERE id = ?')
    .run(OLD(days), OLD(days), opts.archivePath ?? null, id)
}

/** 内存里的归档端口（测试用：不碰磁盘，但记录写了什么、删了什么）。 */
function memoryPort(): {
  readonly port: ColdArchivePort
  readonly files: Map<string, string>
  readonly removed: string[]
} {
  const files = new Map<string, string>()
  const removed: string[] = []
  return {
    files,
    removed,
    port: {
      write: async (path, text): Promise<void> => {
        files.set(path, text)
      },
      read: async (path): Promise<string> => {
        const text = files.get(path)
        if (text === undefined) throw new Error(`ENOENT: ${path}`)
        return text
      },
      remove: async (path): Promise<void> => {
        files.delete(path)
        removed.push(path)
      },
    },
  }
}

test('★ 沉一条：正文移入归档、表内 content 置空、storage_tier=hdd', async () => {
  const opened = openDatabase({ file: ':memory:' })
  try {
    addOldLong(opened, 'L1', '这是要被沉到 HDD 的正文')
    const { port, files } = memoryPort()
    const outcomes = await settleLongEntries({ db: opened.db, coldRoot: 'D:\\hdd\\cold', port })

    assert.equal(outcomes.length, 1)
    assert.equal(outcomes[0]?.action, 'settled', `应当沉降成功：${String(outcomes[0]?.reason)}`)
    assert.match(String(outcomes[0]?.archivePath), /longterm/)

    const row = opened.db.prepare('SELECT content, storage_tier, archive_path FROM long_memory_entries WHERE id = ?').get('L1')
    assert.equal(row?.content, null, '**表内正文必须置空**（PLAN §6.3 原文）')
    assert.equal(row?.storage_tier, 'hdd', '**层级必须改成 hdd**')
    assert.equal(row?.archive_path, outcomes[0]?.archivePath, '归档路径要落库（否则按需加载不知道去哪读）')
    assert.equal(files.get(String(outcomes[0]?.archivePath)), '这是要被沉到 HDD 的正文', '归档文件里必须**就是正文**')
  } finally {
    opened.db.close()
  }
})

test('★★ 沉降后 FTS 仍命中，且能**按需取回**（否则沉降 = 从记忆里消失）', async () => {
  const opened = openDatabase({ file: ':memory:' })
  const dir = tempDir()
  try {
    addOldLong(opened, 'L1', '防抖窗口 2-3 秒，per-key mutex')
    // **真实文件系统**（这一条要证明的是"写出去的东西能读回来"，替身证明不了）
    const outcomes = await settleLongEntries({ db: opened.db, coldRoot: dir })
    assert.equal(outcomes[0]?.action, 'settled')

    const hits = searchLongFts(opened.db, '防抖', 5)
    assert.equal(hits.length, 1, '沉降**不该**让它从检索里消失（FTS 索引不动）')
    assert.equal(hits[0]?.content, null, '命中的行里正文是 NULL —— 这正是"必须按需加载"的原因')

    const loaded = await loadLongEntry({ db: opened.db, id: 'L1' })
    assert.equal(loaded.found, true)
    assert.equal(loaded.source, 'archive', '**必须是从归档读的**（source 要如实）')
    assert.equal(loaded.content, '防抖窗口 2-3 秒，per-key mutex', '正文必须能原样取回')
    assert.ok(existsSync(String(outcomes[0]?.archivePath)), '归档文件必须真的在磁盘上')
  } finally {
    opened.db.close()
    await cleanup(dir)
  }
})

test('★★ 写归档失败 ⇒ **库内正文一动不动**（不置空、不改 tier）', async () => {
  const opened = openDatabase({ file: ':memory:' })
  try {
    addOldLong(opened, 'L1', '正文还在')
    const outcomes = await settleLongEntries({
      db: opened.db,
      coldRoot: 'D:\\hdd\\cold',
      port: {
        write: async (): Promise<void> => {
          throw new Error('磁盘满了')
        },
        read: async (): Promise<string> => '',
        remove: async (): Promise<void> => {},
      },
    })
    assert.equal(outcomes[0]?.action, 'failed')
    assert.match(String(outcomes[0]?.reason), /磁盘满了/)
    const row = opened.db.prepare('SELECT content, storage_tier FROM long_memory_entries WHERE id = ?').get('L1')
    assert.equal(row?.content, '正文还在', '**正文必须还在原处** —— 否则就是静默的数据丢失')
    assert.equal(row?.storage_tier, 'ssd', '没沉成功就不能标 hdd')
  } finally {
    opened.db.close()
  }
})

test('★★ 读回校验不符 ⇒ 保留库内正文 + 删掉半成品文件 + 报失败', async () => {
  const opened = openDatabase({ file: ':memory:' })
  try {
    addOldLong(opened, 'L1', '完整正文')
    const { port, files, removed } = memoryPort()
    const written: string[] = []
    const outcomes = await settleLongEntries({
      db: opened.db,
      coldRoot: 'D:\\hdd\\cold',
      port: {
        write: async (path, text): Promise<void> => {
          written.push(path)
          await port.write(path, text)
        },
        // 读回来是**半截**（模拟写了一半 / 磁盘坏块）
        read: async (): Promise<string> => '完整',
        remove: port.remove,
      },
    })
    assert.equal(outcomes[0]?.action, 'failed')
    assert.match(String(outcomes[0]?.reason), /校验不符/)
    const row = opened.db.prepare('SELECT content, storage_tier, archive_path FROM long_memory_entries WHERE id = ?').get('L1')
    assert.equal(row?.content, '完整正文', '**校验不过就不能置空** —— 否则正文两头都没有')
    assert.equal(row?.storage_tier, 'ssd')
    assert.equal(row?.archive_path, null)
    assert.equal(files.size, 0, '**半成品文件必须删掉**（它看起来是好的，比没有文件更危险）')
    assert.equal(removed.length, 1, '要真的调删除，而不是"忘了删"')
    assert.equal(written.length, 1)
  } finally {
    opened.db.close()
  }
})

test('★★ 正文本来就不在库里的条目**不动它**（置空 NULL 不是沉降，是给空壳贴标签）', async () => {
  const opened = openDatabase({ file: ':memory:' })
  try {
    opened.db
      .prepare(
        `INSERT INTO long_memory_entries (id, content, summary, storage_tier, status, created_at, last_accessed_at)
         VALUES ('L-empty', NULL, '空壳', 'ssd', 'active', ?, ?)`,
      )
      .run(OLD(200), OLD(200))
    const { port, files } = memoryPort()
    const outcomes = await settleLongEntries({ db: opened.db, coldRoot: 'D:\\hdd\\cold', port })
    assert.equal(outcomes[0]?.action, 'skipped')
    assert.match(String(outcomes[0]?.reason), /正文已不在库内/)
    const row = opened.db.prepare('SELECT storage_tier FROM long_memory_entries WHERE id = ?').get('L-empty')
    assert.equal(row?.storage_tier, 'ssd', '**绝不能标成 hdd** —— 那会让它看起来"已归档"，而实际取不回来')
    assert.equal(files.size, 0, '也不该写空文件')
  } finally {
    opened.db.close()
  }
})

test('★ 已经有归档文件的条目不重复沉降（重复会把旧归档变成孤儿）', async () => {
  const opened = openDatabase({ file: ':memory:' })
  try {
    addOldLong(opened, 'L1', '正文', { archivePath: 'D:\\hdd\\cold\\old.txt' })
    const { port, files } = memoryPort()
    const outcomes = await settleLongEntries({ db: opened.db, coldRoot: 'D:\\hdd\\cold', port })
    assert.equal(outcomes[0]?.action, 'skipped')
    assert.match(String(outcomes[0]?.reason), /已经有归档文件/)
    assert.equal(files.size, 0)
  } finally {
    opened.db.close()
  }
})

test('★ 90 天 / 200 条来自 plan-baseline（不在代码里另写一个数）', () => {
  assert.equal(DEFAULT_LONG_SETTLE_POLICY.afterDays, 90, 'PLAN §6.3：last_accessed_at > 90 天')
  assert.equal(DEFAULT_LONG_SETTLE_POLICY.batchSize, 200, 'EXECUTION_PLAN §2.4：一批 200 条')
})

test('★ 边界：85 天的不沉、95 天的沉（"90 天"是阈值，不是摆设）', async () => {
  const opened = openDatabase({ file: ':memory:' })
  try {
    addOldLong(opened, 'L-fresh', '还新', { days: 85 })
    addOldLong(opened, 'L-stale', '该沉了', { days: 95 })
    const outcomes = await settleLongEntries({ db: opened.db, coldRoot: 'D:\\hdd\\cold', port: memoryPort().port })
    assert.deepEqual(
      outcomes.map((o) => o.id),
      ['L-stale'],
      '只该扫到 95 天那条',
    )
  } finally {
    opened.db.close()
  }
})

test('★ 一批最多 batchSize 条（默认 200，防一次搬太多把 IO 打满）', async () => {
  const opened = openDatabase({ file: ':memory:' })
  try {
    const insert = opened.db.prepare(
      `INSERT INTO long_memory_entries (id, content, summary, storage_tier, status, created_at, last_accessed_at)
       VALUES (?, ?, '摘要', 'ssd', 'active', ?, ?)`,
    )
    for (let i = 0; i < 205; i++) insert.run(`L${String(i)}`, `正文 ${String(i)}`, OLD(100), OLD(100))
    const outcomes = await settleLongEntries({ db: opened.db, coldRoot: 'D:\\hdd\\cold', port: memoryPort().port })
    assert.equal(outcomes.length, DEFAULT_LONG_SETTLE_POLICY.batchSize, '一轮只处理 batchSize 条')
    assert.equal(outcomes.filter((o) => o.action === 'settled').length, DEFAULT_LONG_SETTLE_POLICY.batchSize)
  } finally {
    opened.db.close()
  }
})

test('★ 策略可被环境变量覆盖，非法值一律回落基线（0/负数会让比较反过来）', () => {
  assert.deepEqual(longSettlePolicyFromEnv({}), { afterDays: 90, batchSize: 200 })
  assert.deepEqual(longSettlePolicyFromEnv({ FORLIFE_LONG_SETTLE_AFTER_DAYS: '30', FORLIFE_LONG_SETTLE_BATCH: '5' }), {
    afterDays: 30,
    batchSize: 5,
  })
  assert.deepEqual(longSettlePolicyFromEnv({ FORLIFE_LONG_SETTLE_AFTER_DAYS: '0' }), { afterDays: 90, batchSize: 200 })
  assert.deepEqual(longSettlePolicyFromEnv({ FORLIFE_LONG_SETTLE_AFTER_DAYS: 'abc' }), { afterDays: 90, batchSize: 200 })
})

test('★ 归档路径：id 里的 `..` 与分隔符**不能逃出冷层根**，不同 id 也不能撞名', () => {
  const root = 'D:\\hdd\\cold'
  const evil = longArchivePath(root, '../../evil')
  assert.ok(evil.startsWith(`${root}\\longterm\\`), `必须在冷层根的 longterm/ 下：${evil}`)
  assert.ok(!evil.includes('..'), '**点必须被换掉** —— "只由点组成的段"是路径逃逸的经典写法')
  assert.ok(!evil.includes('/'), '不能留正斜杠')

  const a = longArchivePath(root, 'long_from_mid_1')
  const b = longArchivePath(root, 'long_from_mid_2')
  assert.notEqual(a, b, '不同 id 必须落到不同文件（否则后沉的会覆盖先沉的）')

  // 末尾分隔符不该产生 `\\longterm` 这种双斜杠
  assert.equal(longArchivePath(`${root}\\`, 'x').startsWith(`${root}\\longterm\\`), true)
})

test('★ 只扫 ssd 层：已经是 hdd 的条目不再扫（否则会重复写归档）', async () => {
  const opened = openDatabase({ file: ':memory:' })
  try {
    addOldLong(opened, 'L-hdd', '已沉降的正文', { tier: 'hdd', archivePath: 'D:\\hdd\\cold\\x.txt' })
    const outcomes = await settleLongEntries({ db: opened.db, coldRoot: 'D:\\hdd\\cold', port: memoryPort().port })
    assert.deepEqual(outcomes, [], 'hdd 条目不在候选里')
  } finally {
    opened.db.close()
  }
})

test('★ 没有候选时不报错、也不写文件', async () => {
  const opened = openDatabase({ file: ':memory:' })
  try {
    const { port, files } = memoryPort()
    const outcomes = await settleLongEntries({ db: opened.db, coldRoot: 'D:\\hdd\\cold', port })
    assert.deepEqual(outcomes, [])
    assert.equal(files.size, 0)
  } finally {
    opened.db.close()
  }
})

test('★ 归档目录会被自动创建（冷层根还不存在时不该失败）', async () => {
  const opened = openDatabase({ file: ':memory:' })
  const dir = tempDir()
  try {
    const nested = join(dir, 'hdd', 'cold')
    addOldLong(opened, 'L1', '正文')
    const outcomes = await settleLongEntries({ db: opened.db, coldRoot: nested })
    assert.equal(outcomes[0]?.action, 'settled', `应当自己建目录：${String(outcomes[0]?.reason)}`)
    const file = String(outcomes[0]?.archivePath)
    assert.ok(existsSync(file))
    assert.equal(readFileSync(file, 'utf8'), '正文')
  } finally {
    opened.db.close()
    await cleanup(dir)
  }
})
