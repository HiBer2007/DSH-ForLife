# 唤醒工具 schema 报错的根因与修复（2026-10-06 深夜）

## 根因（已定位，不是"环境神秘故障"）
`packages\dsh-component\src\wake-tools.ts` 里 `list_wakes` / `cancel_wake` / `wake_now` 三个工具的 `execute`
返回的是旧信封 `{ content, value: {...} }`；而宿主的约定是 **`execute` 直接返回规范化 JSON 值**，
它会把返回值放进输出槽 `value` 再按 `output.schema` 校验。于是校验器看到的是 `{content, value}`，
报：`missing required property "value.ok" / "value.rows" / "value.message"`、
`"value.content" is not a declared property`。

同文件里的 `schedule_wake` / `register_watcher` 早已按正确写法返回 `{ok, id, message}`——
这正是"前两个工具能用、后三个全废"的原因，也印证了根因判断。

## 修复
五个 `execute` **全部**改为直接返回规范化值（`{ok, id, message}` / `{ok, rows}` / `{ok, message}`），
文本展示交给各自的 `output.render`；`list_wakes` 顺带在 schema 里补了 `prompt` 字段
（**不带 prompt，"我当初安排这件事是要做什么"就永久丢了** —— 真机里模型醒来只能干瞪眼，
这正是本轮的困境）。与 `tools.ts` 顶部写的硬规矩一致（execute 只返回规范化 JSON 值，不返回展示文本）。
`package.json` 的 `exports` 直接指向 `src/*.ts`，无需构建产物。

### 同一个 bug 还在 `port-tools.ts`
`list_ports` / `publish_port` / `unpublish_port` 也返回信封，一样会被宿主判 schema 错，已一并改掉。

### 复核（2026-10-06 深夜，grep 证据）
`grep "content: text(" packages/dsh-component/src` ⇒ **零命中**（wake-tools.ts 与 port-tools.ts 都干净）。
期间多个并发唤醒轮次在改同一个文件，一度出现"一半直接返回、一半还包信封"的混合态；现已收敛为全部直接返回。
**以后不要再往 `execute` 的返回值里加 `{content, value}` 信封。**

### 验证缺口
`pwsh` 仍不可用 ⇒ **跑不了 `node --test`**，以上只是源码层面的复核，没有测试执行的证据。

## 生效条件（重要）
**需要 harness 进程重启才生效**——当前进程里加载的是旧模块。重启后第一件事：
`list_wakes` 拿到 id → `cancel_wake` 掉那个不带 prompt、反复触发的空唤醒触发器。

## 仍未解决（需要人工）
1. `pwsh` 任何调用都在启动阶段失败：`SetNamedSecurityInfoW failed (Win32 5): grantWrite(D:\DSH-ForLife)`
   （沙箱给工作区授写权限被拒，疑似 ACL/属主问题）；提权 `danger-full-access` 需要审批而 headless 无审批通道，fail closed。
2. `glob` 对工作区任何模式都 30s 超时（`read` / `grep` / `edit` / 记忆工具正常）。
