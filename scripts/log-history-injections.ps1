# §57 待办④（面板翻历史）的**注入验证**。
#
#   A 页面不再发 `history: 1`            ⇒ 面板接线守卫必须红
#   B `source=buffer` 与 `store` 显示成一样 ⇒ ★ "如实分辨"那条守卫必须红
#   C 后端历史那条路改回读**缓冲**        ⇒ 服务端测试（source=store）+ 源码守卫必须红
#   D 落盘里的模块不再并进下拉            ⇒ 服务端测试（modules 含 napcat）必须红
#
# 用法：pwsh -File scripts/log-history-injections.ps1
# 报告：FIX_PLAN.md §78.20
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$anchors = Join-Path $repo '.runtime\log-history-anchors'
New-Item -ItemType Directory -Force -Path $anchors | Out-Null

function Set-Anchor([string]$name, [string]$text) {
  $path = Join-Path $anchors $name
  [IO.File]::WriteAllText($path, $text.TrimEnd("`n"))
  return $path
}

$cases = @(
  @{
    id = 'A-页面不再发 history=1（面板接线守卫必须红）'
    file = 'packages/admin-ui/src/views/LogsView.vue'
    test = 'packages/admin-ui/test/logs-history-wiring.test.ts'
    good = '      history: 1,'
    bad  = '      history: 0,'
  }
  @{
    id = 'B-source=buffer 与 store 显示成一样（如实分辨 那条必须红）'
    file = 'packages/admin-ui/src/views/LogsView.vue'
    test = 'packages/admin-ui/test/logs-history-wiring.test.ts'
    good = @'
          <template v-else-if="historySource === 'buffer'">
'@
    bad = @'
          <template v-else-if="false">
'@
  }
  @{
    id = 'C-历史那条路改回读缓冲（服务端测试 + 源码守卫必须红）'
    file = 'packages/gateway/src/admin/api.ts'
    test = 'packages/gateway/test/log-history.test.ts'
    good = '          const lines = source === ''store'' ? store!.read(filter) : (buffer?.query(filter) ?? [])'
    bad  = '          const lines = buffer?.query(filter) ?? []'
  }
  @{
    id = 'D-落盘里的模块不再并进下拉（重启后选不到 napcat）'
    file = 'packages/gateway/src/admin/api.ts'
    test = 'packages/gateway/test/log-history.test.ts'
    good = '          ? [...new Set([...(buffer?.modules() ?? []), ...(store?.modules() ?? [])])].sort()'
    bad  = '          ? (buffer?.modules() ?? [])'
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
