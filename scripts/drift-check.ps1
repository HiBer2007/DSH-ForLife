# 部署树漂移检查 —— **重建之前必须跑一次**。
#
# ## 为什么需要它
#
# `/opt/forlife` 是**拷贝**（不是 git 仓库），而**重建镜像就是从它构建**的。
# 于是它一旦落后于仓库，**构建出来的镜像就是错的 —— 而且没人会发现**：
# 容器 healthy、测试全绿（测试跑的是仓库）、面板正常，**只有行为悄悄不同**。
#
# 2026-10-11 实测抓到过一次：`packages/contracts/src/deviations.ts` 漂了
# （改它那句假话是在 §45 同步**之后**）⇒ 若不发现，下次重建会把**旧文案**打进镜像。
#
# ## 用法
#
#     pwsh -File scripts\drift-check.ps1
#
# 退出码 0 = 完全一致；1 = 有漂移（并列出是哪几个文件）。
#
# ## ⚠️ 它**查不出"多出来的文件"**
#
# 比对只遍历**仓库受版本控制的清单**，所以部署树里多一个清单外的文件**不会报**。
# （2026-10-11 我自己踩到：测试时写错了路径 ⇒ 在部署树里凭空造了一个文件，检查却报"一致"。）
# 代价可接受（多出来的文件不会被 `cp -a` 删掉、也不影响构建产物），但**要知道**。
[CmdletBinding()]
param(
  [string]$VmHost = '192.168.1.121',
  [string]$VmUser = 'hiber2007',
  [string]$DeployTree = '/opt/forlife',
  # ★ 默认相对**仓库根**（本脚本在 scripts/ 下）—— 密钥不进仓库，只在本机 ~/.runtime
  [string]$KeyPath
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo

if (-not $KeyPath) { $KeyPath = Join-Path $repo '.runtime\pve_deploy_key' }
if (-not (Test-Path $KeyPath)) { throw "找不到部署密钥：$KeyPath" }
$key = (Resolve-Path $KeyPath).Path

# ── ① 本地：受版本控制、且会进镜像的那些文件 ────────────────────────────────
Write-Host '  ① 生成本地清单…'
$files = git ls-files | Where-Object {
  $_ -match '^(packages/|deploy/|scripts/|tests/)' -or $_ -match '^[^/]+\.(json|md|ts|mjs|js)$'
}
$lines = foreach ($f in $files) {
  if (Test-Path $f) {
    $h = (Get-FileHash -Algorithm SHA1 -Path $f).Hash.ToLower()
    "$h  $f"
  }
}
$manifest = Join-Path $env:TEMP 'forlife-repo-manifest.txt'
# ★ 必须写**无 BOM 的 LF**：远端用 `read` 逐行读 ——
#   带 BOM 会让第一行的哈希多出 \ufeff，带 CR 会让路径尾部多个 \r，
#   两者都会让**所有**文件被误判成"缺失"（我第一次就栽在这上面，515 条全红）。
$text = ($lines -join "`n") + "`n"
[System.IO.File]::WriteAllText($manifest, $text, (New-Object System.Text.UTF8Encoding($false)))
Write-Host "     清单 $($lines.Count) 条"

# ── ② 传上去 ────────────────────────────────────────────────────────────────
& scp -i $key -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o BatchMode=yes `
  $manifest "${VmUser}@${VmHost}:/tmp/forlife-repo-manifest.txt" 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) { throw "scp 失败（exit $LASTEXITCODE）" }

# ── ③ 远端逐文件比对 ────────────────────────────────────────────────────────
Write-Host '  ③ 逐文件比对…'
# ★ 远端那段写成**文件**再传：PowerShell 没有 bash 的 `<<<` here-string，
#   而把脚本塞进 ssh 的多层引号里已经让这个项目栽过好几次（见 FIX_PLAN §48 末尾）。
$remoteScript = @'
# 用法：bash /tmp/forlife-drift.sh /opt/forlife
cd "$1" || exit 2
mf=/tmp/forlife-repo-manifest.txt
tr -d "\r" < "$mf" | sed -e "1s/^\xEF\xBB\xBF//" > /tmp/forlife-mf.txt
ok=0; bad=0; miss=0
: > /tmp/forlife-drift.txt
while read -r want path; do
  [ -z "$want" ] && continue
  if [ ! -f "$path" ]; then echo "缺失  $path" >> /tmp/forlife-drift.txt; miss=$((miss+1))
  else
    got=$(sha1sum "$path" | cut -d" " -f1)
    if [ "$got" != "$want" ]; then echo "不同  $path" >> /tmp/forlife-drift.txt; bad=$((bad+1)); else ok=$((ok+1)); fi
  fi
done < /tmp/forlife-mf.txt
echo "OK=$ok BAD=$bad MISS=$miss"
echo "--- DRIFT ---"
cat /tmp/forlife-drift.txt
'@
$remoteFile = Join-Path $env:TEMP 'forlife-drift.sh'
[System.IO.File]::WriteAllText($remoteFile, ($remoteScript -replace "`r`n", "`n"), (New-Object System.Text.UTF8Encoding($false)))
& scp -i $key -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o BatchMode=yes `
  $remoteFile "${VmUser}@${VmHost}:/tmp/forlife-drift.sh" 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) { throw "scp（比对脚本）失败（exit $LASTEXITCODE）" }

$out = & ssh -i $key -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o BatchMode=yes `
  -o ConnectTimeout=25 "${VmUser}@${VmHost}" "bash /tmp/forlife-drift.sh '$DeployTree'" 2>&1
$out = @($out | Where-Object { $_ -notmatch '^Warning: Permanently added' })

$summary = $out | Where-Object { $_ -match '^OK=' } | Select-Object -First 1
if (-not $summary) { $out | ForEach-Object { "     $_" }; throw '远端没有返回统计行' }

$bad = [int]([regex]::Match($summary, 'BAD=(\d+)').Groups[1].Value)
$miss = [int]([regex]::Match($summary, 'MISS=(\d+)').Groups[1].Value)
Write-Host "     $summary"

# ★ 不能用 `Select-Object -SkipWhile` —— 那是 LINQ，PowerShell 没有这个参数。
#   （第一次这么写，脚本在**拿到正确结果之后**才崩 ⇒ 退出码成了 1，假红。）
$drift = @()
$marker = [Array]::IndexOf([object[]]$out, '--- DRIFT ---')
if ($marker -ge 0 -and $marker + 1 -lt $out.Count) { $drift = $out[($marker + 1)..($out.Count - 1)] }

if ($bad -eq 0 -and $miss -eq 0) {
  Write-Host '  ✅ 部署树与仓库完全一致 —— 可以安全重建' -ForegroundColor Green
  exit 0
}
Write-Host '  ❌ 有漂移！**先同步再重建**，否则镜像里是旧代码：' -ForegroundColor Red
$drift | Where-Object { $_.Trim() -ne '' } | ForEach-Object { "     $_" }
Write-Host ''
Write-Host '  同步办法（合并式；★ 不带 --delete ⇒ 保住 deploy/.env 与 docker-compose.override.yml）：'
Write-Host '     tar -czf /tmp/sync.tgz --exclude=node_modules --exclude=.git --exclude=.runtime --exclude=.forlife .'
Write-Host '     # scp 上去 → tar -xzf 到临时目录 → cp -a 到 /opt/forlife'
Write-Host '  ★ 同步后核对：deploy/.env 的 md5 与权限（应为 600）必须没变。'
exit 1
