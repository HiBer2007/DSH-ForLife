/**
 * ★★ 三条**级别**判定的守卫（用户 2026-10-11 裁定，见 `FIX_PLAN.md` §55）。
 *
 * 用户逐条点的：
 * - 「**心跳**日志就不用 INFO 了吧，用 **DEBUG**」
 * - 「端点…**额度偏低：monthly 仅剩 3%** 这种不应该是 **WARN** 吗？」
 * - 「**系统监视未启用**：没有配置要盯的挂载点 这种不应该 **NOTE** 吗？」
 *
 * 判据是 `admin/log-levels.ts` 那张表（**轴是"影响范围"，不是"严重感觉"**）：
 * `debug`=过程（量大、默认不落盘）｜`info`=事实｜`note`=判断（不构成异常）｜
 * **`warn`=一次操作出问题但兜住了**｜`error`=一次操作失败｜`fault`=子系统坏了。
 *
 * ★ 两个层次都钉：
 * 1. **行为**：`quota.low` 这个结构化字段算得对（不靠匹配 `note` 文案）。
 * 2. **接线**：那三个调用点**确实**用了对应级别 —— ★ 断言**语句位置**
 *    （§54 的教训：只断言"全文某处出现过 `atLevel`"在接线被删掉时仍会绿）。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { parseOpenCodeGoUsage, QUOTA_WARN_REMAINING_PERCENT } from '../src/quota.ts'

const SRC = join(import.meta.dirname, '..', 'src')

function codeOf(file: string): string {
  return readFileSync(join(SRC, file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')
}

/** 造一个 usage 响应：`percent` 是**已用**百分比（接口的形状）。 */
function usage(percentUsed: number): unknown {
  return { usage: { monthly: { percent: percentUsed } } }
}

// ── 1. 行为：low 这个结构化字段 ──────────────────────────────────────────

test('★★ 额度「偏低」有**结构化**判据（`low`），不靠匹配文案', () => {
  const 充足 = parseOpenCodeGoUsage(usage(10)) // 剩 90%
  const 偏低 = parseOpenCodeGoUsage(usage(97)) // 剩 3%
  const 用尽 = parseOpenCodeGoUsage(usage(100)) // 剩 0%

  assert.equal(充足.kind, 'windows')
  if (充足.kind !== 'windows' || 偏低.kind !== 'windows' || 用尽.kind !== 'windows') {
    assert.fail('这三种都应当是 kind="windows"')
  }

  assert.equal(充足.low, false, '剩 90% ⇒ 不低')
  assert.equal(偏低.low, true, '★ 剩 3% ⇒ **低**（这正是用户截图那条）')
  assert.equal(偏低.ok, true, '★ 偏低**仍然算健康** —— 一低就拦会让系统在还能用的时候提前瘫掉')
  assert.equal(用尽.ok, false, '剩 0% ⇒ 不健康（路由不该再选它）')
})

test('★ 「偏低」的边界就是 `QUOTA_WARN_REMAINING_PERCENT`（不是另写一个数）', () => {
  const 恰好 = parseOpenCodeGoUsage(usage(100 - QUOTA_WARN_REMAINING_PERCENT))
  const 高一档 = parseOpenCodeGoUsage(usage(100 - QUOTA_WARN_REMAINING_PERCENT - 1))
  assert.ok(恰好.kind === 'windows' && 高一档.kind === 'windows')
  // ★ 别在模板字符串里写反引号 —— 它会**截断模板**（我自己刚踩过一次）
  const 线 = String(QUOTA_WARN_REMAINING_PERCENT)
  assert.equal(恰好.low, true, `★ 恰好剩 ${线}% ⇒ 算低（判据是"小于等于"）`)
  assert.equal(高一档.low, false, '高出一档 ⇒ 不算低')
  assert.equal(恰好.ok, true, '★ 恰好踩线时**仍然算健康**（只有剩 0% 才不健康）')
})

// ── 2. 接线：三个调用点的级别 ────────────────────────────────────────────

test('★★★ 心跳是 `debug`（过程、量大）—— 不是 `info`', () => {
  const code = codeOf('wake-liveness.ts')
  assert.match(
    code,
    /atLevel\(\s*log\s*,\s*'debug'\s*\)\s*\(\s*`心跳：/,
    '★★ 「心跳：online=…」这一条必须走 `atLevel(log, \'debug\')` —— ' +
      '每 30 秒一条的"我还活着"是**过程**，不是事实',
  )
  assert.doesNotMatch(
    code,
    /(?:^|[^\w.])log\(\s*`心跳：/m,
    '★★ 直接 `log(\'心跳：…\')` 会落到默认的 `info` —— 那正是被用户点掉的那个写法',
  )
})

test('★★★ 「系统监视未启用」是 `note`（判断，不构成异常）—— 不是 `info`', () => {
  const code = codeOf('wake-system-monitor.ts')
  assert.match(
    code,
    /atLevel\(\s*log\s*,\s*'note'\s*\)\s*\(\s*'系统监视未启用/,
    '★★ 「系统监视未启用」必须走 `atLevel(log, \'note\')`',
  )
})

test('★★★ 端点额度级别**按额度定**：充足 info / 偏低 warn / 用尽 fault', () => {
  const code = codeOf('endpoint-health.ts')
  // ★ 断言**派生关系**（而不是只断言出现过 'warn'）：
  assert.match(
    code,
    /const\s+quotaLevel\s*:\s*LogLevel\s*=\s*!quotaOk\s*\?\s*'fault'\s*:\s*quota\.kind\s*===\s*'windows'\s*&&\s*quota\.low\s*\?\s*'warn'\s*:\s*'info'/,
    '★★ 级别必须由 `quotaOk` / `quota.low` **派生**：' +
      '用尽 ⇒ `fault`（子系统坏了）｜偏低 ⇒ **`warn`**（已降级）｜其余 ⇒ `info`',
  )
  assert.match(
    code,
    /atLevel\(\s*log\s*,\s*quotaLevel\s*\)/,
    '★ 那一行日志必须用派生出来的 `quotaLevel`',
  )
  assert.doesNotMatch(
    code,
    /describeQuota\(quota\)[^\n]*\)\s*\n?[^\n]*log\(/,
    '★ 不许退回到裸 `log(...)`（那会一律落到 info）',
  )
})

test('★ 级别判定**不匹配文案**（`note` 是给人看的，不是给代码读的）', () => {
  for (const file of ['endpoint-health.ts', 'wake-liveness.ts', 'wake-system-monitor.ts']) {
    const code = codeOf(file)
    assert.doesNotMatch(
      code,
      /note\s*\.\s*(?:includes|startsWith|match)\s*\(\s*['"`]额度/,
      `★★ ${file} 在**从文案猜级别** —— 那正是 log-buffer 的 guessLevel 被取代的原因`,
    )
  }
})
