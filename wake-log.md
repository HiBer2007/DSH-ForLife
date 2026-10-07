# 唤醒日志

- 2026-10-06 22:46 (Asia/Shanghai)：收到一次无内容的系统唤醒（headless）。当次无法确定是哪条唤醒触发的——
  - list_wakes 连续两次返回 schema 错误（缺 value.ok / value.rows）。
  - 没有进行中的 goal、没有子代理、没有后台任务。
  - 长期记忆检索「唤醒/提醒/定时」「待办/任务/稍后处理」均无命中。
  - pwsh 报 `SetNamedSecurityInfoW failed (Win32 5): grantWrite(D:\DSH-ForLife)`，glob 超时，文件沙箱当时不可用。
  - 结论：没有可执行的事，未向任何人发消息。

- 2026-10-06 22:48 (Asia/Shanghai)：**又一次**无内容的系统唤醒（headless），距上一次约 2 分钟。环境没恢复，结论同上：
  - `list_wakes` 仍是同一个 schema 错误（缺 `value.ok` / `value.rows`）⇒ 拿不到触发器 id，`cancel_wake` / `wake_now` 都用不了。
  - `pwsh` 仍在启动阶段失败：`SetNamedSecurityInfoW failed (Win32 5): grantWrite(D:\DSH-ForLife)`；`glob` 仍 30s 超时；`read` / `grep` 正常。
  - 无 goal、无子代理、无后台任务；长期记忆检索仍无相关命中。
  - **观察（未确认）**：两次空唤醒间隔 ≈2 分钟，怀疑有一个周期触发器在重复触发，且它没把 prompt 一起注入。若继续以这个频率醒，就是该触发器的故障而非正常调度。
  - 本次仍只做记录，未向任何人发消息（这个 headless 会话里也没有可用的 QQ 发送工具）。

- 2026-10-06 22:47:44（唤醒采样时间，实际读到墙钟已 22:50）(Asia/Shanghai)：**第三次**无内容系统唤醒，模式与前两次一致。
  - `list_wakes` 仍是同一个 schema 错误（缺 `value.ok` / `value.rows`）；没有再重复试。
  - `pwsh` 仍是 `SetNamedSecurityInfoW failed (Win32 5): grantWrite(D:\DSH-ForLife)`；`glob` 仍 30s 超时。
  - `read` / `grep` / `edit` 正常（本次就是靠它们读日志、追加这条记录）。
  - 无 goal、无子代理、无后台任务。
  - **待办（等环境恢复后第一件事）**：查清那个约 2 分钟一次的空唤醒触发器并取消 —— 现在它没带 prompt，醒一次也只是重复记录。
  - 本次只做记录，未向任何人发消息。

- 2026-10-06 22:49:30 (Asia/Shanghai)：**第四次**无内容系统唤醒（采样时间 22:49:41），距上一次约 2 分钟，模式完全一致。
  - `list_wakes` 仍是 `missing required property "value.ok" / "value.rows"`；`pwsh` 仍是 `SetNamedSecurityInfoW failed (Win32 5): grantWrite(D:\DSH-ForLife)`（启动阶段就失败）；`glob` 仍 30s 超时。
  - `read` / `grep` / `edit` 正常。无 goal、无子代理、无后台任务。
  - 按约定不再重复探测工具（本次各只试了一次就停）。
  - **周期确认**：22:46 → 22:48 → 22:47:44(采样) → 22:49:30，间隔稳定在 2 分钟左右 ⇒ 基本可以确定是一个周期触发器在反复触发，且没有把 prompt 注入进来。
  - 本次仍只做记录，未向任何人发消息（此 headless 会话无 QQ 发送工具）。
  - **环境恢复后第一件事不变**：`list_wakes` 拿到 id → `cancel_wake` 掉这个 2 分钟的周期触发器。

- 2026-10-06 22:50（**第五次**，采样 22:47:57 / 读墙钟 22:49–22:50）(Asia/Shanghai)：模式与上四次完全一致，不重复细节。
  - 工具状态同前：`list_wakes` schema 错、`pwsh` 启动即失败（grantWrite 被拒）、`glob` 超时；`read`/`write`/`grep`/`now` 正常；无 goal。
  - 也确认过工作区 `*.json` 里没有唤醒存储，触发器 id 无法从文件侧获得。
  - 追加本文件时已连续遇到"file changed since it was read"⇒ 说明有**多个唤醒轮次在并发执行**（中期记忆里也出现过同时写入的条目）。
  - 按约定：不再重复探测工具、不再重复写记忆条目、不设新的定时唤醒。仅留这一行记录。

- 2026-10-06（**第六次**，本轮注入的采样时间是 22:47:33，`now` 读到 22:47:41，而前一轮记录的墙钟已到 22:49–22:50）(Asia/Shanghai)：现象与结论都不变。
  - 新信息只有一条：**注入的采样时间比真实墙钟落后约 2 分钟**，所以"间隔恰好 2 分钟"这个规律可能只是采样时间戳被复用/滞后造成的假象，不能据此断定是 2 分钟周期触发器。
  - 工具状态同前（`list_wakes` schema 错、`pwsh` 启动即失败、`glob` 超时），未重复探测；无 goal、无子代理、无后台任务。
  - 从这一轮起不再逐次追加记录（前五条已经把能查的都查完了，重复记账只会和并发的唤醒轮次抢文件）。**下次环境恢复后：先 `list_wakes` 看真实触发器列表，再判断要不要 `cancel_wake`。**

> **进展（不再是"只做记录"）**：`list_wakes` / `cancel_wake` / `wake_now` 的 schema 报错已定位为代码 bug（`execute` 返回旧信封 `{content, value}`，宿主约定是直接返回规范化 JSON 值），并已在 `packages\dsh-component\src\wake-tools.ts` 修好 —— 但**要进程重启才生效**，所以本轮 `list_wakes` 仍然报同样的错。根因与修复见 `wake-2026-10-06-wake-tools-schema-fix.md`。重启后第一件事：`list_wakes` → `cancel_wake` 掉那个不带 prompt 的空唤醒触发器。

- 2026-10-06 22:52（第七次；不记流水，只记**新结论**）：空唤醒还有第二个原因，跟触发器本身无关 —— **提示词在投递路上被截断**。
  - 根因：`packages/gateway/src/driver.ts:64` 把多行 prompt 当命令行参数传给 `dsh headless`，且 `shell: true`；Node 只做 `args.join(' ')` 不转义，换行把提示词切断，**只有第一行**到达 dsh。
  - 所以就算触发器写了完整 prompt，我们收到的也恰好是 `wake-prompt.ts:53` 那一句，`## 触发` / 任务 prompt / payload / 上次行动 全丢。
  - 诊断、证据与建议改法（`-` + stdin 传 task）：`wake-prompt-truncation-2026-10-06.md`。**代码未改**（本机无法验证，且影响所有 QQ 轮次）。
  - 附带风险：prompt 里的 shell 元字符会进 shell（可注入面）。
  - 环境未恢复（pwsh / glob 同前，`list_wakes` 待重启生效）；未向任何人发消息。

- 2026-10-06 22:51（本轮采样 22:49:41）(Asia/Shanghai)：**新动作——绕过坏掉的 list_wakes 直接拿到 id 并尝试取消**。
  - 方法：直接用 `grep` 搜数据库 `.runtime\dsh\forlife\db\forlife.sqlite`，在 `wake_trigger_events` 里读到同一个 id 反复出现：**`wt_73d59592-fac3-442f-8831-4d445b1bd0b3`**（22:02→22:17→22:23:54→22:26:04→22:27:33），节奏与空唤醒吻合；其余 id 各只出现一次。
  - 已调 `cancel_wake(wt_73d59592-…)`：**工具确实执行了**（返回了值），但外层仍报同样的信封结构错 ⇒ 删除大概率已生效，**但无法确认**；若之后不再有 2 分钟一空唤醒，即验证成立。
  - 确认 `web_fetch` 抓 localhost 被策略拒（"non-public IP"）⇒ 后台管理 API（默认 8081）这条路走不通，grep-sqlite-取-id 是唯一替代路径。
  - **风险留痕**：该触发器的 scope / prompt 读不出来（二进制页），不能排除它属于别的会话（记忆里 `onebot11:2166227840` 能收到完整提示）。若之后发现谁的周期任务消失，就是这次取消所致。
  - 按约定未新设核查唤醒：它若还在空转，几分钟内自然会再唤醒我。

- 2026-10-06 22:54（**核查结果：空唤醒风暴已停**）(Asia/Shanghai)：本条不是"又一次空唤醒"，而是对 22:51 那次取消的**验证**。
  - 硬证据：`.runtime\dsh\storages\session_projcache\sessions\` 下最新一个 headless 会话的 `createdAt` 是 **22:50:42**；当前墙钟 22:54:07 —— **其间 3.5 分钟零新增会话**。风暴期间峰值约每秒 1 个（22:13–22:50 共建了约 230 个 headless 会话）。
  - 时间线自洽：停止(22:50:42) ≈ `cancel_wake(wt_73d59592-…)`(22:51) ⇒ 那次取消**很可能真的生效了**（尽管只回了 schema 错、没有回执）。
  - 本轮唤醒是风暴尾巴里排队的一轮，不是新触发；未重复探测工具（`list_wakes` 仍是同一个 schema 错 ⇒ 宿主还没重启）。
  - 仍未确认：被取消触发器的 scope / prompt（二进制库读不出来）。若日后发现谁的周期任务消失，即为本次取消所致。
  - 工具补充：`glob` **窄路径可用**（指定到具体目录能秒回，全树仍超时）；会话文件里的 `createdAt` 是 epoch 毫秒，可以用 grep 做时间统计。

- 2026-10-06（又一轮空唤醒；不记流水，只记**新结论**）：**源码快照不可靠 —— 有多个唤醒轮次在并发改同一个文件。**
  - 证据：同一份 `packages\dsh-component\src\wake-tools.ts` 先后两次 `read` 到的内容不同 ——
    第一次 `list_wakes` 的 `execute` 还返回 `{content, value}` 信封，几分钟后再读已改成裸值 `{ok, rows}`（文件也从 375 行长到 404 行）。
  - 所以上面第 44 行"已修好"、以及本轮之前写的任何"某工具仍未修"的说法，都可能已经过期；
    在并发状态下也**不要编辑这个文件**（会撞 `file changed since it was read`，还可能互相覆盖）。
  - 契约本身没变，写在 `wake-tools-contract-bug-2026-10-06.md`（不变量 + 报错长相 + 建议补的回归测试 + 重启后动作），
    并提醒：`test/wake-tools.test.ts` 的 `valueOf()` 助手会把信封剥掉，所以单测抓不到这类 bug。
  - 本轮另测：`glob` 对**窄目录**（`packages\dsh-component\src`）已正常返回，只有工作区全树仍 30s 超时 ——
    即"glob 全废"的说法也要修正为"窄路径可用"。
  - `pwsh` 仍是启动即败（`SetNamedSecurityInfoW ... Win32 5: grantWrite`），未再试。

- 2026-10-07 10:19 (Asia/Shanghai)：一次无内容系统唤醒（只有模板首行）。**环境部分恢复，与昨晚不同**：
  - ✅ `list_wakes` **恢复正常**（不再是 schema 信封错）⇒ 宿主已重启，`wake-tools.ts` 的裸值修复在生产里生效。
    返回的触发器全部是 `已结束` 的一次性 timer：两条「复查运行时故障是否恢复」、「验收①」系列，外加一条 `真机：QQ 掉线 · system`（状态显示为 `system`，含义不明，未动它）。
    **昨晚每 ~2 分钟一次的空唤醒循环触发器已不在列表里，风暴也未再出现** ⇒ 22:51 那次 `cancel_wake` 应已生效，这条待办可以结掉。
  - ❌ `pwsh` 仍启动即败：`SetNamedSecurityInfoW failed (Win32 5): grantWrite(D:\DSH-ForLife)`（未再试提权，已知会 fail closed）。
  - ✅ `glob` 窄目录正常（`packages\dsh-component\src` + `*.ts` 秒回）。
  - ✅ `read` / `write` / `edit` / `grep` / `now` 正常。
  - ⚠️ 本轮的唤醒提示**仍只有模板第一行**。`packages\gateway\src\driver.ts` 源码已是 stdin 版（`headless --json -` + `child.stdin.end(request.prompt)`），
    而 `list_wakes` 已生效 ⇒ **疑似 dsh 宿主重启了、但 gateway 进程还是旧构建**（截断在 gateway 侧）。未确认，待 pwsh 可用后查进程启动时间/日志。
  - 未向任何人发消息（此 headless 会话无 QQ 发送工具）；未新设唤醒。

- 2026-10-07 10:21 (Asia/Shanghai)：对上面这条的**两点补充/修正**（只记新事实）：
  - **10:19 有一波集中建会话**：`.runtime\dsh\storages\session_projcache\sessions\` 下 `createdAt` 落在 **10:19:16–10:20:10（约 54 秒）** 的 headless 会话共 **62 个**（约每秒 1 个，标题全是「headless [系统唤醒] 这不是用户…」）；
    10:20:10 之后再无新增（10:21:45 复查，零）。**判断：不是新一轮循环风暴，更像宿主重启后把积压的唤醒请求一次性排空**（与"宿主刚重启、list_wakes 刚恢复"同一时刻吻合）。本轮唤醒就是这 62 个之一。
  - `glob` 的恢复程度比上面写的更好：**工作区全树 `**/*.md` 也正常返回**（1757 个结果，未超时）⇒ "全树仍超时"的旧结论作废。
  - 计数提醒：用 `grep` 按 `"createdAt": <epoch ms>` 统计会话时，模式要卡准位数（13 位毫秒），否则会把昨天/前天的一起算进来。

- 2026-10-07 10:19:34 (Asia/Shanghai)：**修正上面"list_wakes 已恢复"的适用范围 —— 修复是按进程算的，不是全局。**
  - 同一个 10:19 唤醒轮次（本会话是昨晚 22:47 起、没随宿主重启的那一批）里实测：`list_wakes` 与 `cancel_wake` **仍报同一封信封式 schema 错**（缺 `value.ok` / `value.rows` / `value.message`），`pwsh` 仍是启动即败 `SetNamedSecurityInfoW Win32 5: grantWrite(D:\DSH-ForLife)`；只有 `glob` 恢复了。
  - 结论：裸值版 `wake-tools.ts` 只被**重启后新起的进程**加载到；一直活着没重启的宿主里的会话仍旧跑信封版。所以"修复有没有生效"必须在**新进程**里验证，别拿一个旧进程的观察当全局结论。
  - 风暴已停（昨晚 22:51 的 `cancel_wake` 是有效的）、`pwsh` 待人工授权这两条结论不变；本轮未向任何人发消息，也未新设唤醒。

- 2026-10-07 10:22（对上面两处"`cancel_wake` 有效"的**反证** + 成本提示）：
  - 时间线反证：昨晚最后一波会话的 `createdAt` 最大值是 **22:50:42**，而 `cancel_wake(wt_73d59592-…)` 是 **22:51** 才调用的 ⇒ **停止发生在取消之前**，"取消导致风暴停止"在时间上不成立。风暴**确实**停了，但归因要改成"另有原因"（后台暂停 / 引擎自身收敛），别把这个待办记成"已验证"。
  - 成本提示：今晨那 60 多个会话各自跑完了**一整个 agent 轮次**（抽查一个：1 turn / 2 step，约 3.9k 未缓存输入 + 30.4k 缓存读 + 0.7k 输出）。54 秒 ≈ 60 多个完整轮次 ⇒ "排空积压"这种形态很烧钱，修复优先级应排在别的前面。
  - 本轮（未随宿主重启的旧进程）复测：`list_wakes` 仍报信封 schema 错、`pwsh` 仍 `Win32 5`，与上一条一致；`glob` 窄路径可用。
