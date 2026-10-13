<#
.SYNOPSIS
  回退验证：把"好锚点"换成"坏锚点"跑测试（必须红），还原再跑（必须绿）。

.DESCRIPTION
  ## 为什么要有这个脚本（不是为了省事）

  本仓的硬约束要求每个修复都做回退验证。而我在**四次**里做失败了，
  原因**全都是同一个**：锚点里含**反引号**（迁移日志级别时几乎每一处都有
  `` log(`…`) ``），而我把它写在 PowerShell 的**双引号**里 ——
  双引号里 `` ` `` 是**转义符**，于是锚点静默地变成了另一个字符串，
  `Contains()` 返回 false，脚本报"注入没生效"。

  **危险的地方在于它失败的样子**：它看起来像"锚点没找到"这种小问题，
  而不是"你的验证没做"。如果我当时没细看，就会**带着一次没做成的回退验证继续提交**。

  ## 治根的办法：**别在命令行里写锚点**

  这个脚本把两段锚点**从文件里读**（`-Good` / `-Bad` 各指向一个文件）。
  文件内容是逐字节的，**不经过 PowerShell 的字符串解析 ⇒ 反引号陷阱结构性消失**。
  （我试过"改用单引号"—— 那确实能过，但它依赖我**每次都记得**；
  而我已经忘了四次。**规则不如工具**。）

  ## 用法

  ```powershell
  # anchors/good.txt 里放改好之后的原文，anchors/bad.txt 里放注入之后的原文
  pwsh scripts/rollback-verify.ps1 `
    -File  packages/gateway/src/wake-runtime.ts `
    -Good  anchors/good.txt `
    -Bad   anchors/bad.txt `
    -Test  packages/gateway/test/log-level-migration.test.ts
  ```

  输出会给出两个数字（注入后的 pass/fail、还原后的 pass/fail），
  以及**逐字节一致**的确认 —— 这三样就是硬约束要的"给两次数字"。
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$File,
  [Parameter(Mandatory = $true)][string]$Good,
  [Parameter(Mandatory = $true)][string]$Bad,
  [Parameter(Mandatory = $true)][string]$Test
)

$ErrorActionPreference = 'Stop'

function Read-Anchor([string]$path) {
  # 逐字节读、只归一化行尾（CRLF/LF 两种来源都接受）
  (Get-Content -LiteralPath $path -Raw).Replace("`r`n", "`n").TrimEnd("`n")
}

$goodText = Read-Anchor $Good
$badText = Read-Anchor $Bad
$backup = [System.IO.File]::ReadAllText($File)

if ($goodText -eq $badText) {
  Write-Output '✖ 好/坏锚点一模一样 —— 那这次注入什么都不会改变，验证没有意义'
  exit 2
}

# 归一化之后再比（文件是 LF，脚本里拼出来的可能是 CRLF）
$haystack = $backup.Replace("`r`n", "`n")
if (-not $haystack.Contains($goodText)) {
  Write-Output '✖ 好锚点没命中 —— 先确认锚点文件的内容与源码逐字一致（含缩进）'
  Write-Output "  锚点首行: $($goodText.Split("`n")[0])"
  exit 2
}

function Run-Test([string]$label) {
  $out = & node --test $Test 2>&1 | Out-String
  $pass = ([regex]::Match($out, '(?m)^ℹ pass (\d+)')).Groups[1].Value
  $fail = ([regex]::Match($out, '(?m)^ℹ fail (\d+)')).Groups[1].Value
  # ★ **必须用 Write-Host 而不是 Write-Output**：这个函数的返回值会被
  #   `$x = Run-Test …` 捕获 —— 用 Write-Output 的话，这一行**也进了返回值**，
  #   于是屏幕上什么都没有、而 `[int]$fail` 对一个数组做转换。
  #   （第一次跑这个脚本就是这么失败的；它自己把这个问题暴露了出来。）
  Write-Host "  ${label}: pass=$pass fail=$fail"
  return [int]$fail
}

Write-Output "文件: $File"
Write-Output "测试: $Test"

# ① 注入（好 → 坏）⇒ 必须红
[System.IO.File]::WriteAllText($File, $backup.Replace($goodText, $badText).Replace("`r`n", "`n"))
$failAfterInject = Run-Test '注入后'

# ② 还原 ⇒ 必须绿，且与备份逐字节一致
[System.IO.File]::WriteAllText($File, $backup)
$failAfterRestore = Run-Test '还原后'
$identical = [System.IO.File]::ReadAllText($File) -eq $backup
Write-Output "  还原后与备份逐字节一致: $identical"

if ($failAfterInject -le 0) {
  Write-Output '✖ 注入之后**没有测试变红** ⇒ 这条守卫其实没在守它（回退验证失败）'
  exit 1
}
if ($failAfterRestore -ne 0 -or -not $identical) {
  Write-Output '✖ 还原之后没回到全绿 / 文件没还原干净'
  exit 1
}
Write-Output '✓ 回退验证通过（注入⇒红，还原⇒绿，逐字节一致）'
