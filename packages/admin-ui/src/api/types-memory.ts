/**
 * 「压缩」板块的接口契约 —— `packages/gateway/src/admin/queries-memory.ts` 的**镜像**。
 *
 * ## 为什么要抄一份而不是直接 import 服务端类型
 *
 * gateway 跑在 Node 里（`node:sqlite`），admin-ui 跑在浏览器里，两边是各自独立的 tsconfig
 * 与构建图；跨包引 TS 源码会把服务端依赖扯进前端产物。更重要的是：抄一份意味着这是**前端自己的契约**——
 * 服务端多给字段无所谓，少给字段或悄悄改了可空性，必须在 vue-tsc 这一关就报错，
 * 而不是等到运行时模板上出现一个空白格子（空白既可能是"没有"也可能是"没写"，没人敢据此下结论）。
 * 改服务端形状时**先改这里**，两边都不会跑偏。
 *
 * ## 为什么全是 `type` 而不是 `interface`
 *
 * 字段定义和 gateway 那边一模一样，只有关键字不同 —— 这不是风格偏好，是 TS 的一条硬规则：
 * **隐式索引签名只给"对象字面量类型"（含 `type` 别名），不给 `interface`**。
 * 于是 `interface X {…}` 赋不给 `Record<string, unknown>`，`type X = {…}` 可以。
 * 而 DataTable 是泛型组件，列/行类型两个方向都会撞上这条规则
 * （`readonly X[] → readonly Record<string, unknown>[]`，以及列定义 `value` 参数的逆变检查），
 * 用 `interface` 时两种写法里总有一种过不了 vue-tsc，只能在调用方写 `as unknown as` 强转——
 * 那就等于把这一层的类型保护全关了。关键字换一下，换来的是干净的绑定。
 *
 * ## 可空字段写成 `?:` 而不是 `| null`
 *
 * gateway 侧对 NULL 的规矩是「**整个键缺席**」，不是给 `null`。逐条对齐过来就是：
 *  - `epochTo` 缺席 = 事务还没提交（**不能拿 0 当"没有"**：epoch 0 是合法值）；
 *  - `approved` 缺席 = 库里没记这一格，**不是** false——读成 false 等于替库下"被拒绝"的结论；
 *  - `endedAt` / `error` / `reasonIfRejected` / `modelUsed` 同理。
 * 所以镜像一律用 `readonly x?: T`：前端只判断一次 `=== undefined`，
 * 不必同时处理 null 与 undefined 两种"没有值"。
 *
 * ## 本文件只管压缩
 *
 * 记忆条目那部分（`MemoryEntryView` / `MemoryOverview`）不在这里：压缩与记忆是两块页面、
 * 两种刷新心态 —— 压缩是"出事了才来看"，记忆是"随时看一眼有多少"。
 */

/** `compaction_runs.phase` 的取值域（服务端 `CompactionPhase` 同域，store 只写这三个）。 */
export type CompactionPhase = 'started' | 'committed' | 'aborted'

/**
 * 一次压缩事务在面板上的样子（`compaction_runs` 一行）。
 *
 * 服务端**故意不投影** `plan` 列：它是回滚依据（要写清所有将被改动的 id，可能很大），
 * 对"发生了什么"没有展示价值。面板要看的是 `error` 与 `detailPreview`。
 */
export type CompactionRunView = {
  readonly id: string
  readonly phase: CompactionPhase
  readonly epochFrom: number
  /** 提交前不存在"目标 epoch"⇒ 整个键缺席。 */
  readonly epochTo?: number
  readonly startedAt: string
  readonly endedAt?: string
  readonly error?: string
  /** `detail`（JSON 文本）的前 200 码元，**仅供显示**：截断后的 JSON 解析不了，别想着 JSON.parse。 */
  readonly detailPreview?: string
}

/** 一条压缩决策日志（PLAN §4.5 的字段投影，`compaction_log` 一行）。 */
export type CompactionLogView = {
  readonly id: string
  readonly timestamp: string
  /** `model`（模型自己请求压缩）/ `system`（系统按压力触发）；列可空，没记录就缺席。 */
  readonly requestedBy?: string
  /** 缺席 = 库里没记录批没批，**不是** false。 */
  readonly approved?: boolean
  readonly reasonIfRejected?: string
  /** 这两列库里可空，但服务端按 0 处理（只有手工插入的行才会是 NULL），所以这里是非空 number。 */
  readonly shortTokensBefore: number
  readonly keptInShortTokens: number
  readonly modelUsed?: string
}

/** 压缩的累计与最近读数（顶部指标卡的数据源）。 */
export type CompactionStats = {
  readonly committed: number
  readonly aborted: number
  /**
   * 还停在 `started` 的事务数。
   *
   * 这个数 >0 是**报警信号**而不是普通统计：它意味着上一次压缩没走完就到了重启，
   * 启动回滚（`recoverPendingCompactions`）还没跑或没跑成功——库里可能残留半写条目。
   */
  readonly started: number
  /** 最近一次压缩**活动**的时间（含被拒绝与未完成的）；一次都没发生过时整个键缺席。 */
  readonly lastAt?: string
  /** 最近一行日志里的压缩前 / 后短期窗口 token；没有日志时两个键都缺席。 */
  readonly tokensBefore?: number
  readonly tokensAfter?: number
}

/** `GET /api/admin/compaction` 的响应（= 服务端 `CompactionOverview`，一一对应）。 */
export type CompactionOverview = {
  readonly runs: readonly CompactionRunView[]
  readonly log: readonly CompactionLogView[]
  readonly stats: CompactionStats
}
