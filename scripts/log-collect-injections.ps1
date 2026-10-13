# §76.5⑤ 日志采集（§57 待办①②③）的**注入验证**。
#
# 四条，每条打一个不同的面：
#   A 采集来的行**不脱敏**了            ⇒ 源码级守卫必须红（密钥会进日志库）
#   B 端点**跳过令牌检查**              ⇒ 行为测试（401）+ 源码守卫都必须红
#   C 模块名**不再洗**                  ⇒ 归一测试 + 行为测试必须红
#   D 采集窗口改回"发最新的"（真机踩过的丢数据）⇒ 不许漏条 那条测试必须红
#
# 用法：pwsh -File scripts/log-collect-injections.ps1
# 报告：FIX_PLAN.md §78.19
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$anchors = Join-Path $repo '.runtime\log-collect-anchors'
New-Item -ItemType Directory -Force -Path $anchors | Out-Null

function Set-Anchor([string]$name, [string]$text) {
  $path = Join-Path $anchors $name
  [IO.File]::WriteAllText($path, $text.TrimEnd("`n"))
  return $path
}

$cases = @(
  @{
    id = 'A-采集来的行不脱敏（源码级守卫必须红）'
    file = 'packages/gateway/src/server.ts'
    test = 'packages/gateway/test/log-ingest.test.ts'
    good = '            const safe = { ...record, text: redact(record.text) }'
    bad  = '            const safe = { ...record }'
  }
  @{
    id = 'B-端点跳过令牌检查（401 与源码守卫都必须红）'
    file = 'packages/gateway/src/admin/api.ts'
    test = 'packages/gateway/test/log-ingest.test.ts'
    good = '        if (presented === '''' || !safeEqualString(presented, ingest.token)) {'
    bad  = '        if (false) {'
  }
  @{
    id = 'C-模块名不再洗（归一测试必须红）'
    file = 'packages/gateway/src/admin/log-ingest.ts'
    test = 'packages/gateway/test/log-ingest.test.ts'
    good = '  const module = sanitizeModule(row[''module''])'
    bad  = '  const module = typeof row[''module''] === ''string'' ? row[''module''] : undefined'
  }
  @{
    id = 'D-采集窗口改回"发最新的"（★ 不许漏条 那条必须红）'
    file = 'scripts/log-collect-lib.mjs'
    test = 'tests/log-collect.test.ts'
    good = '  const window = entries.slice(0, Math.max(0, max))'
    bad  = '  const window = entries.slice(-Math.max(0, max))'
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
