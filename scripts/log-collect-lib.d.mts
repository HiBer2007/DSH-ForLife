/**
 * `log-collect-lib.mjs` 的类型声明。
 *
 * ★ 为什么采集端是 `.mjs` 而不是 `.ts`：它**跑在宿主上**（读 `docker logs`），
 *   要能在"只有一个 node、没有构建链"的机器上直接 `node xxx.mjs` 跑起来。
 *   ⇒ 实现用 JS，类型用这份声明补上 —— 这样测试（`.ts`）里仍然有类型检查。
 */

/** 一条归一后的记录（与网关的 `LogRecord` 同形）。 */
export interface NormalizedRecord {
  readonly level: string
  readonly module: string
  readonly text: string
  readonly at: string
}

/** 七个等级。 */
export declare const LEVELS: readonly string[]

/** 容器名 → 模块名。 */
export declare const CONTAINER_MODULES: Readonly<Record<string, string>>

/** 剥掉 ANSI 颜色码（NapCat 的级别标记带色）。 */
export declare function stripAnsi(text: string): string

/** 从文本猜等级（猜不出 = `info`）。 */
export declare function guessLevelFromText(text: string): string

/** 读出 `[error]` 这类级别标记；没有则 `undefined`。 */
export declare function levelMarker(text: string): string | undefined

/** `MM-DD HH:MM:SS` 补年份成 ISO；认不出则 `undefined`。 */
export declare function stampToIso(stamp: string, now: Date): string | undefined

/** NapCat 一行 → 记录。 */
export declare function normalizeNapCatLine(line: string, now: Date): NormalizedRecord | undefined

/** Caddy 一行（JSON）→ 记录。 */
export declare function normalizeCaddyLine(line: string, now: Date): NormalizedRecord | undefined

/** DSH 宿主一行 → 记录。 */
export declare function normalizeDshLine(line: string, now: Date): NormalizedRecord | undefined

/** 按模块归一一行。 */
export declare function normalizeLine(module: string, line: string, now: Date): NormalizedRecord | undefined

/** 切批（每批不超过 `max`）。 */
export declare function toBatches(records: readonly NormalizedRecord[], max: number): NormalizedRecord[][]

/**
 * 选本次要发的窗口（**从最旧的开始**），并给出新游标与剩余条数。
 *
 * ★ 游标只推进到"真正发出去的最后一条"—— 见实现里的注释（真机踩过丢数据）。
 */
export declare function selectWindow(
  entries: readonly { record: NormalizedRecord; stamp: string | undefined }[],
  max: number,
): { window: NormalizedRecord[]; remaining: number; cursor: string | undefined }

/** 取 `docker logs --timestamps` 行首的时间戳（ISO）；没有则 `undefined`。 */
export declare function lineTimestamp(line: string): string | undefined

/** 去掉那个时间戳前缀。 */
export declare function stripTimestamp(line: string): string

/** 解析采集游标。 */
export declare function parseCursor(text: string): Record<string, string>

/**
 * ★ 这一行是不是**方块字符拼的图**（NapCat 的登录二维码）。
 *
 * 判据（与面板侧 `packages/admin-ui/src/lib/block-art.ts` 一致）：去空白后 ≥8 字符、方块占比 ≥60%。
 *
 * @param text - 一行日志。
 * @returns 是 ⇒ `true`。
 */
export function isBlockArtText(text: string): boolean