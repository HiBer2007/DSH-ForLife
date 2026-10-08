# 唤醒提示词投递契约：`dsh headless` 怎么拿 task

> 这是**不变量**：任务文本只能走 stdin，不能进 argv。两种错误写法各有特征性症状，可以据此反推。

## 链路

QQ 的每一轮唤醒都不是 web 会话，而是 gateway 起一个 `dsh headless` 子进程来跑
（`packages/gateway/src/driver.ts` 的 `HeadlessTurnDriver`）。
提示词由 `packages/gateway/src/wake-prompt.ts` 的 `buildWakePrompt()` 产出，**是多行文本**。

## 不变量

1. **提示词经 stdin 送入**：`args` 里不放任务位置参数，`stdio[0]` 为 `'pipe'`，
   由 `child.stdin.end(request.prompt, 'utf8')` 送入（子进程早退时写 stdin 会 EPIPE，需要吞掉，
   它不代表轮次失败）。
2. **`headless` 不是子命令**：启动器里 `dsh <name>` 只是 `--profile <name>` 的缩写
   （`@deepseek-ai/dsh/lib/bin.js`：首个不以 `-` 开头、且不是 `plugin` 的参数会被展开成 `--profile <name>`）。
   写成 `--profile <p> headless` 会让 headless 应用把 `headless` 当成**任务位置参数**。
3. **不要传 `-`**：`-` 确实表示"读 stdin"，但契约要求它是**唯一**的位置参数
   （`@deepseek-ai/dsh-headless/lib/startup.js` 会报 `` `-` must be the only task argument ``）。
   正确做法是**一个位置参数都不传**：`program.args.length === 0` ⇒ `task = undefined` ⇒ 读 stdin
   （`@deepseek-ai/dsh-headless/lib/index.js`：`config.task === void 0 || config.task === "-" ? readStdin() : config.task`）。
4. **多行文本不能过命令行**：`shell: true` 时 Node 只做 `[file, ...args].join(' ')`，**不做引号转义**；
   Windows 的 `cmd.exe` 把换行当命令分隔符 ⇒ 第一行成为 task，其余各行被当作**另一条命令**丢弃或报错。

## 症状对照（按模型实际收到的注入文本反推）

| 收到的注入文本 | 含义 |
|---|---|
| 只有模板第一行（`[系统唤醒] 这不是用户发来的消息……`） | 提示词被当成 argv 末位参数 + `shell: true`，在换行处被 cmd 截断 |
| 只有一个词 `headless` | args 里多了 `headless` 这个位置参数 ⇒ task 被认成 `headless` ⇒ stdin 整段被忽略 |

截断后丢掉的是提示词的后半段：`## 触发`（标题 / 类型 / 原因 / 会话 / 预算）、
`## 你当时要自己做的事`（触发器里的 prompt）、`## 上次醒来时你做了什么`、`## 触发内容`（payload）、
`## 该怎么做` —— 也就是唤醒轮**没有原因、没有任务、没有上次行动记录**，只能空转一次。

**丢失发生在投递环节，不在入队环节**：`wake_prompt` 入队的 text 本身是完整的。
所以查"唤醒为什么没内容"要从 gateway 的投递路径查，不要去翻触发器存储。

## 附带风险（安全）

prompt 里的字符会**进 shell**：payload 是 JSON（含 `{}` `"`），触发器标题或文件内容里只要有
`& | > ( ) ;` 就会被当命令执行。改走 stdin 同时消掉这个注入面。

## 怎么查 / 怎么修

- 把 args 的**精确值**钉死在测试里，不要靠"跑一遍看结果"发现：
  `packages/gateway/test/driver.test.ts` 已断言 args 精确值 + 多行提示词整段走 stdin。
- 端到端回归：`node packages/gateway/scripts/e2e-wake.ts`（脚本本身断言提示词全量送达）。
- 生效前提：**重启 gateway 进程**。宿主加载的是旧构建，"源码已改"不等于运行态已改。

## 权威出处（本机实际会跑的那份代码）

- `@deepseek-ai/dsh-headless/lib/index.js`：task 为 `void 0` 或 `-` 时读 stdin。
- `@deepseek-ai/dsh-headless/lib/startup.js`：`argument("[task...]", "the task text; multiple words are joined by spaces, and `-` reads stdin")`。
- `@deepseek-ai/dsh/lib/bin.js`：`dsh <name>` → `--profile <name>` 的展开规则。

> 行号会随依赖升级漂移，引用时以符号名（变量 / 函数）为准。
