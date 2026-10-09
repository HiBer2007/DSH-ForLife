# 审计：`forlife-*` 回合崩溃的根因 + "零生产调用"嫌疑名单逐条定性

> 2026-10-09 第二轮。所有结论都带**文件:行号**证据，可以自己核。
> 判据同前：**容器 healthy / 单测全绿 / `vue-tsc` 0 都可能是假象。**

---

## 一、根因：`agent/pre-step` 把瀑布链截断（★ 致命，已修）

### 症状

```
{"type":"status","phase":"turn_start","turn":1}
{"type":"status","phase":"turn_end","turn":1,"reason":
  {"kind":"error","error":{"message":"Cannot read properties of undefined (reading 'kind')","code":"UNKNOWN"}}}
```

stderr 只有一行、**没有堆栈**。组件启动完全正常（42 工具 / 6 提示段 / 压缩引擎 / 沉降循环全挂上了），
**只有"跑回合"这一条路断** —— 而 QQ 唤醒走的就是 headless。

### 怎么定位的（四步，每步都有决定性证据）

1. **对照实验**：内建 `headless`（空 patch）⇒ exit 0 输出 `Hi`；`forlife-headless` ⇒ exit 1
   ⇒ **在我们组件里**，不是 dsh、不是环境。
2. **`--patch` overlay 二分**：profile 在 Docker 卷 `dsh-home` 里（宿主 `/data/dsh` 看不到，
   要进容器），**改完立刻生效、不用重建镜像** ⇒ 二分成本极低。
   逐个摘：`time-context` / `forlife-compaction` / `llm-pi-ai` 都照崩，
   **摘 `forlife-memory` 就好** ⇒ 锁定在我们组件。
3. **拿堆栈**：dsh 把异常吞成 `{code:'UNKNOWN', message}` 的地方是
   `dsh-agent-loop/lib/index.js:993` 的 `catch (error)`（`errorChain(error)` 只取 message）。
   临时给那一行补一句 `console.error(error.stack)`（**容器内改，重建容器即自动还原**，
   脚本 `.runtime/patch-agent-loop-stack.cjs`，注意要 `docker exec -u root`）⇒
   ```
   TypeError: Cannot read properties of undefined (reading 'kind')
       at Object.<anonymous> (dsh-plan-mode/lib/index.js:155:17)
   ```
4. 读那一行：`if (decision.kind === "reject" || …)`，而 `decision = await next()`。
   ⇒ **`next()` 返回了 `undefined`**。

### 根因

`agent/pre-step` 是宿主的 **waterfall（瀑布）**事件：

- 派发点 `dsh-agent-loop/lib/index.js:911`：`await this.dispatch.waterfall("agent/pre-step", …)`
- 宿主里**每一个** `agent/pre-step` 监听器都长成 `(payload, next) => …`
  （`dsh-agent-instructions:1271`、`dsh-compaction-basic:839`、`dsh-plan-mode:152`、
  `dsh-repeat-tool-reminder:1591`、`dsh-session-reference:468` …）
- 最简形态见 `dsh-api-session-controller:2430`：`(payload, next) => 条件 ? Promise.resolve({kind:'…'}) : next()`

**我们原来写的是 `(payload) => { … }`：既不接 `next`、也不返回决定**
⇒ 瀑布在这一环断掉 ⇒ 上一个监听器拿到 `undefined` ⇒ plan-mode 抛 TypeError ⇒ **整轮失败**。

一句话：**一个"只是观察一下"的订阅，把整个 agent 跑回合的能力干掉了**，
而且症状（一开回合就 UNKNOWN）离原因（少了个 `next`）十万八千里。

### 宿主里的 waterfall 事件全清单（接这些必须传 `next`）

`agent/pre-step`、`agent/request`、`agent/request-error`、`compaction/summary-error`、
`connection/request`、`fs/edit-intent`、`fs/write-intent`、`internal/get`、`internal/set`、
`loader/patch-context`、`session-telemetry/record`、`user-questions/request`、
`workspace/session-activity`。

**通知式（`serial`/`emit`，不传 `next`）**：`agent/created`、`agent/turn-stopping`、
`session/event`、`agent/assistant-stream`。

我们只踩了 `pre-step` 一个。**同一个仓库里 `tool-spill.ts:327-348` 接
`tools/post-execute` 的写法是对的**（从 `args[2]` 取 `next`、调用、返回决定）
—— 所以不是"不会写"，是这一处漏了。

### 修法与验证

`model-router.ts` 的 pre-step 改成**只观察的瀑布中间件**：
先 `await next()` 拿决定（放在 `try` **外面** —— 后面的环节抛错必须能穿过去），
观察完把决定**一个字都不改**地返回。

- **回退验证**：注入"不返回决定" ⇒ **9 过 / 2 红**；还原 ⇒ **11 过 / 0 红**
- 新增 2 条回归守卫：钉"必须调用 `next()` 且原样返回"、"观察抛错也不能把决定吞掉"
- **真机三 profile 全过**：`forlife-headless` exit=0、`forlife-qq` exit=0（答"嗨"，
  推理里在考虑 `qq_reply` ⇒ QQ 工具是活的）、`forlife-web` 就是那个 healthy 的容器
- 提交 `c41ae37`

---

## 二、"零生产调用"嫌疑名单 —— 逐条定性

| 嫌疑 | 结论 | 证据 |
|---|---|---|
| `register_watcher` 生产调用数 = 0 | ❌ **旧结论错**：**已接线** | `index.ts:699` 调 `buildWakeTools(…, wakeToolHost(runtime))`；`index.ts:169` 的 `registerProgram` 写 `wake_programs`，gateway tick 消费 |
| ↑ 但它现在能用吗 | ⚠️ **不能** | `index.ts:170` 第一件事查 `FORLIFE_WORKSPACE_ROOT`，没配就返回「未配置…无法登记」。**生产容器里确实没有这个变量** ⇒ 必然拒绝（fail-loud，不是静默成功） |
| `defer_turn` 永久挂起（没有消费者） | ❌ **旧结论错**：有消费者 | `packages/gateway/src/driver.ts:156` 按名字特判处理 |
| `set_status` 只写不可见 | ❌ **旧结论错**：有读者 | `packages/gateway/src/status.ts:46`（`getStatus`）、`packages/dsh-component/src/qq-tools.ts:732`（读 `source`） |
| `pending_backlog` 没进 `WAKE_CONDITIONS` | ✅ 属实，**但已登记为刻意延后** | `backlog.ts:306` 写明理由与"等 `wake.ts` 腾出来后提升"；`qq-tools.ts:97` 用 `QQ_WAKE_CONDITIONS` 补位；守卫测试 `qq-tools-new.test.ts:167` 钉住当前状态 ⇒ **现在是可回收的技术债** |
| `readBacklog` / `readPending` 重复 | ✅ 属实，**但有据** | `backlog.ts:211-219`：`readPending` 只支持精确 `scope`，`readBacklog` 要支持"按类型筛选（所有群）"；有测试断言两者读同一批数据、结论相同 ⇒ 技术债非缺陷 |
| 后台积压通知没进 `buildTurnPrompt` | ✅ 属实，**已登记延后** | `gateway.ts:97-102` 写明"本来最自然的做法是在 `buildTurnPrompt` 里加一段 —— 但那属于 `turns.ts`… 等它腾出来后应当加一段（同样只报计数）" ⇒ **可回收** |
| `peer_input_status` 生产者没注册 | ⚠️ **半对** | 事件**早就有**：`onebot.ts:463` 归一出 `InboundEvent{type:'peer_input_status'}`，`gateway.ts:237` 也认它。**真卡点是"有意分流"**：`gateway.ts:231-246` 先 `recordTyping()` 写进 `forlife_state`（自带过期时刻，由 `read_pending` 现问现答），然后**直接 return**，从不进 `decideWake` —— 那段注释写明理由「正在输入是瞬时信号，不该进待办队列」。**但基线给它 25% 概率（`scheduler.ts:77`）、面板让人配它、分组里也列着它** ⇒ 两边对不上 |
| `sender.role` 没进提示词 | ✅ **属实，已修** | `onebot.ts:729` 抽、`transport.ts:94` 承载、**全仓再无第二个消费者** ⇒ 解析完就丢。修：`turns.ts` 把角色并进已有 flags（只在 owner/admin 时标；member 是绝大多数，标了会埋掉 @我/拍一拍）。回退验证 **15/1 红 → 16/0 绿**。提交 `90511ec` |

### 额外新发现

**`packages/dsh-component/src/router-hooks.ts` 是死模块**：
全仓**无人 import**（grep 只有它自己和 `index.ts` 里那句注释提到 `router-hooks`），
**也没有测试文件**。它文件头的注释写着"把自研回退链到宿主的 `agent/request-error` / `agent/request`"
—— **从来没接上线**。而这两个恰好都是 **waterfall** 事件，接的时候还得注意 `next`。
⇒ 要么接线、要么删掉，别让它继续以"看起来像实现了"的形态躺着。

---

## 三、开放项（需要人拍板，或需要下一轮做）

1. **`peer_input_status` 的唤醒策略**（两条都自洽，取决于"正在输入值不值得打断模型"）：
   - ① 从 `WAKE_CONDITIONS` 摘掉，承认它只是「记录 + 现问现答」
   - ② 真接进 `decideWake`（`recordTyping` 之后补一次唤醒判定）
   - 现状：`WAKE_CONDITION_PRODUCERS` 里写明了这个岔路口（`wake.ts` 的 `peer_input_status.waitingOn`）
2. **`router-hooks.ts`**：接线还是删掉
3. **`FORLIFE_WORKSPACE_ROOT`**：配上才能用 `register_watcher`（要选一个合适的沙箱根）
4. **人设不一致**：模型的推理里写着「system prompt 说我是团子，但记忆里角色是呆肥鱼」
5. **回收两处已登记的延后**：`pending_backlog` 提升进 `WAKE_CONDITIONS`、
   积压通知补进 `buildTurnPrompt`
6. **QQ 重新登录**后跑一次真实唤醒，把 `wake_programs` / `wake_triggers` / `wake_events` /
   `wake_requests` / `status_state` / `effects` / `long_memory_entries` / `spill_entries`
   这几张**全空的表**跑热（它们空着就说明这些链路还没被真实跑过一次）

---

## 四、操作教训

**全量测试不要与其他重活并发跑。** 这轮有一次全量跑出**几百条红**，看着像灾难性回归，
实际是我把 `node --test` 和一个镜像重建任务并发跑了：失败项的耗时全是 `0.02ms` 量级
（共享进程里被整体拖垮的典型形态）。**干净重跑 ⇒ 1708 / 1708 / 0**。
判据：**耗时不正常地整齐**，就是环境问题而不是代码问题。

---

## 五、⚠️ 已知 flaky：`cache-collector-wiring.test.ts` 的端到端那条

**这条没修 —— 因为抓不到稳定复现，而"修了但没法验证"等于没修。**

### 证据（都是同一份代码）

| 场景 | 结果 |
|---|---|
| 全量 1708 条（共享进程） | **红 1 条**：`★★★ 端到端：apply() 订阅了 session/event…`，耗时 **66.78ms** |
| 单独跑该文件，第 1 遍 | **红** |
| 单独跑该文件，第 2、3 遍 | 绿 |
| 单独跑该文件，连续 8 遍 | **8/8 绿** |
| 与 `cache-collector.test.ts` 一起跑 | 21/21 绿 |

⇒ 两次红都出现在**新进程的首次运行**（冷启动），之后再也复现不出来。
66.78ms 是**正常量级**（不是并发争用那种 0.02ms），所以它是一次**真实的失败**，
不是环境假象。

### 最可疑的一处（未证实）

`cache-collector-wiring.test.ts:114` 是 `await delay(30)` —— **写死等 30ms**，
等的是 `apply()` 里的异步初始化（建库 + 跑迁移 + 订阅）。
冷启动时（模块要现编译、SQLite 要建表）30ms 很可能不够。
**固定 sleep 等的是"猜一个够长的数"，轮询等的是"条件真的成立"** ——
真要修的话应该改成轮询（例如等到 `fake.events.includes('session/event')`，上限 2–3 秒）。

⚠️ 但**这只是最可疑，不是已证实**。没有稳定复现就没法做回退验证，
所以这一轮**刻意不动它** —— 记在这里，等能复现（或加日志抓到）再修。

### 为什么这条值得单独记一笔

项目的硬约束是「**提交前跑全量 `pnpm test`，以那次结果为准**」——
**门禁本身 flaky，这条约束就失效了**：一次假红会让人去查一个不存在的回归，
几次之后所有人都会开始忽略红。**flaky 测试是缺陷，不是噪音。**

