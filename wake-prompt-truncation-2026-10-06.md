# 唤醒提示词被截断到第一行 —— 根因定位（2026-10-06 22:52 +08:00）

## 结论

每次「系统唤醒」只收到 `buildWakePrompt()` 输出的**第一行**，根因在

`packages/gateway/src/driver.ts:63-71`（`HeadlessTurnDriver.run`）：

```ts
const args = ['--profile', this.options.profile, 'headless', '--json', request.prompt]
const child = spawn(this.options.bin, args, { …, stdio: ['ignore', 'pipe', 'pipe'], shell: true })
```

**多行 prompt 被当成命令行参数、又开了 `shell: true`。**
Node 在 `shell: true` 时只用 `[file, ...args].join(' ')` 拼一条命令行，**不做引号转义**。
于是提示词里的换行把命令切断：

- 第一行的词被当成 task 交给 dsh；
- 其余各行被 cmd 当成**另一条命令**，直接丢弃（或报错）。

而 `dsh headless` 的 task 是位置参数、多词按空格拼接
（`node_modules/@deepseek-ai/dsh-headless/lib/startup.js:35`：
`argument("[task...]", "the task text; multiple words are joined by spaces, and \`-\` reads stdin")`）。

## 证据

本次（22:52）收到的唤醒原文只有：

```
headless [系统唤醒] 这不是用户发来的消息，而是你自己之前设的触发器到点了。
```

这正是 `wake-prompt.ts:53` 那一行，**后面 50 行全没了**：

- `## 触发`（标题 / 类型 / 原因 / 会话 / 预算）
- `## 你当时要自己做的事`（= 触发器里我写的 prompt）
- `## 上次醒来时你做了什么`
- `## 触发内容`（payload）
- `## 该怎么做`

后果：唤醒轮**没有原因、没有任务、没有上次行动记录**，醒来只能空转一次。
这解释了 22:46 / 22:48 / 22:49 连续几次「无内容的系统唤醒」。

顺带一个安全问题：prompt 里的字符会**进 shell**。payload 是 JSON（含 `{}` `"`），
触发器标题/文件内容里只要有 `& | > ( ) ;` 就会被当命令执行。第 4、5 行的
```json 围栏和花括号就落在被丢弃的那部分里，目前表现是"静默丢"，但这是可注入面。

## 建议改法（未改动代码 —— 无法在本机验证，且影响所有 QQ 轮次）

用 dsh 明确支持的 **stdin** 传 task，彻底绕开 shell 引用问题：

```diff
-    const args = ['--profile', this.options.profile, 'headless', '--json', request.prompt]
+    // 多行 prompt 不能当命令行参数：shell:true 时 Node 只做 join(' ')，换行会截断提示词，
+    // 提示词里的 shell 元字符还会被执行。headless 支持 `-` 从 stdin 读 task。
+    const args = ['--profile', this.options.profile, 'headless', '--json', '-']
     const child = spawn(this.options.bin, args, {
       env: { ...process.env, ...this.options.env },
-      stdio: ['ignore', 'pipe', 'pipe'],
+      stdio: ['pipe', 'pipe', 'pipe'],
       shell: true,
     })
+    child.stdin.end(request.prompt)
```

回归验证：`node packages/gateway/scripts/e2e-wake.ts`（里面本来就断言提示词全量送达）。

## 本次唤醒的环境状态（未恢复）

- `pwsh`：任何命令都在沙箱挂载阶段失败 `SetNamedSecurityInfoW failed (Win32 5): grantWrite(D:\DSH-ForLife)`；
  升级 `danger-full-access` 会要求审批，headless 无审批通道 ⇒ fail closed。
- `glob`：全部 30s 超时。
- `list_wakes`：schema 校验失败（缺 `value.ok` / `value.rows`）⇒ 列不出、也取消不了触发器。
- 可用：`read` / `write` / `grep` / `now` / 记忆类。

## 2026-10-07 10:20 更新（状态）

上面那段"未改动代码"**已经过时**：建议改法已落地。

- `packages/gateway/src/driver.ts` 现在固定传 `headless --json -`，提示词走 `child.stdin.end(request.prompt, 'utf8')`，
  `stdio` 的 stdin 已从 `'ignore'` 改成 `'pipe'`（文件头注释里也把这次的坑写下来了）。
- **仍未验证**：`node packages/gateway/scripts/e2e-wake.ts` 一次都没跑过 —— 本机 `pwsh` 仍然在沙箱挂载阶段失败
  （`SetNamedSecurityInfoW failed (Win32 5): grantWrite(D:\DSH-ForLife)`），提权要审批、headless 无审批通道 ⇒ fail closed。
- **生效前提是重启 gateway 进程**：2026-10-07 10:19 收到的唤醒依然只有第一行，说明跑着的网关还是旧行为。

## 2026-10-07 10:20 补充：`-` 这条命令行契约在**已安装的 dsh 源码**里核实过

（不是只看 README，而是读的这台机器上真正会跑的那份代码。）

- `…\@deepseek-ai\dsh\node_modules\@deepseek-ai\dsh-headless\lib\index.js:300`：
  `const task = config.task === void 0 || config.task === "-" ? await internals.readStdin() : config.task`
  ⇒ `-` 确实会被换成"把 stdin 读完当 task"。
- `…\dsh-headless\lib\startup.js:76`：`-` **必须是唯一的位置参数**，
  否则报 `error: \`-\` must be the only task argument` —— 建议改法的 args
  （`--profile <p> headless --json -`）恰好满足（位置参数只有 `-` 一个）。
- 因此 stdin 改法在 CLI 层是**符合契约**的；唯一还没做的仍是跑一遍
  `node packages/gateway/scripts/e2e-wake.ts` 做端到端回归（本机 `pwsh` 不可用）。

## 2026-10-07 10:20 补充：那波"启动 headless"风暴的来源

`.runtime\admin.log` 第 12 行起可以看到成因：QQ 连接状态来回翻转
（`QQ 连接恢复了` → `QQ 端断开` → `QQ 端已连接`）会在**每次变化**时触发
system 唤醒，日志里紧跟着**一长串** `启动 headless：dsh --profile forlife-headless headless --json …`。
也就是说：**触发器本身是正常的业务事件**（掉线/恢复各唤醒一次），
真正让这些唤醒"醒来没事干"的是上面的提示词截断 —— 两者叠加才表现为"空唤醒风暴"。

另外，第 13 行把一条**旧账**结掉了：
`唤醒「复查运行时故障是否恢复（timer）：触发器没有绑定会话（scope=*），无处唤醒`
—— 那是 2026-10-06 22:46 我自己排的 2 小时复查唤醒，到点时因为 `scope=*` 无处投递，
**没有产生任何副作用**（此前记的"可能排了个查不出来的触发器"可以销案）。

## 2026-10-07 10:39 更正：**上面那个"建议改法"本身是错的**（差一点就按它改）

上面第 48–64 行的 diff（以及 10:20 那条"`-` 符合契约"的核实）都写成了
`args = ['--profile', <p>, 'headless', '--json', '-']`。**那个 `headless` 不是子命令。**
启动器里 `dsh <name>` 只是 `--profile <name>` 的缩写（`dsh/lib/bin.js:128`：
`first !== void 0 && !first.startsWith("-") && first !== "plugin" ? ["--profile", ...argv] : argv`），
所以 `--profile <p> headless` 会让 headless 应用把 `headless` 当成**任务位置参数**：

- `dsh-headless/lib/startup.js:76-79`：`program.args = ['headless']` ⇒ `task = 'headless'`
- `dsh-headless/lib/index.js:300`：`config.task !== void 0` ⇒ **不读 stdin**

⇒ stdin 里那整段提示词被整段忽略，模型只收到一个词「headless」。
这就是 2026-10-07 10:2x 之后每一轮唤醒的注入文本。

**正确的 args 只有一个位置参数都没有**：`['--profile', this.options.profile, '--json']`
（`program.args.length === 0` ⇒ `task = undefined` ⇒ 读 stdin）。
已按此修改 `packages/gateway/src/driver.ts`，并新增
`packages/gateway/test/driver.test.ts` 把 args 的精确值钉死 —— 本来就不该靠"跑一遍看结果"来发现它。

两个仍待人工/待重启的卡点没变：`pwsh` 依旧 `Win32 5`（跑不了测试、也重启不了 gateway）；
gateway 重启后这条修复才生效。
