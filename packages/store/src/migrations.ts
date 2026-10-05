/**
 * 迁移定义。
 *
 * 铁律：**字段与 PLAN.MD 原文一比一**。PLAN 里没有、但我们的设计需要的列，
 * 一律在注释里标 `[design]` 并写明出处，便于日后对照（`tests/fidelity` 守的是参数，
 * 这里靠代码评审 + 本注释守字段）。
 *
 * @module @forlife/store/migrations
 */
import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

/** 一条迁移。 */
export interface Migration {
  readonly version: number
  readonly name: string
  /** SQL 文本的 sha256 摘要：改了已发布的迁移必须能被发现。 */
  readonly checksum: string
  up(db: DatabaseSync): void
}

/** 迁移 1：PLAN.MD 定义的三张表 + 检索索引。 */
const m0001 = {
  version: 1,
  name: '0001_init',
  sql: `
-- ── 迁移账本 ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS schema_migrations (
  version    INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  applied_at TEXT NOT NULL,
  checksum   TEXT NOT NULL
);

-- ── 中期记忆（PLAN.MD §2.1 原文）────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS mid_memory_entries (
  id               TEXT PRIMARY KEY,
  entry_type       TEXT NOT NULL,               -- semantic / fragment
  content          TEXT,                        -- active 时保留原文
  summary          TEXT NOT NULL,
  entities         TEXT NOT NULL DEFAULT '[]',  -- JSON 数组
  token_count      INTEGER NOT NULL DEFAULT 0,
  window_offset    INTEGER NOT NULL,
  status           TEXT NOT NULL,               -- active / fragmented / archived
  fragmented_into  TEXT,                        -- 沉降后的 long_memory_id
  fragment_hint    TEXT,
  compaction_epoch INTEGER NOT NULL DEFAULT 0,
  source_short_ids TEXT NOT NULL DEFAULT '[]',
  created_at       TEXT NOT NULL,
  last_accessed_at TEXT,
  storage_tier     TEXT NOT NULL DEFAULT 'ssd', -- ssd / hdd
  -- [design] EXECUTION_PLAN §2.3：渲染缓存失效用的修订号
  revision         INTEGER NOT NULL DEFAULT 0,
  -- [design] EXECUTION_PLAN §2.17.5：统一记忆下的溯源标记（哪个群/谁/系统）
  source_scope     TEXT
);

CREATE INDEX IF NOT EXISTS idx_mid_epoch_status ON mid_memory_entries (compaction_epoch, status, window_offset);
CREATE INDEX IF NOT EXISTS idx_mid_offset ON mid_memory_entries (window_offset);
CREATE INDEX IF NOT EXISTS idx_mid_scope ON mid_memory_entries (source_scope);

-- ── 长期记忆（PLAN.MD §6.1 原文）────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS long_memory_entries (
  id               TEXT PRIMARY KEY,
  content          TEXT,
  summary          TEXT,
  entities         TEXT,
  embedding_id     TEXT,                        -- 向量索引 ID
  source_mid_ids   TEXT,                        -- 溯源：从哪些中期条目 promote
  storage_tier     TEXT,                        -- ssd / hdd
  status           TEXT,                        -- active / archived
  created_at       TEXT,
  last_accessed_at TEXT,
  -- [design] EXECUTION_PLAN §6.3/§9：沉降与淘汰策略需要访问计数
  access_count     INTEGER NOT NULL DEFAULT 0,
  -- [design] EXECUTION_PLAN §2.17.5：溯源
  source_scope     TEXT,
  -- [design] EXECUTION_PLAN §6.3：沉降到 HDD 后全文的归档位置
  archive_path     TEXT
);

CREATE INDEX IF NOT EXISTS idx_long_tier ON long_memory_entries (storage_tier, last_accessed_at);
CREATE INDEX IF NOT EXISTS idx_long_status ON long_memory_entries (status);

-- ── 压缩日志（PLAN.MD §4.5 原文）────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS compaction_log (
  id                   TEXT PRIMARY KEY,
  requested_by         TEXT,                    -- model / system
  approved             INTEGER,                 -- BOOLEAN
  reason_if_rejected   TEXT,
  short_tokens_before  INTEGER,
  turns_since_last     INTEGER,
  time_since_last      INTEGER,
  pushed_entries       TEXT,                    -- JSON 数组
  fragmented_entries   TEXT,
  kept_in_short_tokens INTEGER,
  model_used           TEXT,
  timestamp            TEXT NOT NULL,
  -- [design] EXECUTION_PLAN §4.2 Step5：压缩后预热缓存是否已执行
  cache_warmed         INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_compaction_ts ON compaction_log (timestamp);

-- ── 词法检索（[design] EXECUTION_PLAN §2.3：FTS5 + 向量混合检索的 FTS 侧）──
CREATE VIRTUAL TABLE IF NOT EXISTS mid_memory_fts USING fts5 (
  summary,
  content,
  entities,
  tokenize='unicode61'
);

CREATE VIRTUAL TABLE IF NOT EXISTS long_memory_fts USING fts5 (
  summary,
  content,
  entities,
  tokenize='unicode61'
);

-- ── 渲染修订号：全局单调计数（[design] §2.3 渲染缓存键的一部分）────────────
CREATE TABLE IF NOT EXISTS forlife_state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT OR IGNORE INTO forlife_state (key, value) VALUES ('render_revision', '0');
INSERT OR IGNORE INTO forlife_state (key, value) VALUES ('compaction_epoch', '0');
`,
  up(db: DatabaseSync): void {
    db.exec(m0001.sql)
  },
} as const

/** 迁移 SQL 的校验和（改了它就是改了历史，必须换新迁移）。 */
const m0001Checksum = createHash('sha256').update(m0001.sql).digest('hex')

/** 迁移 2：大工具结果的溢出存储（PLAN §3.2 的 `recall_full` 依赖它）。 */
const m0002 = {
  version: 2,
  name: '0002_spill',
  sql: `
-- 大工具结果：上下文里只留"前 N 行 + 摘要"，全文落在这里，模型可 recall_full(id) 取回。
-- 出处：PLAN.MD §3.2「大工具结果：写入时保留前 N 行 + 摘要，完整结果存日志」。
CREATE TABLE IF NOT EXISTS spill_entries (
  id           TEXT PRIMARY KEY,
  session_id   TEXT,
  tool_name    TEXT NOT NULL,
  tool_call_id TEXT,
  head         TEXT NOT NULL DEFAULT '',
  content      TEXT NOT NULL,
  byte_size    INTEGER NOT NULL,
  line_count   INTEGER NOT NULL,
  created_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_spill_session ON spill_entries (session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_spill_call ON spill_entries (tool_call_id);
`,
  up(db: DatabaseSync): void {
    db.exec(m0002.sql)
  },
} as const

const m0002Checksum = createHash('sha256').update(m0002.sql).digest('hex')

/**
 * 迁移 3：压缩事务（崩溃一致性）。
 *
 * 出处：EXECUTION_PLAN 阶段 2 交付物 6 —— "`compaction/start`/`compaction/end` 标记对
 * + 启动时按 epoch 校验回滚"。DSH 侧那对标记写在**会话日志**里（log-only），
 * 而我们的表改动（追加条目 / 碎片化 / epoch 推进）需要自己的可回滚记录：
 * 先写 `started` 行并带上**计划**，成功改 `committed`；启动时发现残留的 `started`
 * 就按计划回滚 —— 这就是"无半写条目"的实现方式。
 */
const m0003 = {
  version: 3,
  name: '0003_compaction_runs',
  sql: `
CREATE TABLE IF NOT EXISTS compaction_runs (
  id             TEXT PRIMARY KEY,
  compaction_id  TEXT,                 -- DSH 会话侧的 CompactionId（对账用）
  session_id     TEXT,
  phase          TEXT NOT NULL,        -- started | committed | aborted
  epoch_from     INTEGER NOT NULL,
  epoch_to       INTEGER,
  plan           TEXT NOT NULL,        -- JSON：本次要做的全部改动（回滚依据）
  detail         TEXT,                 -- JSON：实际结果
  error          TEXT,
  started_at     TEXT NOT NULL,
  ended_at       TEXT
);

CREATE INDEX IF NOT EXISTS idx_runs_phase ON compaction_runs (phase, started_at);
CREATE INDEX IF NOT EXISTS idx_runs_session ON compaction_runs (session_id, started_at);
`,
  up(db: DatabaseSync): void {
    db.exec(m0003.sql)
  },
} as const

const m0003Checksum = createHash('sha256').update(m0003.sql).digest('hex')

/**
 * 迁移 4：影响审计（"三写"的第三写，也是阶段 3 铁律 §2.17.7 的地基）。
 *
 * 用途：任何**会影响模型**的操作都要留一条可审计的影响记录 ——
 * 压缩对模型的影响是"它的中期记忆被改了、短期窗口被替换了"，
 * 这类影响必须与 `admin_actions`（阶段 3）用同一张表表达，面板才能统一呈现。
 */
const m0004 = {
  version: 4,
  name: '0004_effects',
  sql: `
CREATE TABLE IF NOT EXISTS effects (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,        -- compaction | settle | admin_action | wake | ...
  actor      TEXT NOT NULL,        -- system | model | admin
  subject    TEXT,                 -- 受影响对象（会话 id / 条目 id / 配置键）
  detail     TEXT NOT NULL,        -- JSON
  affects_model INTEGER NOT NULL DEFAULT 1,   -- 是否影响模型（决定要不要报告）
  reported   INTEGER NOT NULL DEFAULT 0,      -- 是否已向模型报告（铁律 1）
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_effects_kind ON effects (kind, created_at);
CREATE INDEX IF NOT EXISTS idx_effects_unreported ON effects (reported, affects_model, created_at);
`,
  up(db: DatabaseSync): void {
    db.exec(m0004.sql)
  },
} as const

const m0004Checksum = createHash('sha256').update(m0004.sql).digest('hex')

/** 全部迁移（升序）。 */
export const MIGRATIONS: readonly Migration[] = [
  {
    version: m0001.version,
    name: m0001.name,
    checksum: m0001Checksum,
    up: m0001.up,
  },
  {
    version: m0002.version,
    name: m0002.name,
    checksum: m0002Checksum,
    up: m0002.up,
  },
  {
    version: m0003.version,
    name: m0003.name,
    checksum: m0003Checksum,
    up: m0003.up,
  },
  {
    version: m0004.version,
    name: m0004.name,
    checksum: m0004Checksum,
    up: m0004.up,
  },
]

/** 最新 schema 版本。 */
export const LATEST_SCHEMA_VERSION = MIGRATIONS.reduce((max, m) => Math.max(max, m.version), 0)




