# §57 待办⑥（存储指标 + 慢查询）的**注入验证**。
#
#   A WAL 告警不再做边沿检测（每轮都写）⇒ ★ "只写一条" 那条必须红
#   B 读失败不再接住（tick 直接抛）      ⇒ ★ "不许反杀循环" 那条必须红
#   C 不再记基线                        ⇒ ★ "基线只记一次" 那条必须红
#   D 生产不再传 slowQueryLog           ⇒ 源码守卫必须红
#
# 用法：pwsh -File scripts/storage-metrics-injections.ps1
# 报告：FIX_PLAN.md §78.22
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$anchors = Join-Path $repo '.runtime\storage-metrics-anchors'
New-Item -ItemType Directory -Force -Path $anchors | Out-Null

function Set-Anchor([string]$name, [string]$text) {
  $path = Join-Path $anchors $name
  [IO.File]::WriteAllText($path, $text.TrimEnd("`n"))
  return $path
}

$cases = @(
  @{
    id = 'A-WAL 告警不做边沿检测（每轮都写）'
    file = 'packages/gateway/src/admin/storage-metrics.ts'
    test = 'packages/gateway/test/storage-metrics.test.ts'
    good = '      if (!walWarned) {'
    bad  = '      if (true) {'
  }
  @{
    id = 'B-读失败不再接住（tick 直接抛）'
    file = 'packages/gateway/src/admin/storage-metrics.ts'
    test = 'packages/gateway/test/storage-metrics.test.ts'
    # ★ 第一版这条注入写错了：把 `readOnce()` 换成直接读 —— 那**还在 try 里面**，
    #   保护没被拆掉 ⇒ 测试当然不会红（"注入没红"本身就是一次有价值的自查）。
    #   正确的注入是**把 catch 里的兜底改成重新抛**。
    good = '      return last ?? EMPTY_METRICS'
    bad  = '      throw error'
  }
  @{
    id = 'C-不再记基线'
    file = 'packages/gateway/src/admin/storage-metrics.ts'
    test = 'packages/gateway/test/storage-metrics.test.ts'
    good = "      emit('note', ``[`${at}] 存储基线：`${describeStorageMetrics(metrics)}``)"
    bad  = "      baseline = metrics.dbBytes"
  }
  @{
    id = 'E-剩余空间不再做边沿检测（★ "只写一条" 那条必须红）'
    file = 'packages/gateway/src/admin/storage-metrics.ts'
    test = 'packages/gateway/test/storage-metrics.test.ts'
    good = '      if (next !== spaceState) {'
    bad  = '      if (true) {'
  }
  @{
    id = 'F-剩余空间的警戒线在代码里写死（不再读契约键 ⇒ 源码守卫必须红）'
    file = 'packages/gateway/src/server.ts'
    test = 'packages/gateway/test/storage-metrics.test.ts'
    good = "        thresholds: { freeWarnBytes: defaultFor<number>('tiering.warnFreeBytes') },"
    bad  = '        thresholds: { freeWarnBytes: 5368709120 },'
  }
  @{
    id = 'D-生产不再传 slowQueryLog（源码守卫必须红）'
    file = 'packages/gateway/src/server.ts'
    test = 'packages/gateway/test/slow-query.test.ts'
    good = '        slowQueryLog: storageLog,'
    bad  = '        // slowQueryLog: storageLog,'
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
