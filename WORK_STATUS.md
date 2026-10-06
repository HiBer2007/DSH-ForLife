# 工作状态（断电前存档）

> 写于第 16 轮，用户提示即将断电、要求暂停。
> **这份文件是为了"下次打开就能接着干"** —— 不写的话，
> 下次会重新踩一遍这一轮踩过的坑。

---

## 一、当前**正在进行**的事（未完成，有明确断点）

### 修 `list_wakes` 的两个 bug（模型在真机上报出来的）

**改动已落盘但测试红了**，`packages/dsh-component/src/wake-tools.ts`：

| 改动 | 位置 | 状态 |
|---|---|---|
| schema 加 `prompt` | L295 | ✅ 已改 |
| render 去掉非空断言 `!` + 缺失处理 + 带 prompt | L310-322 | ✅ 已改 |
| execute 里回 `prompt: row.prompt` | L333 | ✅ 已改 |

- `pnpm typecheck` **干净**
- 但 `node --test packages/dsh-component/test/wake-tools.test.ts` **5 个用例红**
  - 失败的是 `schedule_wake` / `register_watcher` / `cancel_wake`
  - 错误是 `actual: undefined, expected: true`
  - **注意**：这些用例**与 `list_wakes` 无关** ⇒ 很可能是
    **测试用的假 `defineTool` 会校验 schema**，而我新加的
    `prompt: { type: 'string', required: true }` 让别的工具的输出校验挂了
  - **下一步**：先看那个假 `defineTool` 的实现，再决定是改 schema 还是改测试

**为什么这两个 bug 值得修**（模型原话）：
> **唤醒列表读不出来** —— `list_wakes` 工具本身报错（返回结构不符合它自己的声明）…
> **我查不到它对应哪件事。**

---

## 二、本轮（第 15-16 轮）的**重大突破**（已提交）

### 🎉 DSH 侧模型接入打通（`1dc3f65`）

```
$ dsh --profile forlife-headless headless --json "只回四个字：链路正常"
{"type":"final","text":"链路正常"}
```

**走过六道关**（每道都有真机报错，按顺序）：

| # | 报错 | 根因 |
|---|---|---|
| 1 | `MISSING_CREDENTIAL: deepseek-official` | DSH 默认走**内置** provider |
| 2 | `provider "amazon-bedrock" is already declared` | 用 `insert` 加新插件错了——**它已在 base bundle 里** |
| 3 | 仍报 deepseek-official | **providers 放错地方**：`config:` 是**组合**，provider 来自 **settings 文档** |
| 4 | `does not support reasoning effort "high"` | **档位必须显式声明** `reasoningEfforts` |
| 5 | `expected "off"\|"minimal"\|…` | DSH **没有 `none`**，项目的 none = DSH 的 **`off`** |
| 6 | `400 MissingSessionID` | OpenCode Go **强制 `x-opencode-session`** |

### 两条**关键机制**（别再走弯路）

1. **`settings.yaml`（harness home 下）会被导入一次**，
   然后 DSH 把它**投影进 profile 的 `cordis.patch.yml`**（`- id: llm-pi-ai` + providers）。
   **之后 patch 就是权威位置。**
2. **patch 的 id 必须用短名**（`llm-pi-ai` / `agent-default-model`），
   用完整包名 `@deepseek-ai/...` **匹配不上且静默无效** ——
   这是"改了没反应"的根源。

### 🎉 唤醒链路真机打通（`71b4f07`）

真机证据：
```
14:46:01 fired  reason: 错过的定时（已顺延）
         modelDid: 这次唤醒我处理不了，说明情况：**结论**：这是一个没有可执行内容的系统唤醒…
```

⇒ **唤醒 → 模型自主执行 → 自主判断并回报**这条链路**真的通了**。

**关键架构发现**：QQ 的每一轮是 gateway 起 `dsh headless` 子进程跑的
（`driver.ts:64`），**不是** web app 的会话 ⇒ 唤醒必须走 **gateway 自己的 driver**。

---

## 三、其他已提交的修复（本 goal 期间）

| 提交 | 内容 |
|---|---|
| `d8dfb62` | 🎯 **transport 构造函数丢掉 `onConnectionState`** —— 连接回调从未被调用的根因 |
| `4cd75f6` | 插件侧唤醒轮询器（`wake-poller.ts`） |
| `dd78cee` | gateway 派发器改成写队列 |
| `3325f0f` | `wake_requests` 表（迁移 0024）+ 认领/超时回收 |
| `d5311ce` | 🎉 唤醒桥端点真机打通（`/api/forlife/wake`） |
| `129cd5f` | 表情发送用宿主本地路径 ⇒ NapCat（Docker）读不到 |
| `8b65e2f` | **可移植性违规**：`start-admin.ps1` 没设 `DSH_HOME` |
| `400ba3e` | 接上三个 provider 密钥（GO/QQ/CL，都可用） |
| `6dcc596` | 面板总览显示 DSH 后端连接状态 |
| `c1475a7` | 手动端点探测接口 |

---

## 四、**密钥**（本机文件，已确认 gitignored）

| 文件 | key | 状态 |
|---|---|---|
| `.runtime/provider-key-GO.txt` | `oc_sk_d52d3e…` | ✅ 可用（**优先用**） |
| `.runtime/provider-key-QQ.txt` | `oc_sk_671f8f…` | ✅ 可用 |
| `.runtime/provider-key-CL.txt` | `sk-dCSxi4…` | ✅ 可用（**CL 最后用**） |

端点健康：**`连通（43 个模型）；额度充足（最低 monthly 剩 50%）`**

---

## 五、**未完成**的事（按优先级）

1. **修 `list_wakes` 的测试红**（见第一节）—— **断点在这里**
2. **验收① 完整跑一遍**：headless 驱动下等足时间（子进程启动慢，100 秒不够）
3. **验收③**：**绝不要再用 `docker stop`** —— 它会让 NapCat 掉登录要人工扫码。
   改用**假 WS 客户端**连 `:3010` 再断开（脚本 `packages/gateway/scripts/test-conn-callback.mjs`，
   需要带 **`Authorization: Bearer` 头**，不是 `?access_token=` query）
4. **把真机证据写进 `EXECUTION_PLAN`**（只勾有证据的）
5. **阶段 9 剩余六项**（交付物 2-7）

---

## 六、**环境现状**（下次开机先看这个）

- **NapCat**：容器 `forlife-qq-1` 在跑，**已登录**（OneBot ESTABLISHED）
- **DSH**：`:3080` 在跑（profile `forlife-web`），日志里有
  `✅ 唤醒桥端点已注册：/api/forlife/wake` + `唤醒轮询器已启动`
- **gateway**：`:8081` 在跑，**驱动 = headless**
- **启动方式**（必须用仓库脚本，不要内联）：
  - `pwsh -File D:\DSH-ForLife\.runtime\start-web.ps1`
  - `pwsh -File D:\DSH-ForLife\scripts\start-admin.ps1`
- **读日志要用 .NET UTF-8**（PowerShell 默认读会乱码）：
  ```powershell
  $fs=[System.IO.File]::Open('D:\DSH-ForLife\.runtime\admin.log','Open','Read','ReadWrite')
  $sr=New-Object System.IO.StreamReader($fs,[System.Text.Encoding]::UTF8); $t=$sr.ReadToEnd(); $sr.Close(); $fs.Close()
  ```

---

## 七、**踩过的坑清单**（这一轮新增的）

1. **`.mjs` 里写 TS 类型标注** ⇒ SyntaxError（第 3 次了）
2. **CRLF 陷阱**：多行 `\n` replace 静默不匹配 ——
   **连"回退验证"都会被它骗出假绿**（第一次回退没变红就是这个原因）
3. **ASCII 双引号 / 反引号** 在 `"…"` 或 `` `…` `` 里会破坏整条命令
4. **回退验证要外科式**（改条件 `if (false)`），
   不要**删行** —— 删多了会变成"编译失败"而不是"测试变红"
5. **`splice` 改对象字面量后必须回读那一段** ——
   我漏删了三行重复键（TS1117），还**把整个文件改坏过一次**（`content: text(...)` 被剥掉）
6. **`pwsh` 的 `$pid` 是只读自动变量**
7. **`node` 的 `fetch` 拿不到 DSH 的 cookie**，`Invoke-WebRequest` 可以

---

## 八、暂停时的工作树状态

- **未提交**：`packages/dsh-component/src/wake-tools.ts`（`list_wakes` 的修复，**测试红**）
- 最后一次提交：`1dc3f65`（DSH 侧模型接入打通）
- `.runtime/` 下有大量一次性脚本（`*.mjs`），**都不进 git**，可随时删
