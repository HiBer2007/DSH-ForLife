# §78.16「模型会读到的句子」英文棘轮的**注入验证**。
#
# 三条：
#   A 往时间块里塞回一句中文      ⇒ 上限 0 必须响
#   B 往每轮入站块里塞回一句中文   ⇒ 上限 0 必须响
#   C 把一个已收官的函数改名       ⇒ "仍然存在"那条守卫必须响（改名不能静默失效）
#
# 用法：pwsh -File scripts/engine-english-injections.ps1
# 报告：FIX_PLAN.md §78.16
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$anchors = Join-Path $repo '.runtime\engine-english-anchors'
New-Item -ItemType Directory -Force -Path $anchors | Out-Null

function Set-Anchor([string]$name, [string]$text) {
  $path = Join-Path $anchors $name
  [IO.File]::WriteAllText($path, $text.TrimEnd("`n"))
  return $path
}

$guard = 'tests/model-visible-english-ratchet.test.ts'

$cases = @(
  @{
    id = 'A-时间块里塞回一句中文（renderTimeBlock 上限 0 必须响）'
    file = 'packages/memory-core/src/clock.ts'
    good = "    '[time reading] (authoritative - everything below follows it)',"
    bad  = "    '[时间读数]（权威值，以下一律以它为准）',"
  }
  @{
    id = 'B-每轮入站块里塞回一句中文（buildTurnPrompt 上限 0 必须响）'
    file = 'packages/gateway/src/turns.ts'
    good = "    '[message from QQ]',"
    bad  = "    '【来自 QQ 的消息】',"
  }
  @{
    id = 'C-把已收官的函数改名（"仍然存在"那条守卫必须响）'
    file = 'packages/memory-core/src/clock.ts'
    good = 'export function describeReason(reason: InjectionReason): string {'
    bad  = 'export function describeReasonX(reason: InjectionReason): string {'
  }
  @{
    id = 'D-第 3 批收官的 feedInput 里塞回中文（上限 0 必须响）'
    file = 'packages/gateway/src/feed-batch.ts'
    good = "if (items.length === 0) return failure('nothing to feed (items is empty, or all blank)')"
    bad  = "if (items.length === 0) return failure('没有可喂的内容（items 为空，或全是空白）')"
  }
  @{
    id = 'E-第 3 批收官的 decideSwitch 里塞回中文（上限 0 必须响）'
    file = 'packages/router/src/routes.ts'
    good = "return { approved: false, reason: 'a switch must state a reason (this one is too short and looks like a casual flip)', remainingBudget, cooldownRemainingMs }"
    bad  = "return { approved: false, reason: '切换必须说明理由（理由太短，看起来像随手切的）', remainingBudget, cooldownRemainingMs }"
  }
)

$failed = 0
foreach ($case in $cases) {
  Write-Host ''
  Write-Host ("════ 注入 {0} ════" -f $case.id)
  $good = Set-Anchor ("{0}-good.txt" -f $case.id.Substring(0, 1)) $case.good
  $bad = Set-Anchor ("{0}-bad.txt" -f $case.id.Substring(0, 1)) $case.bad
  & pwsh -NoProfile -File (Join-Path $repo 'scripts\rollback-verify.ps1') `
    -File $case.file -Good $good -Bad $bad -Test $guard
  if ($LASTEXITCODE -ne 0) {
    $failed += 1
    Write-Host ("✖ 这条没通过（exit={0}）" -f $LASTEXITCODE)
  }
}

Write-Host ''
Write-Host ("════ 合计：{0} / {1} 条注入验证通过 ════" -f ($cases.Count - $failed), $cases.Count)
if ($failed -gt 0) { exit 1 }
