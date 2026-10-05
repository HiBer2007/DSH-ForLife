/**
 * `@forlife/store` —— 记忆的持久层（自持 `node:sqlite`）。
 *
 * 为什么不用宿主的 `ctx.storageDomain`：它是 zod 域模型，**没有 SQL、没有 joins、没有迁移钩子**；
 * 而我们需要关系表、FTS5 与跨进程共享（网关与 DSH 同机读同一个库）。
 *
 * @module @forlife/store
 */
export { DEFAULT_DB_FILENAME, SCHEMA_VERSION, backupDatabase, currentVersion, migrationList, openDatabase } from './db.ts'
export type { OpenOptions, OpenedDatabase } from './db.ts'
export { LATEST_SCHEMA_VERSION, MIGRATIONS } from './migrations.ts'
export type { Migration } from './migrations.ts'
export {
  appendMidEntry,
  currentEpoch,
  currentRevision,
  fragmentMidEntry,
  getSpill,
  getLongEntry,
  getMidEntry,
  getState,
  insertLongEntry,
  insertSpill,
  lastSuccessfulCompaction,
  listCompactionLog,
  listRenderableMidEntries,
  listSettleCandidates,
  listSpills,
  markLongRecovered,
  markLongSettled,
  midStats,
  nowIso,
  recordCompaction,
  searchLongFts,
  searchMidFts,
  touchLongEntry,
  touchMidEntry,
  bumpEpoch,
} from './repository.ts'
export type {
  AppendMidInput,
  AppendMidResult,
  CompactionLogInput,
  LongEntryRow,
  MidEntryRow,
  MidStats,
  SpillRow,
} from './repository.ts'


