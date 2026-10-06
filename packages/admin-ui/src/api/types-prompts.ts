/**
 * 「提示词」接口返回类型 —— `GET /api/admin/prompts` 的契约。
 *
 * 逐字段镜像 `packages/gateway/src/admin/queries-model.ts` 里提示词相关的接口
 * （`PromptsOverview` / `PromptSlotOverview` / `PromptRevisionOverview` / `PromptOverrideOverview`）。
 *
 * 三条必须记住的语义（写错了界面就会误导人）：
 *  - **"没有生效版本"表现为整个键缺席**（`activeRevisionId` / `updatedAt` 不存在），
 *    而不是空串 —— 面板据此显示"未设置"，而不是显示一个看起来像版本号的空值；
 *  - `updatedAt` 是**生效版本写出来的时间**，不是"最近一次改动"：
 *    `prompt_revisions` 没有 `activated_at` 列，回滚（把旧版重新置为 active）不会让它变新；
 *  - `textPreview` 是服务端截断后的前 300 字符，只够用来"看清结构与语气"，
 *    不能拿它当当前生效文本去做 diff 或保存。
 */

/** 一个槽位的当前状态（面板上的槽位卡）。 */
export interface PromptSlotOverview {
  /** 槽位标识，如 `p1-system` / `p2-style`。 */
  readonly slug: string
  /** 生效版本 id；**没有生效版本时整个键缺席**。 */
  readonly activeRevisionId?: string
  /** 生效版本的 token 数；没有生效版本时是 0。 */
  readonly tokenCount: number
  /** 生效版本**规范化文本**的哈希；没有生效版本时是空串。 */
  readonly sha256: string
  /** 生效版本的**写入**时间（回滚不会刷新它，见文件头）。 */
  readonly updatedAt?: string
  /** 该 slug 的历史版本总数（**不受列表条数限制影响**）。 */
  readonly revisionCount: number
  /** 生效文本的前 300 字符（没有生效版本时是空串）。 */
  readonly textPreview: string
}

/** 一版历史提示词。 */
export interface PromptRevisionOverview {
  readonly id: string
  readonly slug: string
  readonly tokenCount: number
  /** `admin` | `model` | `system`。 */
  readonly createdBy: string
  readonly createdAt: string
  /** 这一版是不是当前生效版本（每个 slug 至多一版生效）。 */
  readonly active: boolean
  /** 保存时填的备注；没填时整个键缺席。 */
  readonly note?: string
  /** 文本里用到的变量名（服务端解析 `variables` JSON 列，坏数据给空数组）。 */
  readonly variables: readonly string[]
}

/** 一条按会话覆盖（`prompt_overrides` 一行；主键 `(scope, slug)`）。 */
export interface PromptOverrideOverview {
  /** `group:88888` / `private:10001` / `*`。 */
  readonly scope: string
  readonly slug: string
  /** 被指定的版本 id —— 与「版本历史」里的 `id` 对得上。 */
  readonly revisionId: string
  readonly createdBy: string
  readonly createdAt: string
}

/** 「提示词」板块的完整载荷。 */
export interface PromptsOverview {
  readonly slots: readonly PromptSlotOverview[]
  readonly revisions: readonly PromptRevisionOverview[]
  readonly overrides: readonly PromptOverrideOverview[]
  readonly stats: {
    readonly slots: number
    /** **全表计数**，不受列表条数限制影响 —— 与 `revisions` 数组长度不是一回事。 */
    readonly revisions: number
    readonly overrides: number
    /** 生效版本（active）的 token 之和：每轮都要带上的前缀成本。 */
    readonly totalTokens: number
  }
}
