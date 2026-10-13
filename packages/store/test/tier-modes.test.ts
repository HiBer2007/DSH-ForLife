/**
 * 验收标准 #1：**冷层指向 HDD 与指向 SSD 两种配置下，功能完全一致**。
 *
 * ## 这条标准在验什么
 *
 * PLAN 原文：「冷层指向 HDD 与指向 SSD 两种配置下，**功能完全一致**（同一套测试跑两遍）」。
 *
 * 它的现实意义是：**换硬件只改配置**（§2.4 的"全 SSD 模式"）。
 * 用户可能先在一块 SSD 上跑（`cold` 复用 `warm` 的根），
 * 以后加了 HDD 再把 `cold` 指过去 —— **那期间行为不该变**。
 *
 * ## 怎么验"完全一致"
 *
 * 同一个场景跑两遍，只改 `FORLIFE_ROOT_COLD`：
 *  - **A（HDD 模式）**：cold 指向独立根；
 *  - **B（SSD 模式）**：cold 指向 warm 的根（`fellBack` 里会出现 cold）。
 *
 * 然后比对**可观察的行为**：沉降决策、目标层、落库的 tier、路径前缀规则。
 *
 * ## ⚠️ 一处**故意的不一致**，要显眼地验出来
 *
 * SSD 模式下 cold 退回了 warm ⇒ **落库的 `storage_tier` 必须夹到 `warm`**，
 * 否则"库里说在 cold、文件在 warm"——**那是撒谎**，排障的人会照着库去 cold 目录找。
 *
 * 所以"完全一致"指的是**行为一致**（该沉的沉、该跳的跳），
 * **不是"落库的层名一模一样"** —— 后者恰恰**应该**不同。
 * 这条区别必须验出来，否则"一致"会被误读成"连层名都一样"。
 *
 * @module @forlife/store/scripts/check-tier-modes
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { openDatabase } from '../src/db.ts'
import { settleBlobs } from '../src/settle.ts'
import { resolveTierRoots, DEFAULT_SETTLE_POLICY, type TierRoots } from '../src/storage-tiers.ts'

const AT = new Date('2026-10-07T00:00:00.000Z')

/** 造一个库，塞几条不同年龄的 blob。 */
function setup(): ReturnType<typeof openDatabase> {
  const opened = openDatabase({ file: ':memory:' })
  const rows: readonly { id: string; daysAgo: number; bytes: number }[] = [
    { id: 'fresh', daysAgo: 1, bytes: 20_000 },
    { id: 'warmish', daysAgo: 10, bytes: 20_000 },
    { id: 'old', daysAgo: 100, bytes: 20_000 },
    { id: 'tiny', daysAgo: 100, bytes: 10 },
  ]
  for (const r of rows) {
    const created = new Date(AT.getTime() - r.daysAgo * 86_400_000).toISOString()
    opened.db
      .prepare(
        `INSERT INTO media_assets (id, sha256, kind, mime, size_bytes, storage_path, storage_tier, created_at)
         VALUES (?, ?, 'image', 'image/png', ?, ?, 'hot', ?)`,
      )
      .run(r.id, r.id.padEnd(64, '0'), r.bytes, `D:\\hot\\${r.id}.png`, created)
  }
  return opened
}

/** 跑一遍沉降，返回**可观察的行为**（不是内部实现）。 */
async function runSettle(roots: TierRoots): Promise<{
  actions: readonly { id: string; action: string; to: string }[]
  tiers: readonly { id: string; tier: string; path: string }[]
}> {
  const opened = setup()
  try {
    const out = await settleBlobs({
      db: opened.db,
      roots,
      policy: DEFAULT_SETTLE_POLICY,
      moveFile: async () => ({ ok: true, reason: 'ok' }),
      now: () => AT,
    })
    const tiers = opened.db
      .prepare('SELECT id, storage_tier, storage_path FROM media_assets ORDER BY id')
      .all() as unknown as readonly { id: string; tier?: string; storage_tier: string; storage_path: string }[]
    return {
      actions: out.map((o) => ({ id: o.id, action: o.action, to: o.to })).sort((a, b) => a.id.localeCompare(b.id)),
      tiers: tiers.map((t) => ({ id: t.id, tier: t.storage_tier, path: t.storage_path })).sort((a, b) => a.id.localeCompare(b.id)),
    }
  } finally {
    opened.db.close()
  }
}

// ── 两种配置 ──
const HDD_MODE = resolveTierRoots({
  FORLIFE_ROOT_HOT: 'D:\\ssd\\hot',
  FORLIFE_ROOT_WARM: 'D:\\ssd\\warm',
  FORLIFE_ROOT_COLD: 'D:\\hdd\\cold', // ← 独立根（有 HDD）
})
const SSD_MODE = resolveTierRoots({
  FORLIFE_ROOT_HOT: 'D:\\ssd\\hot',
  FORLIFE_ROOT_WARM: 'D:\\ssd\\warm',
  // 不配 cold ⇒ 退回 warm（"全 SSD 模式"）
})

test('★ 两种配置的解析结果：HDD 模式三层独立，SSD 模式 cold 退回 warm', () => {
  assert.deepEqual(HDD_MODE.fellBack, [], 'HDD 模式不该有退回')
  assert.equal(HDD_MODE.roots.cold, 'D:\\hdd\\cold')

  assert.equal(SSD_MODE.fellBack.length, 1, 'SSD 模式应当报"cold 退回了"')
  assert.equal(SSD_MODE.fellBack[0]?.tier, 'cold')
  assert.equal(SSD_MODE.roots.cold, SSD_MODE.roots.warm, 'cold 应当复用 warm 的根')
})

test('★ 验收标准 #1：**沉降决策在两种模式下完全一致**', async () => {
  const a = await runSettle(HDD_MODE)
  const b = await runSettle(SSD_MODE)
  // **只比对"决策"，不比对"目标层名"** —— 目标层名本来就该不同：
  // SSD 模式下 cold 退回了 warm，所以它会被**夹到 warm**（见下面那条 ★★）。
  // 把 `to` 也算进"一致"的话，会把那条**故意的、正确的不一致**判成 bug。
  const decisions = (r: Awaited<ReturnType<typeof runSettle>>): string[] =>
    r.actions.map((x) => `${x.id}:${x.action}`)
  assert.deepEqual(
    decisions(a),
    decisions(b),
    '该沉的沉、该跳的跳 —— 这部分必须完全一致（"换硬件只改配置"就是这条）',
  )
})

test('★ 该沉的条目在两种模式下都沉了（不是"一致地什么都不做"）', async () => {
  const a = await runSettle(HDD_MODE)
  const moved = a.actions.filter((x) => x.action === 'moved').map((x) => x.id)
  assert.deepEqual(moved, ['old', 'warmish'], `应当沉 warmish 与 old，实际 ${moved.join(',')}`)
  // fresh 太新、tiny 太小
  assert.equal(a.actions.find((x) => x.id === 'fresh')?.action, 'skipped')
  assert.equal(a.actions.find((x) => x.id === 'tiny')?.action, 'skipped')
})

test('★★ 一处**故意的不一致**：SSD 模式下落库的 tier 必须夹到 warm', async () => {
  const a = await runSettle(HDD_MODE)
  const b = await runSettle(SSD_MODE)

  // HDD 模式：old（100 天）该到 cold
  assert.equal(a.tiers.find((t) => t.id === 'old')?.tier, 'cold', 'HDD 模式下 old 应当真的在 cold')
  assert.ok(String(a.tiers.find((t) => t.id === 'old')?.path).startsWith('D:\\hdd\\cold'), 'HDD 模式下路径应当在 HDD 上')

  // SSD 模式：cold 退回了 warm ⇒ **必须记 warm**
  assert.equal(
    b.tiers.find((t) => t.id === 'old')?.tier,
    'warm',
    '**SSD 模式下必须记 warm** —— 记 cold 就是"库里说在 cold、文件在 warm"，那是撒谎',
  )
  assert.ok(
    String(b.tiers.find((t) => t.id === 'old')?.path).startsWith('D:\\ssd\\warm'),
    'SSD 模式下路径应当在 warm 根下',
  )
})

test('★ 两种模式的**路径布局规则一致**（同样的分片结构，只是根不同）', async () => {
  const a = await runSettle(HDD_MODE)
  const b = await runSettle(SSD_MODE)
  const rel = (p: string, root: string): string => p.slice(root.length)
  const tierOf = (v: string | undefined): 'hot' | 'warm' | 'cold' =>
    v === 'hot' || v === 'warm' || v === 'cold' ? v : 'warm'
  for (const id of ['old', 'warmish']) {
    const ta = a.tiers.find((t) => t.id === id)
    const tb = b.tiers.find((t) => t.id === id)
    const ra = rel(ta?.path ?? '', HDD_MODE.roots[tierOf(ta?.tier)])
    const rb = rel(tb?.path ?? '', SSD_MODE.roots[tierOf(tb?.tier)])
    assert.equal(ra, rb, `${id} 的相对路径布局应当一致（同样按 sha 前两位分片）`)
  }
})

test('★ 同一套断言跑两遍都过（"同一套测试跑两遍"的字面落实）', async () => {
  for (const [name, roots] of [
    ['HDD 模式', HDD_MODE],
    ['SSD 模式', SSD_MODE],
  ] as const) {
    const r = await runSettle(roots)
    // 同一套断言：不变量（与配置无关）
    assert.ok(r.actions.length === 4, `${name}：四条都要有结果`);
    assert.equal(r.actions.filter((x) => x.action === 'moved').length, 2, `${name}：该沉的是 2 条`)
    assert.equal(r.actions.filter((x) => x.action === 'skipped').length, 2, `${name}：该跳的是 2 条`)
    assert.equal(r.actions.filter((x) => x.action === 'failed').length, 0, `${name}：不该有失败`)
  }
})
