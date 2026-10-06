# 起 forlife 主管理后台 + QQ 链路（本机联调用）。
#
# 为什么写成脚本文件而不是命令行内联：Start-Process 的多层引号会把
# `$env:XXX=...` 这类赋值搞坏（我踩过：DSH 因此回落到宿主 ~/.dsh）。脚本文件没有这个问题。
#
# 绑 0.0.0.0 是**故意的**：要能用手机验收。代价是同网段都能打开登录页，
# 所以口令是唯一门槛 —— 服务端每次启动都会提醒这一点。
$ErrorActionPreference = 'Stop'
$root = 'D:\DSH-ForLife'

$env:FORLIFE_DB = "$root\.runtime\dsh\forlife\db\forlife.sqlite"
$env:FORLIFE_ADMIN_HOST = '0.0.0.0'
$env:FORLIFE_ADMIN_PORT = '8081'

# ── QQ 链路（OneBot 反向 WS：NapCat 主动连过来）─────────────────────────────
$env:FORLIFE_ONEBOT = '1'
$env:FORLIFE_ONEBOT_PORT = '3010'
# 必须绑 0.0.0.0：NapCat 在容器里，从外面连进来；accessToken 是唯一门槛
$env:FORLIFE_ONEBOT_HOST = '0.0.0.0'
$env:FORLIFE_ONEBOT_PATH = '/'
if (Test-Path "$root\.runtime\onebot-token.txt") {
  $env:FORLIFE_ONEBOT_TOKEN = (Get-Content "$root\.runtime\onebot-token.txt" -Raw).Trim()
}

# 驱动：联调阶段用 fake（回复由脚本生成，日志会大声标注）；生产改 headless
$env:FORLIFE_DRIVER = if ($env:FORLIFE_DRIVER) { $env:FORLIFE_DRIVER } else { 'fake' }
# 联调期关掉噪音过滤：确保测试消息一定产生轮次，便于观察链路
$env:FORLIFE_NOISE = if ($env:FORLIFE_NOISE) { $env:FORLIFE_NOISE } else { 'off' }

Set-Location $root
Write-Output "FORLIFE_DB=$env:FORLIFE_DB"
Write-Output "监听=$env:FORLIFE_ADMIN_HOST`:$env:FORLIFE_ADMIN_PORT"
Write-Output "OneBot=$env:FORLIFE_ONEBOT_HOST`:$env:FORLIFE_ONEBOT_PORT  驱动=$env:FORLIFE_DRIVER"
node packages/gateway/src/server.ts 2>&1 | Out-File -Encoding utf8 "$root\.runtime\admin.log"
