# DSH-ForLife · 开发环境就位（幂等，可重复跑）
#
# 为什么需要它：本组件要在**真实 DSH** 里加载验证，而 DSH 的包由宿主的全局安装提供。
# 我们用**仓库根的 node_modules 里一个 junction** 让 Node 解析向上走到宿主包，
# 这样不需要复制任何 DSH 文件，也不需要联网安装（离线可用）。
#
# 注意：绝不触碰宿主 ~/.dsh —— DSH_HOME 一律指向仓库内 .runtime\dsh。

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot

# 1) 定位宿主的 DSH 安装
$dshRoot = Join-Path $env:APPDATA 'npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai'
if (-not (Test-Path (Join-Path $dshRoot 'dsh-base\package.json'))) {
  Write-Error "找不到宿主 DSH 的包目录：$dshRoot（请先 npm i -g @deepseek-ai/dsh）"
}

# 2) 仓库根 junction（一处覆盖所有 profile 与包）
$link = Join-Path $repo 'node_modules\@deepseek-ai'
if (Test-Path $link) {
  Write-Host "已存在：$link"
} else {
  New-Item -ItemType Directory -Force (Split-Path -Parent $link) | Out-Null
  New-Item -ItemType Junction -Path $link -Target $dshRoot | Out-Null
  Write-Host "已创建 junction：$link -> $dshRoot"
}

# 3) 工作区链接
Push-Location $repo
try { pnpm install --offline } finally { Pop-Location }

# 4) DSH_HOME 隔离到仓库内，并让 DSH 找到仓库里的 profile（junction，不复制文件）
$dshHome = Join-Path $repo '.runtime\dsh'
$profilesDir = Join-Path $dshHome 'profiles'
New-Item -ItemType Directory -Force $profilesDir | Out-Null
foreach ($name in @('forlife', 'forlife-headless')) {
  $target = Join-Path $repo "profiles\$name"
  if (-not (Test-Path $target)) { continue }
  $plink = Join-Path $profilesDir $name
  if (Test-Path $plink) { Write-Host "已存在：$plink" }
  else { New-Item -ItemType Junction -Path $plink -Target $target | Out-Null; Write-Host "已创建 profile junction：$plink" }
}

Write-Host ''
Write-Host '就绪。接下来：'
Write-Host '  $env:DSH_HOME = "D:\DSH-ForLife\.runtime\dsh"'
Write-Host '  node scripts/doctor.ts'
Write-Host '  dsh --profile forlife --dump-config'
Write-Host '  dsh --profile forlife-headless "你好"    # 真实加载验证（需要模型凭据才能真的回答）'
