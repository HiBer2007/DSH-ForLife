import { DatabaseSync } from 'node:sqlite'

const db = new DatabaseSync(':memory:')
console.log('sqlite_version:', db.prepare('select sqlite_version() v').get().v)

try {
  db.exec("create virtual table t using fts5(content, tokenize='unicode61')")
  db.exec("insert into t values ('qq bot 防抖 合并 策略')")
  db.exec("insert into t values ('qq 消息队列 延迟 优化')")
  const rows = db.prepare("select content, bm25(t) as score from t where t match ? order by score limit 5").all('防抖')
  console.log('FTS5 OK ->', rows)
  const rows2 = db.prepare("select content, bm25(t) as score from t where t match ? order by score limit 5").all('QQ')
  console.log('FTS5 CJK latin OK ->', rows2)
} catch (e) {
  console.log('FTS5 FAIL:', e.message)
}

console.log('loadExtension available:', typeof db.loadExtension)

// WAL + 多进程可用的基本设置探测
const file = process.argv[2]
if (file) {
  const f = new DatabaseSync(file)
  f.exec('pragma journal_mode=WAL')
  f.exec('pragma busy_timeout=5000')
  console.log('journal_mode:', f.prepare('pragma journal_mode').get())
  console.log('busy_timeout:', f.prepare('pragma busy_timeout').get())
  f.close()
}
db.close()
