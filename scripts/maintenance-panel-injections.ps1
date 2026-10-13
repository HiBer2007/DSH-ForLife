# §76.5④「面板手动入口」的**注入验证**。
#
# 三条（都打"接线"这个面）：
#   A 把页面里的 POST 调用删掉        ⇒ 面板接线守卫必须红
#   B 让"跑一轮"也发 {only:'fragments'} ⇒ ★ "与自动同一条路径"那条守卫必须红
#   C 后端不再把 scope 传下去          ⇒ 作用域行为测试（+接线守卫）必须红
#
# ★ 另有一条**手工**做的（D：往 .vue 里塞一个类型错误 ⇒ `vue-tsc` 必须非 0），
#   它不走 `node --test`，所以不在这个脚本里（结论记在 FIX_PLAN §78.18）。
#
# 用法：pwsh -File scripts/maintenance-panel-injections.ps1
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$anchors = Join-Path $repo '.runtime\maintenance-panel-anchors'
New-Item -ItemType Directory -Force -Path $anchors | Out-Null

function Set-Anchor([string]$name, [string]$text) {
  $path = Join-Path $anchors $name
  [IO.File]::WriteAllText($path, $text.TrimEnd("`n"))
  return $path
}

$cases = @(
  @{
    id = 'A-页面不再调 POST /maintenance/run（面板接线守卫必须红）'
    file = 'packages/admin-ui/src/views/MaintenanceView.vue'
    test = 'packages/admin-ui/test/maintenance-wiring.test.ts'
    good = "    const response = await api.post<MaintenanceRunResponse>('/maintenance/run', body)"
    bad  = "    const response = { result: { moved: 0, skipped: 0, failed: 0, failures: [] } }"
  }
  @{
    id = 'B-"跑一轮"也发 only=fragments（★ 与自动同一条路径 那条守卫必须红）'
    file = 'packages/admin-ui/src/views/MaintenanceView.vue'
    test = 'packages/admin-ui/test/maintenance-wiring.test.ts'
    good = "    const body = scope === 'fragments' ? { only: 'fragments' } : {}"
    bad  = "    const body = { only: 'fragments' }"
  }
  @{
    id = 'C-后端不再把 scope 传给 tick()（作用域行为测试必须红）'
    file = 'packages/gateway/src/admin/api.ts'
    test = 'packages/gateway/test/maintenance-run-scope.test.ts'
    good = '          const result = await m.tick(scope)'
    bad  = '          const result = await m.tick()'
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
