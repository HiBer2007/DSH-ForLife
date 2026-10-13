# §76.5⑦/⑧ 的**账目审计**（把"陈旧条目"钉死）+ L2 预算（§76.5⑦ 的最后一个 ❌）。
#
#   A 超预算不再做边沿检测（每轮都喊）    ⇒ ★ "只喊一次" 那条必须红
#   B 恢复不复位（overNow 永远 true）     ⇒ ★ "复位后还能再喊" 那条必须红
#   C 生产路径不再检查 L2 文本            ⇒ 源码守卫必须红（"造了不检查"）
#   D 预算在代码里写死（不读契约键）      ⇒ 源码守卫必须红
#
# 用法：pwsh -File scripts/l2-budget-injections.ps1
# 报告：FIX_PLAN.md §78.24
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$anchors = Join-Path $repo '.runtime\l2-budget-anchors'
New-Item -ItemType Directory -Force -Path $anchors | Out-Null

function Set-Anchor([string]$name, [string]$text) {
  $path = Join-Path $anchors $name
  [IO.File]::WriteAllText($path, $text.TrimEnd("`n"))
  return $path
}

$cases = @(
  @{
    id = 'A-超预算不再做边沿检测（每轮都喊）'
    file = 'packages/dsh-component/src/budget-check.ts'
    test = 'packages/dsh-component/test/budget-check.test.ts'
    good = '      if (over && !overNow) {'
    bad  = '      if (over) {'
  }
  @{
    id = 'B-恢复不复位（overNow 永远 true ⇒ 下次真超了不会再喊）'
    file = 'packages/dsh-component/src/budget-check.ts'
    test = 'packages/dsh-component/test/budget-check.test.ts'
    good = '        overNow = false'
    bad  = '        overNow = true'
  }
  @{
    id = 'C-生产路径不再检查 L2 文本（造了不检查）'
    file = 'packages/dsh-component/src/index.ts'
    test = 'packages/dsh-component/test/budget-check.test.ts'
    good = '    l2Budget.check(runtime.l2Text())'
    bad  = '    void l2Budget'
  }
  @{
    id = 'E-不再记基线（"检查跑没跑"又变得看不出来）'
    file = 'packages/dsh-component/src/budget-check.ts'
    test = 'packages/dsh-component/test/budget-check.test.ts'
    good = '      if (!baselineDone) {'
    bad  = '      if (false) {'
  }
  @{
    id = 'D-预算在代码里写死（不再读契约键）'
    file = 'packages/dsh-component/src/index.ts'
    test = 'packages/dsh-component/test/budget-check.test.ts'
    good = "      budgetTokens: defaultFor<number>('memory.l2BudgetTokens'),"
    bad  = '      budgetTokens: 100000,'
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
