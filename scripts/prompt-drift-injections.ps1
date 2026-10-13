# 提示词漂移读数（§76.5③ 的第 3 件）的**注入验证**。
#
# 两条：
#   A 让 `promptSeedDrift` **永远返回 same** ⇒ "被人改过 ⇒ differs"那条守卫必须红
#   B 把 `index.ts` 里的读数循环**删掉** ⇒ 接线守卫 + 端到端必须红
#
# 用法：pwsh -File scripts/prompt-drift-injections.ps1
# 报告：FIX_PLAN.md §78.12
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$anchors = Join-Path $repo '.runtime\prompt-drift-anchors'
New-Item -ItemType Directory -Force -Path $anchors | Out-Null

function Set-Anchor([string]$name, [string]$text) {
  $path = Join-Path $anchors $name
  [IO.File]::WriteAllText($path, $text.Replace("`r`n", "`n").TrimEnd("`n"))
  return $path
}

$cases = @(
  @{
    id = 'A-读数永远说"一致"（differs 那条守卫必须红）'
    file = 'packages/store/src/prompt-store.ts'
    test = 'packages/store/test/prompt-seed-drift.test.ts'
    good = @'
      verdict: active.sha256 === baselineSha256 ? ('same' as const) : ('differs' as const),
'@
    bad = @'
      verdict: 'same' as const,
'@
  }
  @{
    id = 'A2-同一个注入，端到端那条也要红（两个面各守一次）'
    file = 'packages/store/src/prompt-store.ts'
    test = 'packages/dsh-component/test/prompt-drift-wiring.test.ts'
    good = @'
      verdict: active.sha256 === baselineSha256 ? ('same' as const) : ('differs' as const),
'@
    bad = @'
      verdict: 'same' as const,
'@
  }
  @{
    id = 'B-启动路径不再读漂移（接线守卫 + 端到端必须红）'
    file = 'packages/dsh-component/src/index.ts'
    test = 'packages/dsh-component/test/prompt-drift-wiring.test.ts'
    good = @'
  for (const drift of promptSeedDrift(runtime.db)) {
'@
    bad = @'
  for (const drift of [] as ReturnType<typeof promptSeedDrift>) {
'@
  }
)

$failed = 0
foreach ($case in $cases) {
  Write-Host ''
  Write-Host ("════ 注入 {0} ════" -f $case.id)
  $good = Set-Anchor ("{0}-good.txt" -f $case.id.Substring(0, 1)) $case.good
  $bad = Set-Anchor ("{0}-bad.txt" -f $case.id.Substring(0, 1)) $case.bad
  $file = Join-Path $repo $case.file
  $test = (Join-Path $repo $case.test).Replace('\', '/')
  & pwsh -NoProfile -File (Join-Path $repo 'scripts\rollback-verify.ps1') -File $file -Good $good -Bad $bad -Test $test
  if ($LASTEXITCODE -ne 0) {
    $failed += 1
    Write-Host ("✖ 这条没通过（exit={0}）" -f $LASTEXITCODE)
  }
}

Write-Host ''
Write-Host ("════ 合计：{0} / {1} 条注入验证通过 ════" -f ($cases.Count - $failed), $cases.Count)
if ($failed -gt 0) { exit 1 }
