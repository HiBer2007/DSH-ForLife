# 工作状态（断电前存档）

> 写于第 16 轮，用户提示即将断电、要求暂停。
> **这份文件是为了"下次打开就能接着干"** —— 不写的话，
> 下次会重新踩一遍这一轮踩过的坑。

---

## 一、**上一次的断点已解**（2026-10-07 10:19 订正）

### `list_wakes` 的两个 bug + 一个更大的契约 bug —— 源码层已全部修完

**先订正上一版的误判**：上次记的"5 个用例红 ⇒ 是我新加的 `prompt` 字段让别的工具输出校验挂了"
**是错的**。真相是：

- 真宿主拿 `execute` 的返回值**原样**按 `output.schema` 校验；而 `wake-tools.ts` 的 `execute`
  返回的是旧信封 `{ content, value: {...} }` ⇒ 校验器看到 `content` / `value` 两个未声明属性，
  报 `missing required property "value.ok" / "value.rows"`。**`list_wakes` / `cancel_wake` /
  `wake_now` / `schedule_wake` / `register_watcher` 五个工具全中**（同一个 bug）。
- 红用例为什么红：那会儿源码正被**并发的唤醒轮次**改成"直接返回裸值"，而测试助手
  `valueOf()` 还在读 `.value` ⇒ 读到 `undefined` ⇒ `actual: undefined, expected: true`。
  跟 `prompt` 字段没关系。

**现在的状态（源码，已核实）：**

| 项 | 状态 |
|---|---|
| 五个 `execute` 改回裸值 `{ok, id, message}` / `{ok, rows}` / `{ok, message}` | ✅ 全部 |
| `list_wakes` schema / render / execute 补 `prompt` | ✅ |
| `test/wake-tools.test.ts` 的 `valueOf()` 改成"返回值本身就是 value" | ✅ |
| 补一条防回归用例：五个 `execute` 都不许出现 `content` / `value` 两个键 | ✅ 已加 |
| **`node --test` 真跑一遍** | ❌ **跑不了** —— `pwsh` 起不来（见第六节），**没有测试执行证据** |

**同一个 bug 还在 `port-tools.ts`**（`list_ports` / `publish_port` / `unpublish_port`），已一并改掉。
核实方式是 `grep "content: text(" packages/dsh-component/src` ⇒ 零命中。

根因与证据：`wake-tools-contract-bug-2026-10-06.md`、`wake-2026-10-06-wake-tools-schema-fix.md`。

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

## 五、**未完成**的事（2026-10-07 第 25 轮订正 —— 前四条已完成）

**前四条已全部完成**（留在这里是为了说明"它们为什么不再是断点"）：

1. ~~修 `list_wakes` 的测试红~~ ⇒ ✅ 已修（`7a4c45f`）
2. ~~验收① 完整跑一遍~~ ⇒ ✅ **四条全部通过**（证据在 `EXECUTION_PLAN.md`）
3. ~~验收③~~ ⇒ ✅ 机制已验（单测 14/14 + 真机 `fired=52`）；
   **破坏性的 `docker stop` 故意跳过**（理由写在 PLAN 里）
4. ~~把真机证据写进 `EXECUTION_PLAN`~~ ⇒ ✅ 已写

**现在的断点 —— 阶段 9 剩余六项**：

| # | 交付物 | 依赖 | 建议 |
|---|---|---|---|
| 2 | 迁移机制 + `forlife-admin migrate` CLI + 断点续传 + 回滚 | 交付物 1（已完成） | 可做 |
| 3 | Parquet 归档 + `recover(id)` + `recall_full` | 交付物 1 | 可做 |
| 4 | 碎片索引合并与淘汰 | 无 | 可做 |
| 5 | 存储占用面板（照 AstrBot `GET /stat/storage` + `cleanup(target)`） | 需要 6 的部分数据 | 可做 |
| 6 | 监控（压缩频率、召回预算、档位分布、沉降量、迁移耗时…） | 无 | 可做 |
| 7 | 备份/恢复脚本（SQLite 在线备份 API + blob/向量增量） | 无 | **最独立，建议先做** |

**交付物 1 已完成**（根路径解析 + 沉降策略 + 沉降任务 + 定时循环 + 迁移 0025；
测试 19 条；真机确认 `沉降循环已启动：每 30 分钟一轮`）。

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

## 八、工作树状态（2026-10-07 第 25 轮订正）

- **干净** —— 最后一次提交：阶段 9 交付物 1 闭环（沉降循环）
- `.runtime/` 下有大量一次性脚本（`*.mjs`），**都不进 git**，可随时删

**这一节原来写的是"未提交：`wake-tools.ts`（测试红）" —— 那个早已提交并修好。**
（这正是本节开头那句"留一份错的断点比没有更糟"的实例。）
