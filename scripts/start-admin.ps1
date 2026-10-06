# 起 forlife 主管理后台（本机开发 / 局域网验收用）。
#
# 为什么写成脚本文件而不是命令行内联：Start-Process 的多层引号会把
# `$env:XXX=...` 这类赋值搞坏（我踩过：DSH 因此回落到宿主 ~/.dsh）。脚本文件没有这个问题。
#
# 绑 0.0.0.0 是**故意的**：要能用手机验收。代价是同网段都能打开登录页，
# 所以口令是唯一门槛 —— 服务端每次启动都会提醒这一点。
$env:FORLIFE_DB = 'D:\DSH-ForLife\.runtime\dsh\forlife\db\forlife.sqlite'
$env:FORLIFE_ADMIN_HOST = '0.0.0.0'
$env:FORLIFE_ADMIN_PORT = '8081'
Set-Location 'D:\DSH-ForLife'
Write-Output "FORLIFE_DB=$env:FORLIFE_DB"
Write-Output "监听=$env:FORLIFE_ADMIN_HOST`:$env:FORLIFE_ADMIN_PORT"
node packages/gateway/src/server.ts 2>&1 | Out-File -Encoding utf8 'D:\DSH-ForLife\.runtime\admin.log'
