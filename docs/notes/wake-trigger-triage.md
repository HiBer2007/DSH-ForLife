# 唤醒触发器失控：判据、排查与处置

> 讲的是"怎么查、怎么停"，不是某次事故的经过（那次经过见 `docs/incidents/2026-10-06-empty-wake-storm.md`）。

## 现象

- 会话在没有任务的情况下被反复唤醒，注入文本为空、只有模板首行、或只有一个 `headless` 词；
- `list_wakes` 因输出契约问题报 schema 错时，触发器既列不出、也取消不掉。

## 判据

- **会话计数**：`.runtime\dsh\storages\session_projcache\sessions\` 下按 `"createdAt": <epoch 毫秒>` 统计。
  **只能匹配 `createdAt`** —— `lastMessageTime` / `lastInjectionTime` / `lastTurnInjectionTime` /
  `pendingTurnStart` 也会命中同一种模式，会把计数算虚高；位数要卡准（13 位毫秒），否则混进别的日期。
- **不要用注入的采样时间推断触发周期**：唤醒请求排队串行处理，注入时间戳可能比真实墙钟落后数分钟，
  "间隔恰好 2 分钟"这种规律可能只是时间戳滞后造成的假象。
- **排空积压的代价**：宿主重启后可能把积压的唤醒请求一次性放完（实测约 54 秒内新建 62 个 headless 会话，
  每个都跑完一整个 agent 轮次）。这种形态很烧钱，修复优先级应排在前面。

## 触发源

- **连接状态变化是正常的系统唤醒来源**：QQ 连接翻转（`QQ 端已连接` / `QQ 端断开`）会在每次变化时触发一次
  system 唤醒（`packages/gateway/src/runtime.ts` 的 `observeConnection`；事件文案见 `wake-events.ts`）。
  触发器本身是正常业务事件 —— 如果这些唤醒"醒来没事干"，要查的是**提示词投递**
  （见 `dsh-headless-task-contract.md`），不是触发器。
- 触发器持久化在 `.runtime\dsh\forlife\db\forlife.sqlite` 的 `wake_triggers` 表。库是二进制的，
  `grep` 读不出触发器正文；但事件表 `wake_trigger_events` 里的 **id 可以 grep 到** ——
  同一个 id 反复出现即可定位失控触发器。
- `scope=*` 的触发器**无处投递**，到点不产生副作用（日志会写"触发器没有绑定会话（scope=*），无处唤醒"）。

## 处置（顺序不能反）

1. **先看再取消**：`list_wakes` 列出触发器，确认哪条在反复触发，避免误删正常定时任务。
2. `cancel_wake <id>` 逐条取消；或走管理后台**全局暂停**（比逐条快）：
   - `GET /api/admin/wakes` —— 列表
   - `POST /api/admin/wake-pause {paused:true}` —— 一键暂停
   - `POST /api/admin/wake-toggle` / `POST /api/admin/wake-cancel` —— 逐条停用 / 取消
   - 默认端口 8081（env `FORLIFE_ADMIN_PORT`），需要后台口令。
     实现见 `packages/gateway/src/admin/api.ts`；调用示例见 `packages/gateway/scripts/e2e-wakes-api.ts`。
3. **headless 会话够不到管理 API**：`web_fetch` 拒绝非公网 IP（127.0.0.1）。
   `list_wakes` 坏掉时，grep `forlife.sqlite` 取 id 是可行的替代路径（只能取到 id，读不出触发器正文）。
4. **归因要留证据**：核对"最后一次会话的 `createdAt`"与"`cancel_wake` 调用时间"的先后。
   若停止**早于**取消，就不能把"风暴停止"记成"取消生效"，应另找原因（后台暂停 / 引擎自身收敛）。

## 行为约定（环境不可用时）

遇到不带 prompt 的系统唤醒：只做一次轻量确认，不重复探测工具、不逐次记流水、不动业务数据。

**不要用 `schedule_wake` 安排"稍后再查"**：工具故障时它的失败是**不可见**的
（即使真的写进库，返回的也是 schema 错），可能在库里留下一条反复触发的触发器，
而 `list_wakes` 列不出来、`cancel_wake` 也调不动。
