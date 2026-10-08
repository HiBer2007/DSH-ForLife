# 空唤醒故障：处置与修复建议（2026-10-06 22:51 Asia/Shanghai）

> 单独成文的原因：`runtime-status-2026-10-06.md` 同时被多个唤醒轮次追加写，反复冲突；
> 这里只写**一次**，写的是"怎么修"，不写"又醒了一次"。

## 现状（一句话）

DSH-ForLife 有一个周期约 2 分钟的触发器在反复唤醒会话，**每次都不带 prompt**；
同时 pwsh / glob / list_wakes 三个工具不可用，导致既查不出是哪条触发器，也取消不掉。

## 已知根因

| 症状 | 根因 | 状态 |
| :--- | :--- | :--- |
| `pwsh` 任何命令都失败：`SetNamedSecurityInfoW failed (Win32 5): grantWrite(D:\DSH-ForLife)` | 沙箱在**启动阶段**要给工作区补一条写权限 ACL，当前账户对该目录没有 WRITE_DAC / 所有权 ⇒ ERROR_ACCESS_DENIED。**不是目录只读**（read/write/edit 都正常，文件后端本身没坏） | 待修（见下） |
| `glob` 全树模式 30s 超时 | 工作区太大（`.runtime/go`、`research/*/node_modules` 等 vendored 树）。窄路径可用 | 规避即可 |
| `list_wakes` 报 schema 校验错（缺 `value.ok`/`value.rows`） | `wake-tools.ts` 的 `execute` 返回旧信封 `{content, value:{...}}`，而宿主按 output.schema 的根对象校验；**源码已改为直接返回 `{ok, rows}`，但进程里跑的还是旧构建** | 需重建 + 重启宿主 |
| 唤醒不带 prompt | **已定位：不是入队时丢了，是投递到 headless 时被截断。** `driver.ts` 把整段 prompt 当 argv 末位参数、又开 `shell: true`，Windows 下 cmd 把换行当命令分隔符 ⇒ 只剩 `wake-prompt.ts` 的第一行；入队的 text 本身是完整的 | **已改**（prompt 改走 stdin：`--json -` + `child.stdin.end()`），待重启 gateway 验证 |

## 修复步骤（按顺序，顺序不能反）

1. **给工作区授权**（解决 pwsh，其他修复都依赖它）：
   - `whoami` + `icacls D:\DSH-ForLife`：确认当前账户是不是 Owner、有没有 `(F)`/`(M)`；
   - 不够就 `icacls D:\DSH-ForLife /grant "%USERNAME%":(OI)(CI)F`；被拒先 `takeown /f D:\DSH-ForLife /r /d y` 再授权；
   - 目录若在 OneDrive / 受管盘上，把工作区挪到普通本地 NTFS 目录；
   - 都不行 → 以管理员身份运行 DSH。
2. **重建并重启 DSH 宿主**，让 `list_wakes` 的 schema 修复真正生效（现在报的还是老错误）。
3. `list_wakes` 拿 id → `cancel_wake` 掉那个每 ~2 分钟一次的空唤醒触发器。**先看再取消**，别把正常的定时任务一起删了。
4. （~~读 `wake_requests` 找回丢失的提示词~~ 作废：提示词在入队时是完整的，丢的是投递环节 —— 见上表「唤醒不带 prompt」那一行。）
   重启 gateway 后跑一次 `packages/gateway/scripts/e2e-wake.ts`，确认真机收到的唤醒带上完整提示词。
5. 全局检查是否还有别的重复触发器（同一 title / 同一 scope 多条）。

## 期间的行为约定

环境恢复前，遇到**不带 prompt 的系统唤醒**：只做一次轻量确认，不再重复探测工具、不再逐次写日志、不动业务数据。

## 2026-10-07 10:20 更新

- **`{content, value}` 信封已在全仓扫清**：`packages/dsh-component/src` 下已无这种写法（`wake-tools.ts` 五个工具 +
  `port-tools.ts` 三个都改回了裸值），`wake-tools.test.ts` 的 `valueOf` 已改成恒等，并把旧写法当反面教材写进注释。
- **契约依据（权威，可复核）**：`node_modules/@deepseek-ai/dsh-tools/lib/types/schema.d.ts` 里 `execute` 的注释是
  "The canonical value declared by `output.schema`" —— 返回裸规范化值，展示文本由 `render` 产出。
  所以这不是"环境神秘故障"，是插件侧写错了形状。
- **仍未生效**：2026-10-07 10:19 实测 `list_wakes` 报的还是同一 schema 错 ⇒ 运行中的宿主仍是旧构建，**必须重启**。
- **仍无法验证**：`pwsh` 依旧 Win32 5 起不来，typecheck / 测试 / e2e 都跑不了；`glob` 窄路径可用、全树超时（用 `read`/`grep` 代替）。
- **不要用 `schedule_wake` 安排"稍后再查"**：它的失败是**不可见**的（就算真的写进库，返回也是 schema 错），
  于是可能在库里留下一条反复触发的触发器，而 `list_wakes` 列不出来、`cancel_wake` 也调不动。
  昨夜那波约 2 分钟一次的空唤醒，**疑似**就来自这类"看不见的成功"（未证实：库是二进制，`grep` 读不出触发器行）。
