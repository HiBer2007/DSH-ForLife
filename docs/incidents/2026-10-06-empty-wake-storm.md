# 空唤醒风暴（2026-10-06 起）

> **历史记录，可能已过时。** 这里记的是**一次性事故**的现象、根因与处置结论，不是现状。
> 其中**现在仍然成立**的知识已提炼到 `docs/notes/`（对照表见文末）。

## 现象

- 2026-10-06 约 22:46 起，会话以约 2 分钟一次的频率被系统唤醒，**每次都不带任务提示词**；
  单次唤醒没有可执行内容，醒来只能空转。
- 同期三个工具不可用，导致事故无法从会话内部自查：
  - `pwsh` 任何命令**启动阶段**即失败：`SetNamedSecurityInfoW failed (Win32 5): grantWrite(D:\DSH-ForLife)`；
  - `glob` 全树 30s 超时（窄路径可用）；
  - `list_wakes` 报 schema 校验错：`missing required property "value.ok"; "value.rows";
    "value.content" is not a declared property`。
- 2026-10-07 上午宿主重启，出现一次积压排空：约 54 秒内新建 **62 个 headless 会话**，
  每个都跑完一整个 agent 轮次（很烧钱）。
- 风暴随后停止。最后一次会话 `createdAt` = 22:50:42，而 `cancel_wake` 的调用在 22:51 ——
  **停止早于取消**，所以"取消导致风暴停止"在时间上不成立，归因记为"另有原因（后台暂停 / 引擎自身收敛）"，
  未定论。

## 根因（两条，叠加才表现为"空唤醒风暴"）

1. **提示词投递被截断**（`packages/gateway/src/driver.ts`）：多行 prompt 被当成 argv 末位参数，
   且 `shell: true` ⇒ Windows `cmd` 把换行当命令分隔符，只有第一行到达 dsh。
   修复途中又暴露第二层错误：args 里的 `headless` **不是子命令**，被 headless 应用当成任务位置参数
   ⇒ stdin 里整段提示词被忽略，注入文本只剩一个词「headless」。
2. **输出契约被违反**（`wake-tools.ts` / `port-tools.ts`）：`execute` 返回 `{content, value}` 信封，
   而宿主把返回值原样按 `output.schema` 校验 ⇒ 五个唤醒工具里三个（`list_wakes` / `cancel_wake` /
   `wake_now`）全废，触发器既列不出也取消不掉。

**触发器本身是正常业务事件**：QQ 连接状态翻转（`QQ 端已连接` / `QQ 端断开`）会在每次变化时触发一次
system 唤醒。真正让唤醒"醒来没事干"的是根因 1。

## 处置（顺序不能反）

1. **人工修工作区 ACL**（恢复 `pwsh`）—— 其余修复都依赖它，且 headless 无法自救（无审批通道，fail closed）。
2. **重建并重启 DSH 宿主**，让裸值版 `wake-tools.ts` 生效。
3. `list_wakes` 取 id → `cancel_wake` 掉反复触发的空唤醒触发器（**先看再取消**，别误删正常定时任务）。
4. `driver.ts` 改为 `args = ['--profile', <p>, '--json']`（**不传任务位置参数**），
   提示词走 `child.stdin.end(request.prompt, 'utf8')`；新增 `packages/gateway/test/driver.test.ts`
   钉死 args 精确值与"提示词不进 args"。
5. 端到端回归：`node packages/gateway/scripts/e2e-wake.ts`。

## 结果

- **已恢复**：`list_wakes` 正常（裸值修复在重启后的新进程里生效）；`glob` 窄路径与全树都正常。
- **已修（源码层）**：提示词投递路径、`execute` 输出契约、`port-tools.ts` 同类问题，
  并补了防回归用例。
- **遗留**：`pwsh` 的 ACL 故障需人工处理，导致全程**没有测试执行证据**（`node --test` 跑不了）。

## 仍然成立的部分 → `docs/notes/`

| 教训 | 现在在哪 |
|---|---|
| `execute` 只返回规范化 JSON 值（含报错判据、防回归测试） | `docs/notes/wake-tools-output-contract.md` |
| 提示词只能走 stdin；`headless` 不是子命令；症状对照表 | `docs/notes/dsh-headless-task-contract.md` |
| 触发器失控怎么查、怎么停、怎么归因 | `docs/notes/wake-trigger-triage.md` |
| `pwsh` / `glob` 故障判读与修复、修复按进程生效 | `docs/notes/env-troubleshooting.md` |
