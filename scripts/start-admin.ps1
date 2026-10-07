# 起 forlife 主管理后台 + QQ 链路（本机联调用）。
#
# 为什么写成脚本文件而不是命令行内联：Start-Process 的多层引号会把
# `$env:XXX=...` 这类赋值搞坏（我踩过：DSH 因此回落到宿主 ~/.dsh）。脚本文件没有这个问题。
#
# 绑 0.0.0.0 是**故意的**：要能用手机验收。代价是同网段都能打开登录页，
# 所以口令是唯一门槛 —— 服务端每次启动都会提醒这一点。
$ErrorActionPreference = 'Stop'
$root = 'D:\DSH-ForLife'

# ── DSH_HOME **必须在仓库内**（可移植硬约束）───────────────────────────────
#
# headless 驱动会把 process.env 传给 `dsh headless` 子进程（driver.ts:67），
# 而 `DSH_HOME` 不设的话它会**回落到宿主 ~/.dsh** ——
# 那正是本文件开头第 4 行记着的那个坑，但当时只修了"引号问题"，没设这个变量。
#
# 真机证据（2026-10-06）：开发机的 `DSH_HOME` 是 `C:Users<用户>.dsh`，
# 而 gateway 直接继承了它 ⇒ 切到 headless 驱动就会写宿主的 dsh 目录。
# ── provider 密钥（OpenCode Go）─────────────────────────────────────────
#
# 用户给了三个 key：GO / QQ / CL（**CL 最后用**）。三个都落在 .runtime/
# （gitignored），这里按优先级挑**第一个存在且非空**的。
#
# **库里只存引用名**（inference_endpoints.api_key_ref = FORLIFE_OPENCODE_GO_KEY），
# 值只在本机文件/环境变量里 —— 这是项目硬约束。
#
# 注意：这里只做"挑第一个存在的"，**不做额度判断** ——
# 脚本只在启动时跑一次，而额度是会变的。真正的"按额度选 key"
# 属于**端点层**（建多个端点各带 key_ref，让路由/健康机制去挑）。
$keyFiles = @(
  "$root\.runtime\provider-key-GO.txt",
  "$root\.runtime\provider-key-QQ.txt",
  "$root\.runtime\provider-key-CL.txt"
)
if (-not $env:FORLIFE_OPENCODE_GO_KEY) {
  foreach ($kf in $keyFiles) {
    if (Test-Path $kf) {
      $v = (Get-Content $kf -Raw).Trim()
      if ($v) { $env:FORLIFE_OPENCODE_GO_KEY = $v; break }
    }
  }
}

# 用 `FORLIFE_DSH_HOME` 显式覆盖，默认指向仓库内。
$env:FORLIFE_DSH_HOME = if ($env:FORLIFE_DSH_HOME) { $env:FORLIFE_DSH_HOME } else { "$root\.runtime\dsh" }
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

# ── 唤醒引擎（PLAN 阶段 8）────────────────────────────────────────────────
# 桥的两端：gateway 发（FORLIFE_WAKE_BRIDGE_URL），插件侧收（同名的 SECRET 校验）。
# 不配的话 gateway 侧**明确禁用**唤醒引擎（不会假装能唤醒）。
if (Test-Path "$root\.runtime\wake-bridge-secret.txt") {
  $env:FORLIFE_WAKE_BRIDGE_SECRET = (Get-Content "$root\.runtime\wake-bridge-secret.txt" -Raw).Trim()
  # 插件侧的端点路径要与这里一致（默认 /forlife/wake）
  $env:FORLIFE_WAKE_BRIDGE_URL = if ($env:FORLIFE_WAKE_BRIDGE_URL) { $env:FORLIFE_WAKE_BRIDGE_URL } else { 'http://127.0.0.1:3080/api/forlife/wake' }
}

# 监视条件的沙箱根（不配则监视源明确禁用 —— 路径没有沙箱根可比）
$env:FORLIFE_WORKSPACE_ROOT = if ($env:FORLIFE_WORKSPACE_ROOT) { $env:FORLIFE_WORKSPACE_ROOT } else { "$root\.runtime\workspace" }

# 存储分层（PLAN 阶段 9）。只配 hot 也能跑 —— warm/cold 会退回它，
# 且 gateway 会把"退回了哪几层"报出来（不会让人以为真的分了三层在放）。
# 备份目标目录（PLAN 阶段 9 交付物 7）。
#
# **必须由部署方指定** —— 接口只接受一个子目录名，不接受任意路径
#（允许任意路径的话，拿到管理会话的人就能把文件写到系统任意位置，那是提权）。
#
# 默认放仓库内 .runtime/backups：**不是**因为它是好位置，而是因为
# 开发机上没有别的盘。生产部署时应当指到**另一块物理盘**上 ——
# 备份和源数据在同一块盘上，盘坏了备份一起没。
$env:FORLIFE_BACKUP_DIR = if ($env:FORLIFE_BACKUP_DIR) { $env:FORLIFE_BACKUP_DIR } else { "$root\.runtime\backups" }

# 归档目录（PLAN 阶段 9 交付物 3）。
#
# **必须由部署方指定** —— 接口只接受 tier，不接受任意路径。
#
# 归档是"**很久以后才回来读**"的东西，所以它比备份更该放在**另一块盘**上。
# 开发机默认放仓库内（没有别的盘），生产部署要指到 HDD。
$env:FORLIFE_ARCHIVE_DIR = if ($env:FORLIFE_ARCHIVE_DIR) { $env:FORLIFE_ARCHIVE_DIR } else { "$root\.runtime\archives" }

$env:FORLIFE_ROOT_HOT = if ($env:FORLIFE_ROOT_HOT) { $env:FORLIFE_ROOT_HOT } else { "$root\.runtime\dsh\forlife\blobs" }

# 驱动：联调阶段用 fake（回复由脚本生成，日志会大声标注）；生产改 headless
$env:FORLIFE_DRIVER = if ($env:FORLIFE_DRIVER) { $env:FORLIFE_DRIVER } else { 'fake' }
# 联调期关掉噪音过滤：确保测试消息一定产生轮次，便于观察链路
$env:FORLIFE_NOISE = if ($env:FORLIFE_NOISE) { $env:FORLIFE_NOISE } else { 'off' }

# NapCat 自己的 WebUI token（内嵌页面要用它自动登录；不是 OneBot 的 accessToken）
$env:FORLIFE_NAPCAT_WEBUI_PORT = '6099'
$env:FORLIFE_NAPCAT_TOKEN = 'b3bc4acb0f4a'

Set-Location $root
Write-Output "FORLIFE_DB=$env:FORLIFE_DB"
Write-Output "监听=$env:FORLIFE_ADMIN_HOST`:$env:FORLIFE_ADMIN_PORT"
Write-Output "OneBot=$env:FORLIFE_ONEBOT_HOST`:$env:FORLIFE_ONEBOT_PORT  驱动=$env:FORLIFE_DRIVER"
node packages/gateway/src/server.ts 2>&1 | Out-File -Encoding utf8 "$root\.runtime\admin.log"
