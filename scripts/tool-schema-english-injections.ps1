# 工具文案英文化（§78）的**注入验证** —— 守的是"棘轮真的会响"。
#
# 两条：
#   A 把一句英文描述改回中文 ⇒ 棘轮必须红（mention 的上限是 0）
#   B 让 port 构建器**返回空数组** ⇒ "工具数量"断言必须红
#     ★ 这一条守的是**假绿**：构建器返回空时，中文计数会变成 0，
#       棘轮会"因为没东西可数而通过" —— 那正是本仓反复栽的那个坑。
#
# 用法：pwsh -File scripts/tool-schema-english-injections.ps1
# 报告：FIX_PLAN.md §78
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$anchors = Join-Path $repo '.runtime\schema-en-anchors'
New-Item -ItemType Directory -Force -Path $anchors | Out-Null

function Set-Anchor([string]$name, [string]$text) {
  $path = Join-Path $anchors $name
  [IO.File]::WriteAllText($path, $text.Replace("`r`n", "`n").TrimEnd("`n"))
  return $path
}

$guard = 'packages/dsh-component/test/tool-schema-english.test.ts'

$cases = @(
  @{
    id = 'A-英文描述退回中文（棘轮必须响）'
    file = 'packages/dsh-component/src/mention-tools.ts'
    test = $guard
    good = "description: 'Text to send.'"
    bad = "description: '要发的内容。'"
  }
  @{
    id = 'B-构建器返回空数组（"数量"断言必须响，否则计数是假绿）'
    file = $guard
    test = $guard
    good = "const PORT_OPTIONS = { caddyAdminUrl: 'http://127.0.0.1:2019', publicHost: 'example.test' }"
    bad = 'const PORT_OPTIONS = {}'
  }
  @{
    id = 'C-qq 少 spread 一个子构建器（数量 + 认领数两条断言都要响）'
    file = 'packages/dsh-component/src/qq-tools.ts'
    test = $guard
    good = '...buildStickerTools(defineTool, runtime), ...buildMentionTools(defineTool, runtime)]'
    bad = '...buildStickerTools(defineTool, runtime)]'
  }
  @{
    id = 'D-clock 的描述退回中文（第 2 批收官的模块，上限 0 必须响）'
    file = 'packages/dsh-component/src/clock-tools.ts'
    test = $guard
    good = "description: 'Whether to use a 24-hour clock.'"
    bad = "description: '是否 24 小时制。'"
  }
  @{
    id = 'E-feed 的描述退回中文（第 3 批收官的模块，上限 0 必须响）'
    file = 'packages/dsh-component/src/feed-tools.ts'
    test = $guard
    good = "description: 'Content of this section.'"
    bad = "description: '这一段的内容。'"
  }
  @{
    id = 'F-qq 的描述退回中文（第 4 批收官的模块，★ 九个模块全 0 之后仍必须响）'
    file = 'packages/dsh-component/src/qq-tools.ts'
    test = $guard
    good = "description: 'Text to send.' }"
    bad = "description: '要发送的文本。' }"
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
