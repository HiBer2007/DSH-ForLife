# 死循环监控抽取后的**注入验证**（§11 硬约束：注入⇒红，还原⇒绿，两次数字）
#
# 用法：pwsh -File scripts/loop-guard-injections.ps1
# 结果（2026-10-11 实跑）：7 / 7 条通过（每条都是"注入⇒红，还原⇒绿，逐字节一致"）
# 报告：FIX_PLAN.md §77
#
# ★ 为什么锚点写在**文件**里而不是命令行里：
#   这些锚点含**反引号**（模板字符串），而 PowerShell 双引号里 ` 是转义符 ——
#   本仓为此栽过四次（见 scripts/rollback-verify.ps1 的说明）。
#   写成 @' ... '@（单引号 here-string）⇒ 逐字面，不经过转义。
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
# ★ 锚点放 .runtime 下（gitignore 里挡着）—— 它们是**一次性的**，但脚本本身留在 scripts/ 里可复跑。
$anchors = Join-Path $repo '.runtime\lg-anchors'
New-Item -ItemType Directory -Force -Path $anchors | Out-Null

function Set-Anchor([string]$name, [string]$text) {
  $path = Join-Path $anchors $name
  [IO.File]::WriteAllText($path, $text.Replace("`r`n", "`n").TrimEnd("`n"))
  return $path
}

$aInstall = 'packages/loop-guard/src/install.ts'
$aTool = 'packages/loop-guard/src/tool.ts'
$aIndex = 'packages/dsh-component/src/index.ts'
$tPackage = 'packages/loop-guard/test/install.test.ts'
$tTool = 'packages/loop-guard/test/tool.test.ts'
$tE2e = 'packages/dsh-component/test/loop-guard-e2e.test.ts'
$tDelegation = 'packages/dsh-component/test/loop-guard-delegation.test.ts'

$cases = @(
  @{
    id = 'A-工具腿不再中止（复现旧缺陷：只记日志）'
    file = $aInstall
    test = $tE2e
    good = @'
        if (cancelOf(agent, `工具调用死循环：${verdict.reason}`)) {
          options.always(`**检测到工具调用死循环，已中止本轮**：${verdict.reason}`)
        }
'@
    bad = @'
        options.log(`工具调用死循环（注入：故意不中止）：${verdict.reason}`)
'@
  }
  @{
    id = 'B-工具腿挂在永远不会来的事件上（复现"不在执行路径上"）'
    file = $aInstall
    test = $tE2e
    good = @'
    const dispose = contextOn.on('session/event', (...args: unknown[]) => {
'@
    bad = @'
    const dispose = contextOn.on('session/event-注入关掉', (...args: unknown[]) => {
'@
  }
  @{
    id = 'C-去掉分桶（复现"两个会话互相冲淡"）'
    file = $aTool
    test = $tTool
    good = @'
    feed: (key, event) => {
      const e = event as ToolCallEventLike | null
'@
    bad = @'
    feed: (_key, event) => {
      const key = '同一个桶'
      const e = event as ToolCallEventLike | null
'@
  }
  @{
    id = 'D-去掉重复挂载去重（一次输出会被喂两遍）'
    file = $aInstall
    test = $tPackage
    good = @'
  if (ctx !== null && typeof ctx === 'object' && mountedContexts.has(ctx)) {
'@
    bad = @'
  if (ctx !== null && typeof ctx === 'object' && false && mountedContexts.has(ctx)) {
'@
  }
  @{
    id = 'E-"判出来却下不了手"变静默'
    file = $aInstall
    test = $tPackage
    good = @'
          options.always(
            `⚠️ 工具调用死循环已判定，但**这个会话还没有挂上 agent**（无法中止本轮）：${key === '' ? '(无会话 id)' : key}`,
          )
'@
    bad = @'
          // 注入：故意静默（判出来了却下不了手，谁也不告诉）
'@
  }
  @{
    id = 'F-旧接线复活（工具腿被塞回记忆插件里）'
    file = $aIndex
    test = $tDelegation
    good = @'
  const contextOn = ctx as unknown as { on?: (event: string, handler: (...args: unknown[]) => void) => (() => void) | undefined }
'@
    bad = @'
  const toolLoopGuard = null
  const contextOn = ctx as unknown as { on?: (event: string, handler: (...args: unknown[]) => void) => (() => void) | undefined }
'@
  }
  @{
    id = 'G-环境开关失效（关不掉了）'
    file = $aInstall
    test = $tPackage
    good = @'
  if (OFF_VALUES.has(flag)) {
'@
    bad = @'
  if (false && OFF_VALUES.has(flag)) {
'@
  }
)

$failed = 0
foreach ($case in $cases) {
  Write-Host ''
  Write-Host ("════ 注入 {0} ════" -f $case.id)
  $good = Set-Anchor ("{0}-good.txt" -f $case.id.Substring(0, 1)) $case.good
  $bad = Set-Anchor ("{0}-bad.txt" -f $case.id.Substring(0, 1)) $case.bad
  $file = (Join-Path $repo $case.file)
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
