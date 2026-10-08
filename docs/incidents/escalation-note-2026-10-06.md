# 沙箱升级路径也不可用 2026-10-06 22:49

runtime-status-2026-10-06.md 在被并发的唤醒实例同时追加，编辑总冲突，所以这条单独记。

- 用 `danger-full-access` 跑最小 pwsh 命令（Write-Output probe）：
  返回「sandbox escalation to danger-full-access requires approval, but no approval channel is available」，直接 fail closed。
- 结论：pwsh 的 ACL 授权失败（SetNamedSecurityInfoW Win32 5）无法靠提权绕过，headless 下没有审批通道，只能等环境自身恢复。
- 恢复后第一件事：用 list_wakes 找到那个约每 2 分钟、不带 prompt 的自唤醒触发器并取消。

## 当前状态与人工待办（2026-10-06 22:54 更新）

环境故障未恢复，headless 侧无法自救，下面四件事需要人工：

1. **空转的唤醒循环**：从 22:46 起有一个约每 2 分钟触发、又不带 prompt 的系统唤醒在空转。
   触发器在 `.runtime\dsh\forlife\db\forlife.sqlite` 的 `wake_triggers` 表里，但二进制 grep
   读不出明文，`list_wakes` 又坏，所以现在既看不到也取消不掉。环境恢复后：先 `list_wakes`，
   再 `cancel_wake` 掉这条循环触发器。
2. **唤醒工具报 schema 错**：根因是 `execute` 返回 `{content, value}` 信封，而宿主契约要求
   直接返回裸 JSON 值。`packages/dsh-component/src/wake-tools.ts` 已按契约改好
   （返回 `{ok, rows}` / `{ok, message}`），但**运行中的进程是旧构建** → 必须重建并重启 DSH 宿主才生效。
3. **唤醒 prompt 被截断**：`buildWakePrompt()` 产出的是多行文本，实际只到手第一行
   （`[系统唤醒] 这不是用户发来的消息……`），所以每次醒来都不知道自己原本要做什么。
   原因锁定在 `packages/gateway/src/driver.ts:64-71`：prompt 作为 argv 末位参数、且 `shell: true`，
   Windows 下 cmd 把换行当命令分隔符，后面的行全丢。
   建议改法：把 prompt 走 stdin，不让多行文本过 cmd 命令行。
   **已改**（2026-10-07 复核 `packages/gateway/src/driver.ts:73-88`）：args 固定为
   `['--profile', <p>, 'headless', '--json', '-']`，stdio 改成 `['pipe','pipe','pipe']`，
   prompt 由 `child.stdin.end(request.prompt)` 送入（并吞掉 stdin 的 EPIPE）；
   与 dsh-headless「`-` = 读 stdin」的契约一致（`dsh-headless/lib/index.js:300`）。
   **需重启 gateway 才生效**，目前尚无真机验证（回归脚本：`packages/gateway/scripts/e2e-wake.ts`）。
4. **pwsh 不可用**：任何 pwsh 调用在启动阶段就失败
   `SetNamedSecurityInfoW failed (Win32 5): grantWrite(D:\DSH-ForLife)`；提权到 danger-full-access
   也没有审批通道，直接 fail closed。需要人工修工作区的 ACL / 属主。`glob` 另有一个 30s 超时问题。
   （`read` / `write` / `edit` / `grep` 正常。）

在 1 与 4 修好前，无 prompt 的自动唤醒按约定只收尾、不再逐次记录。

## 状态更新（2026-10-07 10:19，自动唤醒时复核）

- 已恢复：`list_wakes` 正常返回（wake-tools 新构建生效，宿主重启过）；`glob` 不再 30s 超时。
- 已停止：2026-10-06 深夜的空唤醒循环没再出现（最后一次 headless 会话创建于 22:50:42）。
- 仍未恢复：`pwsh` 任何命令依旧 `SetNamedSecurityInfoW failed (Win32 5): grantWrite(D:\DSH-ForLife)`。
  只能人工处理：`icacls D:\DSH-ForLife /grant "%USERNAME%":(OI)(CI)F`（被拒先 `takeown`），
  挪到普通本地 NTFS 目录，或以管理员身份运行 DSH。
- 仍待确认：唤醒 prompt 依旧没有任务文本，driver 的 stdin 改法疑未在运行进程生效（需 pwsh 恢复后重启 gateway 验证）。
- 结论：第 1、4 项是当前唯一的人工卡点；第 2、3 项待 pwsh 恢复后收尾。

## 状态更新（2026-10-07 10:21，在另一个宿主进程里复核）

- **进程之间不同步**：本会话所属的 DSH 宿主进程没有重启过 —— `list_wakes` 仍报同一个
  schema 错（缺 `value.ok`/`value.rows`），`pwsh` 仍是 `Win32 5`。上面 10:19 那条
  「list_wakes 已恢复」很可能是**另一个已重启的宿主进程**，两条记录不矛盾。
  ⇒ 判断修复是否生效，先看那个进程有没有重启，而不是看源码。
- `glob` 窄路径已正常（`packages/gateway/src/*.ts` 秒回）。
- 源码侧三处修复都已落地：`wake-tools.ts` / `port-tools.ts` 的 `execute` 只返回裸值；
  `driver.ts` 的 prompt 走 stdin。都**只差重启进程**，源码层面已无待办。
- 本轮唤醒同样没有注入 prompt，未动任何业务数据。

## 状态更新（2026-10-07 10:20，补充一条新现象）

- **10:19:10–10:20:10 出现一次一分钟的会话爆发**：`.runtime\dsh\storages\session_projcache\sessions\`
  里新建了约 **62 个 headless 唤醒会话**（约每秒 1 个），10:20:10 之后不再新增。
  形态像宿主重启后把积压的唤醒请求一次性冲掉，而不是新的循环触发器
  （`list_wakes` 里当前没有活跃的 timer 循环唤醒）。**若再次成批出现，说明还有东西在批量投递唤醒请求。**
- 计数提醒：在该目录 grep 时间戳统计会话数会虚高 —— 每个会话文件除 `createdAt` 外，
  `lastMessageTime` / `lastInjectionTime` / `lastTurnInjectionTime` / `pendingTurnStart` 也会命中；
  统计新建会话必须只匹配 `createdAt`。

## 状态更新（2026-10-07 10:39，唤醒提示词的真根因已定并修好）

- **上面第 3 项（含 22:54 那条"建议改法"）里的 args 写法是错的**：`['--profile', <p>, 'headless', '--json', '-']`
  里的 `headless` **不是子命令**。启动器里 `dsh <name>` 只是 `--profile <name>` 的缩写
  （`dsh/lib/bin.js:128` 的展开），于是这个 `headless` 被 headless 应用当成**任务位置参数**
  （`dsh-headless/lib/startup.js:76-79`：`program.args = ['headless']` ⇒ `task = 'headless'`），
  `dsh-headless/lib/index.js:300` 便**不去读 stdin** —— stdin 里那整段提示词被整段忽略。
- **与真机现象完全对得上**：10-06 22:52–10-07 10:20 收到的注入文本是「`headless` + 模板第一行」
  （那时 args 末尾还挂着 prompt，被 cmd 在换行处截断）；10:2x 之后变成**只有「headless」一个词**
  —— 这说明 gateway 确实重启过、stdin 改法已生效，剩下的就是这个多余的位置参数。
  （也就是说 10:2x 那批"提示词仍被截断"的判断只对了一半：截断已修，改成了"任务被认成 headless"。）
- **已修**（2026-10-07 10:39）：`packages/gateway/src/driver.ts` 的 args 改为 `['--profile', <p>, '--json']`
  （位置参数为空 ⇒ 走 stdin 读 task）；`packages/gateway/src/turns.ts` 的驱动表同步更正；
  新增 `packages/gateway/test/driver.test.ts`，把「args 精确值」与「多行提示词整段走 stdin」钉死。
- **仍未验证**：`pwsh` 依旧 `SetNamedSecurityInfoW failed (Win32 5): grantWrite(D:\DSH-ForLife)`，
  所以 `node --test packages/gateway/test/driver.test.ts` 跑不了，gateway 也重启不了。
- **卡点没有变，而且只剩一个**：人工修工作区 ACL（或管理员身份运行 DSH），让 `pwsh` 可用；
  gateway 一旦重启，下一次唤醒就能拿到完整提示词（含「你当时要自己做的事」）。
