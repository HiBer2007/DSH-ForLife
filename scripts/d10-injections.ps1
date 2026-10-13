# D10（碎片闸门的两个口径）的**注入验证**。
#
#   A token 口径算了但不报出来        ⇒ ★ "两个口径都要写在理由里" 那条必须红
#   B 判定**偷偷换成 token 口径**      ⇒ ★★ "判定没被偷偷改掉" 那条必须红
#   C 生产不再传 budgetTokens         ⇒ 源码守卫必须红
#
# 用法：pwsh -File scripts/d10-injections.ps1
# 报告：FIX_PLAN.md §78.25
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$anchors = Join-Path $repo '.runtime\d10-anchors'
New-Item -ItemType Directory -Force -Path $anchors | Out-Null

function Set-Anchor([string]$name, [string]$text) {
  $path = Join-Path $anchors $name
  [IO.File]::WriteAllText($path, $text.TrimEnd("`n"))
  return $path
}

$cases = @(
  @{
    id = 'A-token 口径算了但不报出来（理由里只剩一套数字）'
    file = 'packages/store/src/fragment-threshold.ts'
    test = 'packages/store/test/fragment-threshold-d10.test.ts'
    good = "        (budgetTokens > 0 ? ``；★ 同一时刻按 token 口径是 `${(tokenRatio * 100).toFixed(1)}%（`${String(fragmentTokens)}/`${String(budgetTokens)}）`` : ''),"
    bad  = "        '',"
  }
  @{
    id = 'B-判定偷偷换成 token 口径（★ 改行为）'
    file = 'packages/store/src/fragment-threshold.ts'
    test = 'packages/store/test/fragment-threshold-d10.test.ts'
    good = '  if (policy.ratio > 0 && fragmented >= policy.minCount && ratio >= policy.ratio) {'
    bad  = '  if (policy.ratio > 0 && fragmented >= policy.minCount && tokenRatio >= policy.ratio) {'
  }
  @{
    id = 'C-生产不再传 budgetTokens（两个口径报不出来）'
    file = 'packages/gateway/src/settle-loop.ts'
    test = 'packages/store/test/fragment-threshold-d10.test.ts'
    good = "        budgetTokens: defaultFor<number>('memory.midBudgetTokens'),"
    bad  = '        budgetTokens: 0,'
  }
)

$failed = 0
foreach ($case in $cases) {
  Write-Host ''
  Write-Host ("════ 注入 {0} ════" -f $case.id)
  $good = Set-Anchor ("{0}-good.txt" -f $case.id.Substring(0, 1)) $case.good
  $bad = Set-Anchor ("{0}-bad.txt" -f $case.id.Substring(0, 1)) $case.bad
  & pwsh -NoProfile -File (Join-Path $repo 'scripts\rollback-verify.ps1') `
    -File $case.file -Good $good -Bad $bad -Test $case.test
  if ($LASTEXITCODE -ne 0) {
    $failed += 1
    Write-Host ("✖ 这条没通过（exit={0}）" -f $LASTEXITCODE)
  }
}

Write-Host ''
Write-Host ("════ 合计：{0} / {1} 条注入验证通过 ════" -f ($cases.Count - $failed), $cases.Count)
if ($failed -gt 0) { exit 1 }
