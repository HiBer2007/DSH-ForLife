# 系统提示词基线（§78.14）的**注入验证**。
#
# 四条，每条打一个不同的面：
#   A 往 P1 里塞回一个中文字符    ⇒ "一处中文都不许有"必须红
#   B 把 {{language}} 从 P1 里删掉 ⇒ "变量一字不许少"必须红
#   C 把回答语言变量改成 English   ⇒ ★★ "回答语言仍然是中文"必须红（最危险的那种误解）
#   D 改掉主动性里点名的工具名     ⇒ "工具名不许被翻译掉"必须红
#
# 用法：pwsh -File scripts/prompt-baseline-injections.ps1
# 报告：FIX_PLAN.md §78.14
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$anchors = Join-Path $repo '.runtime\prompt-baseline-anchors'
New-Item -ItemType Directory -Force -Path $anchors | Out-Null

function Set-Anchor([string]$name, [string]$text) {
  $path = Join-Path $anchors $name
  [IO.File]::WriteAllText($path, $text.TrimEnd("`n"))
  return $path
}

$guard = 'packages/contracts/test/prompt-baseline-english.test.ts'

$cases = @(
  @{
    id = 'A-P1 里塞回一个中文字符（不许有中文 必须红）'
    good = 'Answer in {{language}}.'
    bad  = '用{{language}}回答。'
  }
  @{
    id = 'B-把 {{language}} 删掉（变量一字不许少 必须红）'
    good = 'Answer in {{language}}.'
    bad  = 'Answer in the language the other side uses.'
  }
  @{
    id = 'C-把回答语言变量改成 English（★ 最危险的那种误解 必须红）'
    good = '      "v": "中文",'
    bad  = '      "v": "English",'
  }
  @{
    id = 'D-改掉主动性里点名的工具名（工具名不许被翻译 必须红）'
    good = '`qq_reply`'
    bad  = '`reply_tool`'
  }
)

$failed = 0
foreach ($case in $cases) {
  Write-Host ''
  Write-Host ("════ 注入 {0} ════" -f $case.id)
  $good = Set-Anchor ("{0}-good.txt" -f $case.id.Substring(0, 1)) $case.good
  $bad = Set-Anchor ("{0}-bad.txt" -f $case.id.Substring(0, 1)) $case.bad
  & pwsh -NoProfile -File (Join-Path $repo 'scripts\rollback-verify.ps1') `
    -File 'packages/contracts/plan-baseline.json' -Good $good -Bad $bad -Test $guard
  if ($LASTEXITCODE -ne 0) {
    $failed += 1
    Write-Host ("✖ 这条没通过（exit={0}）" -f $LASTEXITCODE)
  }
}

Write-Host ''
Write-Host ("════ 合计：{0} / {1} 条注入验证通过 ════" -f ($cases.Count - $failed), $cases.Count)
if ($failed -gt 0) { exit 1 }
