/**
 * 分层可写自检的测试（GOAL 第 4 条）。
 *
 * ## 为什么要有这个自检（真机实测）
 *
 * 2026-10-07 在真 PVE 上发现：**冷层子目录不存在时，写入静默失败** ——
 *
 *     $ touch /cold/tiers/cold/x
 *     touch: /cold/tiers/cold/x: No such file or directory      rc=1
 *     $ docker logs dsh | grep -iE '冷层|cold|tier'
 *     （空 —— 应用一句话都不报）
 *
 * **⇒ 沉降/归档/备份全部写不进去，而运维以为"跑得好好的"。**
 *
 * ## 回退验证（本测试怎么保证它不是空转）
 *
 * 把 `tier-health.ts` 里的 `accessSync(root, constants.W_OK)` 改成 `return true`
 * ⇒ 「不可写的根被识别出来」这条**必须变红**。
 * 反之，把 `mkdirSync` 那一段删掉 ⇒「缺失的根会被创建」**必须变红**。
 */
import { mkdtempSync, rmSync, writeFileSync, existsSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { checkTierWritability, describeTierWritability } from '../src/tier-health.ts'
import type { TierRoots } from '../src/storage-tiers.ts'

/** 造一个假的 TierRoots（只关心 roots / fellBack 两个字段）。 */
function fakeRoots(roots: Record<'hot' | 'warm' | 'cold', string>, fellBack: TierRoots['fellBack'] = []): TierRoots {
  return { roots, fellBack }
}

test('可写的三层根 ⇒ 全部通过，且没有警告', () => {
  const base = mkdtempSync(join(tmpdir(), 'tier-ok-'))
  try {
    const roots = fakeRoots({
      hot: join(base, 'hot'),
      warm: join(base, 'warm'),
      cold: join(base, 'cold'),
    })
    const checks = checkTierWritability(roots)
    assert.equal(checks.length, 3)
    for (const c of checks) {
      assert.equal(c.writable, true, `${c.tier} 应可写`)
      assert.equal(c.created, true, `${c.tier} 是这次新建的`)
    }
    assert.equal(describeTierWritability(checks, []), undefined, '没问题时不该有警告')
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('★ 不可写的根会被识别出来（**这就是那个静默失败的入口**）', () => {
  const base = mkdtempSync(join(tmpdir(), 'tier-bad-'))
  try {
    // ⚠️ 不能拿"一个可写的**文件**"当反例 ——
    //   `accessSync(file, W_OK)` 对可写文件**是成功的**（我第一版就栽在这）。
    //   `chmod 0o500` 在 Windows 上也不生效。
    //   ⇒ 用**父目录不存在**的路径 + `create: false`：这才是跨平台稳的"不可写"。
    const locked = join(base, 'no-such-parent', 'cold')
    const roots = fakeRoots({ hot: join(base, 'hot'), warm: join(base, 'warm'), cold: locked })

    const checks = checkTierWritability(roots, { create: false })
    const cold = checks.find((c) => c.tier === 'cold')
    assert.ok(cold !== undefined)
    assert.equal(cold.writable, false, '不可写的 cold 必须被识别')

    const warning = describeTierWritability(checks, [])
    assert.ok(warning !== undefined, '有问题必须有警告')
    assert.ok(warning.includes('cold'), '警告要点名是哪一层')
    // ★ 必须**说清后果**，不能只说"不可写"
    assert.ok(warning.includes('静默失败'), '警告要说清后果（冷层 ⇒ 静默失败）')
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('★ 缺失的根会被创建（`create: true` 的契约）', () => {
  const base = mkdtempSync(join(tmpdir(), 'tier-mk-'))
  try {
    const deep = join(base, 'a', 'b', 'c')
    assert.equal(existsSync(deep), false, '前提：它还不存在')

    const checks = checkTierWritability(fakeRoots({ hot: deep, warm: deep, cold: deep }))
    assert.equal(checks[0]?.writable, true)
    assert.equal(checks[0]?.created, true)
    assert.equal(existsSync(deep), true, '应该被建出来')
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('`create: false` 时**不**创建（只报告）', () => {
  const base = mkdtempSync(join(tmpdir(), 'tier-noc-'))
  try {
    const missing = join(base, 'missing')
    const checks = checkTierWritability(fakeRoots({ hot: missing, warm: missing, cold: missing }), { create: false })
    assert.equal(checks[0]?.writable, false)
    assert.equal(existsSync(missing), false, '不该被创建')
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('★ 「退回了」也要出警告（否则用户以为真的分了三层在放）', () => {
  const base = mkdtempSync(join(tmpdir(), 'tier-fb-'))
  try {
    const hot = join(base, 'hot')
    const checks = checkTierWritability(fakeRoots({ hot, warm: hot, cold: hot }))
    assert.equal(describeTierWritability(checks, []), undefined, '光可写、没退回 ⇒ 不警告')

    const warned = describeTierWritability(checks, [
      { tier: 'warm', from: 'hot' },
      { tier: 'cold', from: 'hot' },
    ])
    assert.ok(warned !== undefined, '退回了就要警告')
    assert.ok(warned.includes('warm→hot'), '要说清退回了什么')
    assert.ok(warned.includes('没有真的分成三层'), '要说清后果')
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})
