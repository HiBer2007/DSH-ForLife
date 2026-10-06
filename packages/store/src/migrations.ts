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

/**
 * 迁移 5：QQ 集成的数据模型（PLAN §八）。
 *
 * 字段出处逐条标注：
 *  - §8.4「会话键：(platform, chat_id, thread_id?)」⇒ `qq_sessions.conversation_key` 就是这三段的规范化；
 *  - §8.4「队列：SQLite 表 + 轮询」「崩溃恢复：队列与处理状态持久化」⇒ `qq_inbox` 带 processed/attempt/error；
 *  - §8.2「轮次生命周期」⇒ `qq_turns`（一轮的输入、输出、耗时、token、工具调用次数）；
 *  - §8.3「挂起时不提交、不追加中期记忆」⇒ `qq_turns.status` 含 `deferred`；
 *  - §2.17.2 唤醒条件矩阵（用户拍板）⇒ `wake_rules` 每个条件**独立**一行，不派生；
 *  - §2.17.3 有界待读池 ⇒ `pending_messages`；
 *  - §2.17.6 状态通道 ⇒ `status_state`（source = model/system，system 不可被静默覆盖）。
 */
const m0005 = {
  version: 5,
  name: '0005_qq',
  sql: `
-- ── 会话（§8.4 的会话键）──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS qq_sessions (
  conversation_key TEXT PRIMARY KEY,     -- platform:chat_id[:thread_id]
  platform         TEXT NOT NULL,        -- onebot11
  chat_id          TEXT NOT NULL,
  thread_id        TEXT,
  kind             TEXT NOT NULL,        -- private | group | temp
  title            TEXT,
  last_message_at  TEXT,
  last_read_at     TEXT,
  created_at       TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_qq_sessions_kind ON qq_sessions (kind, last_message_at);

-- ── 入站队列（§8.4：先落库再处理，崩溃可恢复）────────────────────────────
CREATE TABLE IF NOT EXISTS qq_inbox (
  id               TEXT PRIMARY KEY,
  conversation_key TEXT NOT NULL,
  platform_msg_id  TEXT,
  sender_id        TEXT,
  sender_name      TEXT,
  is_group         INTEGER NOT NULL DEFAULT 0,
  is_self          INTEGER NOT NULL DEFAULT 0,
  mentioned_me     INTEGER NOT NULL DEFAULT 0,
  mentioned_all    INTEGER NOT NULL DEFAULT 0,
  is_poke          INTEGER NOT NULL DEFAULT 0,
  media_kind       TEXT,                 -- image | file | NULL
  text             TEXT NOT NULL DEFAULT '',
  payload          TEXT NOT NULL,        -- 原始事件 JSON（可回放）
  at               TEXT NOT NULL,        -- 事件时间（UTC）
  received_at      TEXT NOT NULL,
  processed        INTEGER NOT NULL DEFAULT 0,
  merged_into      TEXT,                 -- 被合并进哪一轮（防抖合并的证据）
  attempt          INTEGER NOT NULL DEFAULT 0,
  error            TEXT
);

CREATE INDEX IF NOT EXISTS idx_qq_inbox_pending ON qq_inbox (processed, conversation_key, at);
CREATE INDEX IF NOT EXISTS idx_qq_inbox_conv ON qq_inbox (conversation_key, at);

-- ── 轮次（§8.2 生命周期 + §8.3 挂起）─────────────────────────────────────
CREATE TABLE IF NOT EXISTS qq_turns (
  id               TEXT PRIMARY KEY,
  conversation_key TEXT NOT NULL,
  status           TEXT NOT NULL,        -- running | done | failed | deferred
  started_at       TEXT NOT NULL,
  ended_at         TEXT,
  session_id       TEXT,                 -- DSH 会话 id（多会话单窗口下多个会话共用一个窗口）
  model            TEXT,
  input_ids        TEXT NOT NULL DEFAULT '[]',
  tokens_in        INTEGER NOT NULL DEFAULT 0,
  tokens_out       INTEGER NOT NULL DEFAULT 0,
  tool_calls       INTEGER NOT NULL DEFAULT 0,
  defer_reason     TEXT,
  defer_until      TEXT,
  error            TEXT
);

CREATE INDEX IF NOT EXISTS idx_qq_turns_status ON qq_turns (status, started_at);
CREATE INDEX IF NOT EXISTS idx_qq_turns_conv ON qq_turns (conversation_key, started_at);

-- ── 出站记录（§2.17.9 送达确认 + 去重）──────────────────────────────────
CREATE TABLE IF NOT EXISTS qq_outbox (
  id               TEXT PRIMARY KEY,
  conversation_key TEXT NOT NULL,
  platform_msg_id  TEXT,
  kind             TEXT NOT NULL,        -- text | image | file | sticker | notice | mention_all
  payload          TEXT NOT NULL,
  sent_at          TEXT NOT NULL,
  confirmed        INTEGER NOT NULL DEFAULT 0,
  confirmed_at     TEXT,
  error            TEXT
);

CREATE INDEX IF NOT EXISTS idx_qq_outbox_conv ON qq_outbox (conversation_key, sent_at);
CREATE INDEX IF NOT EXISTS idx_qq_outbox_unconfirmed ON qq_outbox (confirmed, sent_at);

-- ── 唤醒条件矩阵（§2.17.2：**每个条件独立**，不派生）────────────────────
CREATE TABLE IF NOT EXISTS wake_rules (
  scope            TEXT NOT NULL,        -- '*' | private:ID | group:ID
  condition        TEXT NOT NULL,        -- private_message | group_mention | group_mention_all | ...
  enabled          INTEGER NOT NULL DEFAULT 1,
  probability      INTEGER NOT NULL DEFAULT 100,   -- 0-100
  min_interval_ms  INTEGER NOT NULL DEFAULT 0,
  daily_limit      INTEGER NOT NULL DEFAULT 0,     -- 0 = 不限
  quiet_until      TEXT,
  updated_by       TEXT NOT NULL DEFAULT 'system', -- system | model | admin
  updated_at       TEXT NOT NULL,
  PRIMARY KEY (scope, condition)
);

-- 每次判定都留痕：为什么唤醒/为什么不唤醒（面板与排障的命根子）
CREATE TABLE IF NOT EXISTS wake_events (
  id               TEXT PRIMARY KEY,
  scope            TEXT NOT NULL,
  condition        TEXT NOT NULL,
  conversation_key TEXT,
  decision         TEXT NOT NULL,        -- wake | skip
  reason           TEXT NOT NULL,        -- disabled | probability | quiet_hours | rate_limit | budget | matched
  roll             REAL,                 -- 概率判定的随机数（可复算）
  at               TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_wake_events_at ON wake_events (at);
CREATE INDEX IF NOT EXISTS idx_wake_events_scope ON wake_events (scope, condition, at);

-- ── 有界待读池（§2.17.3）────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS pending_messages (
  id               TEXT PRIMARY KEY,
  scope            TEXT NOT NULL,
  conversation_key TEXT NOT NULL,
  sender_name      TEXT,
  summary          TEXT NOT NULL,
  at               TEXT NOT NULL,
  read             INTEGER NOT NULL DEFAULT 0,
  read_at          TEXT
);

CREATE INDEX IF NOT EXISTS idx_pending_unread ON pending_messages (read, at);
CREATE INDEX IF NOT EXISTS idx_pending_scope ON pending_messages (scope, at);

-- ── 状态通道（§2.17.6）──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS status_state (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  source      TEXT NOT NULL,             -- model | system
  state       TEXT NOT NULL,             -- online | away | busy | custom
  text        TEXT,
  reason      TEXT,                      -- 系统状态的原因（不可被静默覆盖）
  since       TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS status_presets (
  key        TEXT PRIMARY KEY,           -- failure | degraded | offline ...
  text       TEXT NOT NULL,
  updated_by TEXT NOT NULL DEFAULT 'system',
  updated_at TEXT NOT NULL
);
`,
  up(db: DatabaseSync): void {
    db.exec(m0005.sql)
  },
} as const

const m0005Checksum = createHash('sha256').update(m0005.sql).digest('hex')

/**
 * 迁移 6：把 `qq_outbox` 变成**动作队列**。
 *
 * ## 为什么需要状态列
 *
 * 架构事实：**工具在 DSH 进程里执行，发送在网关进程里执行**，两者共享同一个 SQLite 文件
 * （这正是阶段 1 选 WAL + busy_timeout 的原因）。于是需要一张"意图 → 认领 → 发送 → 确认"
 * 的队列：模型调 `qq_reply` 只是**入队**，网关认领后才真的发出去，发完回填平台消息 id。
 * 工具的"送达确认"（§2.17.9 的 3 秒窗口）就是等这一行的状态变化。
 *
 * `status` 的取值：`pending`（等认领）→ `sending`（已认领）→ `sent`（平台已确认）/ `failed`。
 * 用 `PRAGMA table_info` 做守卫，保证迁移可重入。
 */
const m0006 = {
  version: 6,
  name: '0006_outbox_queue',
  sql: `
-- 这两条 ALTER 由 up() 里的守卫按需执行（SQLite 不支持 ADD COLUMN IF NOT EXISTS）
`,
  up(db: DatabaseSync): void {
    const columns = new Set(
      (db.prepare('PRAGMA table_info(qq_outbox)').all() as unknown as { name: string }[]).map((c) => c.name),
    )
    if (!columns.has('status')) {
      db.exec("ALTER TABLE qq_outbox ADD COLUMN status TEXT NOT NULL DEFAULT 'pending'")
    }
    if (!columns.has('claimed_at')) {
      db.exec('ALTER TABLE qq_outbox ADD COLUMN claimed_at TEXT')
    }
    if (!columns.has('attempt')) {
      db.exec('ALTER TABLE qq_outbox ADD COLUMN attempt INTEGER NOT NULL DEFAULT 0')
    }
    if (!columns.has('source')) {
      // 谁发起的：model（工具）/ system（系统通知）/ admin（后台测试发送）
      db.exec("ALTER TABLE qq_outbox ADD COLUMN source TEXT NOT NULL DEFAULT 'model'")
    }
    db.exec('CREATE INDEX IF NOT EXISTS idx_qq_outbox_status ON qq_outbox (status, sent_at)')
  },
} as const

const m0006Checksum = createHash('sha256').update(m0006.sql).digest('hex')

/**
 * 迁移 7：`qq_outbox` 记住**会话类型**。
 *
 * §8.4 的会话键是 `platform:chat_id[:thread_id]`，**不含 kind**。于是出站时无法从键本身
 * 判断该用 `send_group_msg` 还是 `send_private_msg` —— 早期版本在这里猜了个默认值，
 * 结果群消息被当成私聊发出去（真实世界里就是"群里没人收到、某个人莫名收到一条"）。
 * 所以 kind 必须作为一等属性存下来。
 */
const m0007 = {
  version: 7,
  name: '0007_outbox_conversation_kind',
  sql: `
-- ALTER 由 up() 守卫执行（SQLite 不支持 ADD COLUMN IF NOT EXISTS）
`,
  up(db: DatabaseSync): void {
    const columns = new Set(
      (db.prepare('PRAGMA table_info(qq_outbox)').all() as unknown as { name: string }[]).map((c) => c.name),
    )
    if (!columns.has('conversation_kind')) {
      db.exec("ALTER TABLE qq_outbox ADD COLUMN conversation_kind TEXT NOT NULL DEFAULT 'private'")
    }
  },
} as const

const m0007Checksum = createHash('sha256').update(m0007.sql).digest('hex')

/**
 * 迁移 8：后台「对话」通道（铁律 2 的另一半）。
 *
 * 用户原话："人类发送消息保留到后台的一个区域，**是唯一直接向模型发送人类消息的位置**。"
 *
 * 所以这张表就是那个唯一的入口：
 *  - `role='human'` 的行只能由后台页面写入（来源 `forlife:admin`，带 actor）；
 *  - `role='model'` 的行只能由网关在轮次结束后写入（模型的回复）；
 *  - `handled` 标记该条人类消息是否已经被送进模型（网关消费后置 1）。
 *
 * 与 QQ 消息的区别不是"能说什么"，而是**可信度与审计要求**：面板里的人类消息
 * 必须能回答"谁在什么时候说了什么、模型是什么时候看到的"。
 */
const m0008 = {
  version: 8,
  name: '0008_admin_chat',
  sql: `
CREATE TABLE IF NOT EXISTS admin_chat (
  id         TEXT PRIMARY KEY,
  role       TEXT NOT NULL,             -- human | model
  actor      TEXT,                      -- human 时的管理员标识
  text       TEXT NOT NULL,
  at         TEXT NOT NULL,
  handled    INTEGER NOT NULL DEFAULT 0,-- human 行：是否已送进模型
  turn_id    TEXT,                      -- 关联的轮次（可追溯"这次回复对应哪次输入"）
  error      TEXT                       -- 轮次失败时的原因（面板要看得见）
);

CREATE INDEX IF NOT EXISTS idx_admin_chat_at ON admin_chat (at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_chat_pending ON admin_chat (role, handled, at);
`,
  up(db: DatabaseSync): void {
    db.exec(m0008.sql)
  },
} as const

const m0008Checksum = createHash('sha256').update(m0008.sql).digest('hex')

/**
 * 迁移 9：提示词版本与覆盖（阶段 4）。
 *
 * 用户硬要求："**系统提示词、回答风格提示词必须可以编辑**"。
 * 可编辑就必须可追溯、可回滚 —— 否则改坏一次就再也回不去，
 * 而提示词是**影响模型行为最直接**的东西（比记忆改动影响更大）。
 *
 * 设计要点：
 *  - `sha256` 存的是**规范化之后**的哈希（规范化规则见 memory-core/prompt-text.ts）。
 *    存原始文本的哈希会让"只改了行尾空格"也算一版，回滚列表很快就没法看了。
 *  - `active` 唯一：每个 slug 同时只有一版生效。用部分唯一索引保证（SQLite 支持）。
 *  - `prompt_overrides` 做**按会话覆盖**，但注意它是给"尾部注入"用的：
 *    写进稳定前缀会让多会话单窗口下每轮都换前缀（缓存全废）。
 */
const m0009 = {
  version: 9,
  name: '0009_prompt_revisions',
  sql: `
CREATE TABLE IF NOT EXISTS prompt_revisions (
  id           TEXT PRIMARY KEY,
  slug         TEXT NOT NULL,           -- p1-system | p2-style
  text         TEXT NOT NULL,           -- 规范化后的文本
  sha256       TEXT NOT NULL,           -- 规范化文本的哈希
  token_count  INTEGER NOT NULL DEFAULT 0,
  variables    TEXT NOT NULL DEFAULT '[]', -- 用到的变量（面板要显示）
  note         TEXT,
  created_by   TEXT NOT NULL DEFAULT 'admin', -- admin | model | system
  created_at   TEXT NOT NULL,
  active       INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_prompt_revisions_slug ON prompt_revisions (slug, created_at DESC);
-- 每个 slug 至多一版 active
CREATE UNIQUE INDEX IF NOT EXISTS idx_prompt_revisions_active ON prompt_revisions (slug) WHERE active = 1;

CREATE TABLE IF NOT EXISTS prompt_overrides (
  scope       TEXT NOT NULL,            -- group:88888 / private:10001 / *
  slug        TEXT NOT NULL,            -- 目前只允许覆盖 p2-style（P1 是全局人设，不该按会话分裂）
  revision_id TEXT NOT NULL,
  created_by  TEXT NOT NULL DEFAULT 'admin',
  created_at  TEXT NOT NULL,
  PRIMARY KEY (scope, slug)
);
`,
  up(db: DatabaseSync): void {
    db.exec(m0009.sql)
  },
} as const

const m0009Checksum = createHash('sha256').update(m0009.sql).digest('hex')

/**
 * 迁移 10：缓存用量（阶段 4 交付物 6）。
 *
 * 数据来自宿主的 `assistant/message` 事件（`usage: TokenUsage`）。
 * 四类 token 互不重叠（已在 `dsh-token-meter` 的 `usageTokens()` 里核实）：
 * `inputTokens` 是**未命中**的输入，`cacheRead/cacheWrite` 分别是被读与写入缓存的量。
 * 所以"提示词总 token = input + cacheRead + cacheWrite"，命中率按这个分母算。
 *
 * `miss_reason` 允许事后回填：归因要等压缩/编辑事件都落库了才算得准。
 */
const m0010 = {
  version: 10,
  name: '0010_cache_metrics',
  sql: `
CREATE TABLE IF NOT EXISTS cache_metrics (
  id                 TEXT PRIMARY KEY,
  session_id         TEXT,
  turn               INTEGER,
  step               INTEGER,
  at                 TEXT NOT NULL,
  input_tokens       INTEGER NOT NULL DEFAULT 0,  -- 未命中的输入
  output_tokens      INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens  INTEGER NOT NULL DEFAULT 0,  -- 命中缓存读到的
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,  -- 写进缓存的
  reasoning_tokens   INTEGER,
  source             TEXT NOT NULL DEFAULT 'session', -- session | compaction
  miss_reason        TEXT,                        -- first-call | compaction | prompt-edit | unexplained
  note               TEXT
);

CREATE INDEX IF NOT EXISTS idx_cache_metrics_at ON cache_metrics (at DESC);
CREATE INDEX IF NOT EXISTS idx_cache_metrics_session ON cache_metrics (session_id, at DESC);
CREATE INDEX IF NOT EXISTS idx_cache_metrics_unexplained ON cache_metrics (cache_read_tokens, miss_reason);
`,
  up(db: DatabaseSync): void {
    db.exec(m0010.sql)
  },
} as const

const m0010Checksum = createHash('sha256').update(m0010.sql).digest('hex')

/**
 * 迁移 11：时间读数与漂移遥测（阶段 4 交付物 7/9）。
 *
 *  - `time_readings`：每一次给模型的权威读数。有了它才能回答验收里的两个问题：
 *    "最新读数的年龄是多少"、"压缩后/唤醒后/长空闲后**是不是真的**都有一条新鲜读数"。
 *  - `time_drift`：从模型输出里抓到的**时间表述与真实时间的偏差**。
 *    这把"时间幻觉"从感觉变成可看的曲线 —— 用户要的正是"可测"，否则改完不知道有没有变好。
 */
const m0011 = {
  version: 11,
  name: '0011_time_readings',
  sql: `
CREATE TABLE IF NOT EXISTS time_readings (
  id           TEXT PRIMARY KEY,
  session_id   TEXT,
  conversation_key TEXT,
  at           TEXT NOT NULL,          -- 读数时刻（UTC ISO）
  reason       TEXT NOT NULL,          -- turn-first | interval | date-boundary | after-compaction | after-wake | after-idle | manual
  timezone     TEXT NOT NULL,
  text         TEXT NOT NULL,          -- 实际注入给模型的文本（可回放）
  token_count  INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_time_readings_at ON time_readings (at DESC);
CREATE INDEX IF NOT EXISTS idx_time_readings_session ON time_readings (session_id, at DESC);
CREATE INDEX IF NOT EXISTS idx_time_readings_reason ON time_readings (reason, at DESC);

CREATE TABLE IF NOT EXISTS time_drift (
  id           TEXT PRIMARY KEY,
  session_id   TEXT,
  at           TEXT NOT NULL,          -- 发现时刻
  claimed      TEXT NOT NULL,          -- 模型说的时间表述
  claimed_at   TEXT,                   -- 解析出来的时刻
  actual_at    TEXT NOT NULL,          -- 真实时刻
  drift_ms     INTEGER,                -- 偏差（正 = 模型说的时间偏晚）
  excerpt      TEXT,                   -- 上下文片段（便于人判断是不是误报）
  severity     TEXT NOT NULL DEFAULT 'info' -- info | warn | bad
);

CREATE INDEX IF NOT EXISTS idx_time_drift_at ON time_drift (at DESC);
CREATE INDEX IF NOT EXISTS idx_time_drift_severity ON time_drift (severity, at DESC);
`,
  up(db: DatabaseSync): void {
    db.exec(m0011.sql)
  },
} as const

const m0011Checksum = createHash('sha256').update(m0011.sql).digest('hex')

/**
 * 迁移 12：三层时区的按会话设置（阶段 4 交付物 8，§2.16）。
 *
 * 用户拍板的三层：`systemTimezone`（**记录一律 UTC**）/ `conversationTimezone`（怎么理解）/
 * `displayTimezone`（给人看）。这张表存第二层的**按会话覆盖**。
 *
 * `source` 的优先级是验收项：「`user_set > model_note > 小模型建议`」。
 * 建议单独一张表且**带 pending 标记**：低置信度的小模型判断只能写建议，
 * 不能直接改 —— 改错会让这个会话的**所有**时间表述都错，而人未必立刻发现。
 */
const m0012 = {
  version: 12,
  name: '0012_conversation_clocks',
  sql: `
CREATE TABLE IF NOT EXISTS conversation_clock_settings (
  scope       TEXT PRIMARY KEY,        -- group:88888 / private:10001 / *
  timezone    TEXT NOT NULL,
  hour24      INTEGER NOT NULL DEFAULT 1,
  source      TEXT NOT NULL,           -- user_set | model_note | small_model_suggest | default
  reason      TEXT,
  updated_by  TEXT NOT NULL DEFAULT 'model',
  updated_at  TEXT NOT NULL
);

-- 待确认的时钟建议：低置信度判断只能写这里，等人确认或出现更多证据
CREATE TABLE IF NOT EXISTS clock_suggestions (
  scope       TEXT PRIMARY KEY,
  timezone    TEXT NOT NULL,
  confidence  TEXT NOT NULL,           -- high | medium | low
  origin      TEXT NOT NULL,           -- model | small_model | heuristic
  reason      TEXT,
  created_at  TEXT NOT NULL
);
`,
  up(db: DatabaseSync): void {
    db.exec(m0012.sql)
  },
} as const

const m0012Checksum = createHash('sha256').update(m0012.sql).digest('hex')

/**
 * 迁移 13：路由表、路由日志与不确定案例（阶段 5 交付物 5/10）。
 *
 * - `model_routes`：**有序**候选表。排序不是装饰：它是"自动降级"的唯一依据
 *   （主选没额度/挂了就按 rank 往后走），所以 `(role, rank)` 唯一。
 * - `routing_log`：每次决策一行，含"谁判的、置信度、是否升档、是否降级、落在哪条路由"。
 *   复盘时才能回答"为什么这次用了弱模型"。
 * - `uncertain_cases`：低置信度且**新出现**的案例（模型路由.MD §6.2）。
 *   刻意**不实时调用 L3 复盘** —— 那会破坏"极致快速"的目标，所以只落库、定期批处理。
 */
const m0013 = {
  version: 13,
  name: '0013_routing',
  sql: `
CREATE TABLE IF NOT EXISTS model_routes (
  id               TEXT PRIMARY KEY,
  role             TEXT NOT NULL,        -- L1 | L2 | L3 | vision | embedding | scorer | subagent
  rank             INTEGER NOT NULL,     -- 同一 role 内越小越优先
  provider         TEXT NOT NULL,
  model            TEXT NOT NULL,
  reasoning_effort TEXT,                 -- low | medium | high
  enabled          INTEGER NOT NULL DEFAULT 1,
  note             TEXT,
  updated_by       TEXT NOT NULL DEFAULT 'system',
  updated_at       TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_model_routes_role_rank ON model_routes (role, rank);

CREATE TABLE IF NOT EXISTS routing_log (
  id              TEXT PRIMARY KEY,
  at              TEXT NOT NULL,
  session_id      TEXT,
  turn_id         TEXT,
  tier            TEXT NOT NULL,
  source          TEXT NOT NULL,         -- guard | scorer | heuristic
  rule            TEXT,                  -- 守卫规则名
  backend         TEXT,                  -- 评分后端
  confidence      REAL NOT NULL DEFAULT 1,
  escalated       INTEGER NOT NULL DEFAULT 0,
  degraded        INTEGER NOT NULL DEFAULT 0,
  degrade_reason  TEXT,
  latency_ms      INTEGER NOT NULL DEFAULT 0,
  provider        TEXT,
  model           TEXT,
  reasoning_effort TEXT,
  route_rank      INTEGER,
  skipped         TEXT,                  -- JSON：被跳过的候选与原因
  switched        INTEGER NOT NULL DEFAULT 0,
  switch_reason   TEXT,
  note            TEXT
);

CREATE INDEX IF NOT EXISTS idx_routing_log_at ON routing_log (at DESC);
CREATE INDEX IF NOT EXISTS idx_routing_log_tier ON routing_log (tier, at DESC);

CREATE TABLE IF NOT EXISTS uncertain_cases (
  id            TEXT PRIMARY KEY,
  at            TEXT NOT NULL,
  text_excerpt  TEXT NOT NULL,
  tier          TEXT NOT NULL,
  confidence    REAL NOT NULL,
  backend       TEXT,
  status        TEXT NOT NULL DEFAULT 'pending',  -- pending | reviewed
  review_note   TEXT,
  suggestion    TEXT,
  reviewed_at   TEXT
);

CREATE INDEX IF NOT EXISTS idx_uncertain_status ON uncertain_cases (status, at DESC);
`,
  up(db: DatabaseSync): void {
    db.exec(m0013.sql)
  },
} as const

const m0013Checksum = createHash('sha256').update(m0013.sql).digest('hex')

/**
 * 迁移 14：推理端点目录与模式切换审计（阶段 5 交付物 2）。
 *
 * - `inference_endpoints`：统一端点抽象（§2.13.2 末）。上层的评分器/视觉/嵌入/子代理
 *   都只依赖这张表描述的东西，**不关心模型在哪、用什么硬件跑**。
 * - `endpoint_mode_audit`：每次模式切换尝试一行（含幂等跳过与失败回滚）。
 *   为什么要记"没切成的"：排障时最关键的问题往往是"为什么它没切过去"。
 */
const m0014 = {
  version: 14,
  name: '0014_inference_endpoints',
  sql: `
CREATE TABLE IF NOT EXISTS inference_endpoints (
  id             TEXT PRIMARY KEY,
  type           TEXT NOT NULL,     -- local | remote-selfhost | cloud-api | host-native
  mode           TEXT NOT NULL,     -- resident | on-demand | remote-api | host-native
  backend        TEXT NOT NULL,     -- cpu | cuda | rocm | vulkan | sycl
  base_url       TEXT NOT NULL,
  api_key_ref    TEXT,              -- **只存引用**，绝不存明文
  arch           TEXT,              -- x64 | arm64
  deploy_target  TEXT,              -- local-docker | remote-ssh | external-api
  deploy_host    TEXT,              -- 外挂目标机（留痕：这个端点部署在哪台机器上）
  container_name TEXT,
  model_root     TEXT,
  models         TEXT NOT NULL DEFAULT '[]',  -- JSON：能力位（含 image / contextLength / reasoningEfforts / embeddingDimensions）
  limits         TEXT,              -- JSON
  health_ok      INTEGER,
  health_checked_at TEXT,
  health_latency_ms INTEGER,
  effective_backend TEXT,           -- **实际生效的后端**（有些镜像会静默回落到 CPU）
  health_note    TEXT,
  enabled        INTEGER NOT NULL DEFAULT 1,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_endpoints_type ON inference_endpoints (type, enabled);

CREATE TABLE IF NOT EXISTS endpoint_mode_audit (
  id          TEXT PRIMARY KEY,
  at          TEXT NOT NULL,
  endpoint_id TEXT NOT NULL,
  from_mode   TEXT NOT NULL,
  to_mode     TEXT NOT NULL,
  actor       TEXT NOT NULL,        -- auto | admin | api | system
  reason      TEXT,
  ok          INTEGER NOT NULL,
  note        TEXT
);

CREATE INDEX IF NOT EXISTS idx_mode_audit_endpoint ON endpoint_mode_audit (endpoint_id, at DESC);
`,
  up(db: DatabaseSync): void {
    db.exec(m0014.sql)
  },
} as const

const m0014Checksum = createHash('sha256').update(m0014.sql).digest('hex')

/**
 * 迁移 15：图片描述缓存与视觉调用计数（阶段 5 交付物 8，§2.7.2）。
 *
 * 两张表各解决一个验收项：
 * - `image_descriptions`：按 `attachmentId`（`sha256:<64hex>`，内容寻址）缓存描述。
 *   **同一张图重复出现 ⇒ 第二次 0 次视觉调用**（验收项）。
 * - `vision_call_log`：每次真的调用了视觉模型就记一行 ——
 *   "视觉调用计数"这条验收要能数得出来，而不是靠感觉。
 *
 * `ocr_text` 单独存一列（不塞进 description）：因为 OCR 是**提示不是结论**，
 * 上层要能区分"模型看到的画面"与"OCR 认出来的字"，
 * 才能在重要字段（金额/时间/命令/人名）上要求视觉复核。
 */
const m0015 = {
  version: 15,
  name: '0015_image_descriptions',
  sql: `
CREATE TABLE IF NOT EXISTS image_descriptions (
  attachment_id TEXT PRIMARY KEY,     -- sha256:<64hex>（内容寻址 ⇒ 天然去重）
  scene         TEXT NOT NULL,        -- 画面内容
  ocr_text      TEXT,                 -- 文字（OCR）：**提示，不是结论**
  uncertain     TEXT,                 -- 不确定之处（模型自己说的）
  description   TEXT NOT NULL,        -- 拼好的完整描述（注入用）
  provider      TEXT,
  model         TEXT,
  vision_calls  INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS vision_call_log (
  id            TEXT PRIMARY KEY,
  at            TEXT NOT NULL,
  attachment_id TEXT NOT NULL,
  provider      TEXT,
  model         TEXT,
  reason        TEXT NOT NULL,        -- bridge | verify-important-fields | tool
  ok            INTEGER NOT NULL DEFAULT 1,
  latency_ms    INTEGER,
  note          TEXT
);

CREATE INDEX IF NOT EXISTS idx_vision_calls_at ON vision_call_log (at DESC);
CREATE INDEX IF NOT EXISTS idx_vision_calls_attachment ON vision_call_log (attachment_id, at DESC);
`,
  up(db: DatabaseSync): void {
    db.exec(m0015.sql)
  },
} as const

const m0015Checksum = createHash('sha256').update(m0015.sql).digest('hex')

/**
 * 迁移 16：端点探测日志（阶段 5 交付物 7 的"一键试跑"）。
 *
 * 为什么单独一张表：试跑结果**不是**模式切换，塞进 `endpoint_mode_audit` 是错的
 * （我第一版那么干过，结果查了一个不存在的列，面板直接 500）。
 * 两类事件的语义完全不同：一个是"改了运行模式"，一个是"测了一下健不健康"。
 *
 * `models_json` 存这次探到的模型列表 —— 用来发现"这个端点其实还有别的模型"
 * （以及验证模型发现机制真的在工作）。
 */
const m0016 = {
  version: 16,
  name: '0016_endpoint_probes',
  sql: `
CREATE TABLE IF NOT EXISTS endpoint_probe_log (
  id          TEXT PRIMARY KEY,
  at          TEXT NOT NULL,
  endpoint_id TEXT NOT NULL,
  model       TEXT,
  ok          INTEGER NOT NULL,
  latency_ms  INTEGER,
  note        TEXT,
  models_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_probe_endpoint ON endpoint_probe_log (endpoint_id, at DESC);
`,
  up(db: DatabaseSync): void {
    db.exec(m0016.sql)
  },
} as const

const m0016Checksum = createHash('sha256').update(m0016.sql).digest('hex')

/**
 * 迁移 17：管理后台鉴权（EXECUTION_PLAN §2.12）。
 *
 * 三张表各管一件事，刻意分开：
 *  - `admin_credential`：**单行**口令记录。用 scrypt 加盐哈希，绝不存明文，
 *    也不用 MD5/SHA（那是 AstrBot 明确踩过的坑，见计划 §1.3「我们避这 5 条」）。
 *    参数（N/r/p/keylen）一起存，将来调参时旧记录仍可校验、可平滑升级。
 *  - `admin_sessions`：只存**服务端随机生成的会话 id**，不存口令也不存其派生值。
 *    带过期时间与最后活动时间：过期会话会被顺手清理，"在线设备"也看得见。
 *  - `admin_audit`：登录、登出、改口令、限流、敏感操作全部留痕（含**失败**）。
 *    安全事件没有审计就等于没有证据。
 */
const m0017 = {
  version: 17,
  name: '0017_admin_auth',
  sql: `
CREATE TABLE IF NOT EXISTS admin_credential (
  id          INTEGER PRIMARY KEY CHECK (id = 1),  -- 单行表：只有一个管理口令
  algo        TEXT NOT NULL,                       -- 目前只有 scrypt
  salt        TEXT NOT NULL,                       -- hex
  hash        TEXT NOT NULL,                       -- hex
  cost_n      INTEGER NOT NULL,
  block_size  INTEGER NOT NULL,
  parallel    INTEGER NOT NULL,
  key_length  INTEGER NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS admin_sessions (
  id           TEXT PRIMARY KEY,
  created_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  ip           TEXT,
  user_agent   TEXT
);

CREATE INDEX IF NOT EXISTS idx_admin_sessions_expires ON admin_sessions (expires_at);

CREATE TABLE IF NOT EXISTS admin_audit (
  id      TEXT PRIMARY KEY,
  at      TEXT NOT NULL,
  action  TEXT NOT NULL,   -- setup | login | login_failed | logout | password | rate_limited | api
  ok      INTEGER NOT NULL,
  actor   TEXT,            -- 会话 id 前 8 位，或 anonymous
  ip      TEXT,
  path    TEXT,
  detail  TEXT
);

CREATE INDEX IF NOT EXISTS idx_admin_audit_at ON admin_audit (at DESC);
`,
  up(db: DatabaseSync): void {
    db.exec(m0017.sql)
  },
} as const

const m0017Checksum = createHash('sha256').update(m0017.sql).digest('hex')

/**
 * 迁移 18：表情库与私有媒体库（PLAN 阶段六）。
 *
 * ## 两张表为什么分开
 *
 * - `sticker_assets`：**文件本身**（sha256、大小、来源、是否我们自己收藏的）。
 * - `sticker_descriptions`：**对它的理解**（描述、情绪标签、由哪个模型生成）。
 *
 * 分开的理由是**省钱主线**：同一个表情第二次出现时，指纹（sha256）命中
 * ⇒ 直接复用描述，**0 次视觉调用**。如果把描述塞进 assets 表，
 * "复用"就退化成"重新生成一遍再覆盖"，省钱这件事就没法保证。
 *
 * ## 几个关键列
 *
 * - `sha256` **唯一**：这就是去重与指纹复用赖以生效的约束。没有它，
 *   "重复下载不新增行"这条验收过不了。
 * - `ours`：别人发的陌生表情我们**能学**（存下来、生成描述），
 *   但**默认不主动转发**（用户明确要求）。这个标记就是那条界线。
 * - `scopes`：在哪些会话见过（JSON 数组，累积）。用来回答"这个表情在哪个群流行"。
 * - `use_count` / `last_used_at`：LRU 淘汰的依据。
 * - `source_url`：联网抓来的来源要留痕（审计 + 白名单校验的依据）。
 */
const m0018 = {
  version: 18,
  name: '0018_stickers',
  sql: `
CREATE TABLE IF NOT EXISTS sticker_assets (
  id            TEXT PRIMARY KEY,
  -- 内容指纹：去重与"零视觉调用复用"的唯一依据
  sha256        TEXT NOT NULL UNIQUE,
  kind          TEXT NOT NULL DEFAULT 'image',   -- image | sticker | file
  mime          TEXT NOT NULL,
  size_bytes    INTEGER NOT NULL,
  width         INTEGER,
  height        INTEGER,
  -- 存储位置：本地路径或 blob 键（不存二进制进库）
  storage_path  TEXT NOT NULL,
  -- 来源：manual（手动）| search（联网抓取）| self-made（自造）| learned（学别人的）
  source        TEXT NOT NULL,
  source_url    TEXT,
  -- 是不是"我们自己的"表情（false = 学来的，默认不主动转发）
  ours          INTEGER NOT NULL DEFAULT 1,
  -- 在哪些会话见过（JSON 数组，累积）
  scopes        TEXT NOT NULL DEFAULT '[]',
  use_count     INTEGER NOT NULL DEFAULT 0,
  last_used_at  TEXT,
  status        TEXT NOT NULL DEFAULT 'active',  -- active | rejected | evicted
  reject_reason TEXT,
  created_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sticker_assets_use ON sticker_assets (ours, status, last_used_at);
CREATE INDEX IF NOT EXISTS idx_sticker_assets_source ON sticker_assets (source, created_at DESC);

CREATE TABLE IF NOT EXISTS sticker_descriptions (
  id           TEXT PRIMARY KEY,
  asset_id     TEXT NOT NULL,
  -- 描述与情绪标签由视觉模型产出；标签是 JSON 数组
  description  TEXT NOT NULL,
  emotion_tags TEXT NOT NULL DEFAULT '[]',
  model        TEXT,
  token_count  INTEGER NOT NULL DEFAULT 0,
  -- 生成时间：配合 sha256 回答"这张图是什么时候被理解的"
  created_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sticker_desc_asset ON sticker_descriptions (asset_id);

-- 私有媒体库（用户明确要保存的图片/文件，与表情分开检索）
CREATE TABLE IF NOT EXISTS media_assets (
  id           TEXT PRIMARY KEY,
  sha256       TEXT NOT NULL UNIQUE,
  kind         TEXT NOT NULL,                 -- image | file
  mime         TEXT NOT NULL,
  size_bytes   INTEGER NOT NULL,
  storage_path TEXT NOT NULL,
  source_url   TEXT,
  -- 原始文件名与备注（用户保存时可能说明用途）
  original_name TEXT,
  note         TEXT,
  -- 并入长期记忆后的条目 id（recall_longterm 靠它命中）
  long_memory_id TEXT,
  conversation_key TEXT,
  created_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_media_assets_created ON media_assets (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_media_assets_long ON media_assets (long_memory_id);
`,
  up(db: DatabaseSync): void {
    db.exec(m0018.sql)
  },
} as const

const m0018Checksum = createHash('sha256').update(m0018.sql).digest('hex')

/**
 * 0019：把「QQ 消息是碎片化的」补进 P1 系统提示词（用户 2026-10-06 明确要求）。
 *
 * 为什么需要迁移：P1 是**播种**进 prompt_revisions 的（因为它是用户可编辑的），
 * 所以只改基线不会改变模型实际看到的内容 —— 已播种的那一版仍是旧的。
 *
 * 为什么不用整段替换：那会**抹掉用户可能做过的手工编辑**。
 * 这里只在缺失时插入（幂等），且插到「## 输出规范」之前 ——
 * 行为约束应排在输出格式前面。
 *
 * 这条要求的由来：用户指出 QQ 是碎片化对话，相邻几条消息往往是一个连贯意思。
 * 我们自己就因为把碎片消息拆开理解而读歪过两次，所以写成**明确指令**，
 * 而不是泛泛的「注意上下文」。
 */
const m0019 = {
  version: 19,
  name: '0019_p1_fragmented',
  sql: '',
  up(db: DatabaseSync): void {
    const SECTION = [
      '## 你收到的消息是碎片化的（重要）',
      '- QQ 是碎片化对话：**同一个人的相邻几条消息，很可能是一个连贯的意思**，不是几个独立请求。',
      '  常见形态：先发一句引子、再补一个条件、最后才说要求；或者一句话被拆成三四条发出来。',
      '- 所以回应之前，先把这段时间里对方发的消息**合起来读一遍**，理解成一个整体意图，再决定怎么答。',
      '- **不要**对每一条分别作答 —— 那会答非所问，也会显得没在听。',
      '  尤其注意：别把中间某一句单独拎出来当成一个完整任务。',
      '- 拿不准「这几条是不是一件事」时，**按是一件事来理解**；真的不确定，就用一句话问清楚。',
      '- 同理：你自己发消息时也可以分几条发，对方也会把它们当成一个整体。',
      '',
    ].join('\n')

    const rows = db
      .prepare("SELECT id, text FROM prompt_revisions WHERE slug = 'p1-system' AND active = 1")
      .all() as { id: string; text: string }[]

    for (const row of rows) {
      if (row.text.includes('## 你收到的消息是碎片化的')) continue
      const anchor = '## 输出规范'
      const next = row.text.includes(anchor)
        ? row.text.replace(anchor, `${SECTION}${anchor}`)
        : `${row.text}\n${SECTION}`
      db.prepare('UPDATE prompt_revisions SET text = ? WHERE id = ?').run(next, row.id)
    }
  },
} as const

const m0019Checksum = createHash('sha256').update(m0019.sql + m0019.name).digest('hex')

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
  {
    version: m0005.version,
    name: m0005.name,
    checksum: m0005Checksum,
    up: m0005.up,
  },
  {
    version: m0006.version,
    name: m0006.name,
    checksum: m0006Checksum,
    up: m0006.up,
  },
  {
    version: m0007.version,
    name: m0007.name,
    checksum: m0007Checksum,
    up: m0007.up,
  },
  {
    version: m0008.version,
    name: m0008.name,
    checksum: m0008Checksum,
    up: m0008.up,
  },
  {
    version: m0009.version,
    name: m0009.name,
    checksum: m0009Checksum,
    up: m0009.up,
  },
  {
    version: m0010.version,
    name: m0010.name,
    checksum: m0010Checksum,
    up: m0010.up,
  },
  {
    version: m0011.version,
    name: m0011.name,
    checksum: m0011Checksum,
    up: m0011.up,
  },
  {
    version: m0012.version,
    name: m0012.name,
    checksum: m0012Checksum,
    up: m0012.up,
  },
  {
    version: m0013.version,
    name: m0013.name,
    checksum: m0013Checksum,
    up: m0013.up,
  },
  {
    version: m0014.version,
    name: m0014.name,
    checksum: m0014Checksum,
    up: m0014.up,
  },
  {
    version: m0015.version,
    name: m0015.name,
    checksum: m0015Checksum,
    up: m0015.up,
  },
  {
    version: m0016.version,
    name: m0016.name,
    checksum: m0016Checksum,
    up: m0016.up,
  },
  {
    version: m0017.version,
    name: m0017.name,
    checksum: m0017Checksum,
    up: m0017.up,
  },
  {
    version: m0018.version,
    name: m0018.name,
    checksum: m0018Checksum,
    up: m0018.up,
  },
  {
    version: m0019.version,
    name: m0019.name,
    checksum: m0019Checksum,
    up: m0019.up,
  },
]

/** 最新 schema 版本。 */
export const LATEST_SCHEMA_VERSION = MIGRATIONS.reduce((max, m) => Math.max(max, m.version), 0)
















