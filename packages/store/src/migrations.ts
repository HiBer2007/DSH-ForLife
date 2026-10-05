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

/** 全部迁移（升序）。 */
export const MIGRATIONS: readonly Migration[] = [
  {
    version: m0001.version,
    name: m0001.name,
    checksum: m0001Checksum,
    up: m0001.up,
  },
]

/** 最新 schema 版本。 */
export const LATEST_SCHEMA_VERSION = MIGRATIONS.reduce((max, m) => Math.max(max, m.version), 0)



