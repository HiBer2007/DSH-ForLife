# §57 待办⑤（存活判定入日志）的**注入验证**。
#
#   A 生产路径不再传 `logger`        ⇒ 源码守卫必须红（"只造 logger 不传"是本仓栽过 20+ 次的形状）
#   B 假活那条降成 `info`            ⇒ ★ `fault` 那条测试必须红
#   C `emit` 即使有 logger 也退回 log ⇒ 模块/等级那两条测试必须红
#
# 用法：pwsh -File scripts/liveness-logging-injections.ps1
# 报告：FIX_PLAN.md §78.21
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$anchors = Join-Path $repo '.runtime\liveness-logging-anchors'
New-Item -ItemType Directory -Force -Path $anchors | Out-Null

function Set-Anchor([string]$name, [string]$text) {
  $path = Join-Path $anchors $name
  [IO.File]::WriteAllText($path, $text.TrimEnd("`n"))
  return $path
}

$cases = @(
  @{
    id = 'A-生产路径不再传 logger（源码守卫必须红）'
    file = 'packages/gateway/src/wake-runtime.ts'
    test = 'packages/gateway/test/liveness-logging.test.ts'
    good = '    logger: livenessLog,'
    bad  = '    // logger: livenessLog,'
  }
  @{
    id = 'B-假活那条降成 info（fault 那条必须红）'
    file = 'packages/gateway/src/wake-liveness.ts'
    test = 'packages/gateway/test/liveness-logging.test.ts'
    good = "    emit('fault', ``★ QQ 静默离线（`${verdict.evidence}）：`${verdict.reason}`${silence}``)"
    bad  = "    emit('info', ``★ QQ 静默离线（`${verdict.evidence}）：`${verdict.reason}`${silence}``)"
  }
  @{
    id = 'C-emit 即使有 logger 也退回 log（模块/等级必须红）'
    file = 'packages/gateway/src/wake-liveness.ts'
    test = 'packages/gateway/test/liveness-logging.test.ts'
    good = '    const target = options.logger?.[level]'
    bad  = '    const target = undefined'
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
