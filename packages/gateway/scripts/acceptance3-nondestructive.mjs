/**
 * 验收③：**非破坏性**地验证「QQ 断线 → system 触发 → 唤醒」以及**幂等**与**再次断线仍能触发**。
 *
 * ## 为什么不用 `docker stop forlife-qq-1`
 *
 * 上一轮我用它做过一次 —— **那个操作把 NapCat 的登录搞掉了，需要人工扫码**。
 * 对一个在跑的服务做破坏性操作，即使目的是测试，代价也不该由用户承担。
 *
 * ## 这个办法为什么不破坏任何东西
 *
 * gateway 的 OneBot 传输是**反向 WS**：谁连上 `:3010` 它就把谁当"QQ 端"
 * （`adopt()` 里明确写着"同一时刻只保留最新连接，旧的让位"）。
 *
 * 所以用假客户端连一下再断开，就能触发**与真实断线完全相同的那条回调路径** ——
 * 而 NapCat 不受影响（它按 `reconnectInterval: 3000` 自己连回来）。
 *
 * ## 它验什么（对应验收③的四条）
 *
 * 1. 断开 ⇒ 产生 system 触发（`qq.disconnected`）；
 * 2. **反复观察幂等** —— 同一状态多次观察只标记一次；
 * 3. 恢复 ⇒ 产生 `qq.reconnected` 触发；
 * 4. ★ **再次断线仍能触发** —— 这正是端到端台子抓到的那个真 bug
 *    （用 `observe` 传两个事件名的话，`qq.disconnected` 那一侧永远看不到"恢复"）。
 *
 * ## 鉴权
 *
 * `adopt()` 读的是 **`Authorization: Bearer` 头**，**不是** `?access_token=` query。
 * 用 query 会被判"鉴权失败"直接 close，而 `notifyConnection` 根本不会跑。
 */
import { readFileSync } from 'node:fs'

import { WebSocket } from 'ws'

import { openDatabase } from '../../store/src/db.ts'

const PORT = 3010
const TOKEN = readFileSync('D:/DSH-ForLife/.runtime/onebot-token.txt', 'utf8').trim()

const opened = openDatabase({ file: 'D:/DSH-ForLife/.runtime/dsh/forlife/db/forlife.sqlite' })
const db = opened.db

/** 读两个 system 触发器的 next_fire_at 与已触发次数。 */
const readTriggers = () => {
  const rows = db.prepare("SELECT title, next_fire_at, fire_count FROM wake_triggers WHERE kind = 'system' ORDER BY title").all()
  return {
    down: rows.find((r) => r.title.includes('掉线')) ?? null,
    up: rows.find((r) => r.title.includes('恢复')) ?? null,
    rows,
  }
}

/** 复位（模拟引擎已处理过，让下一次观察能重新标记）。 */
const reset = () => {
  db.prepare('UPDATE wake_triggers SET next_fire_at = NULL WHERE kind = \'system\'').run()
}

/** 连上再断开（或只连上）。 */
const connectThenClose = async (holdMs) => {
  const socket = new WebSocket(`ws://127.0.0.1:${String(PORT)}/`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  })
  await new Promise((resolve, reject) => {
    socket.on('open', () => resolve())
    socket.on('error', reject)
    setTimeout(() => reject(new Error('连接超时')), 5000)
  })
  await new Promise((r) => setTimeout(r, holdMs))
  socket.close()
  await new Promise((r) => setTimeout(r, 1500))
}

let pass = 0
let fail = 0
const check = (name, fn) => {
  try {
    fn()
    pass += 1
    console.log(`  ✓ ${name}`)
  } catch (error) {
    fail += 1
    console.log(`  ✗ ${name}\n     ${String(error).slice(0, 200)}`)
  }
}
const assert = (cond, msg) => {
  if (!cond) throw new Error(msg)
}

console.log('\n【0】前置：两个 system 触发器都在')
reset()
let st = readTriggers()
check('"掉线"触发器存在', () => assert(st.down !== null, '找不到"掉线"触发器'))
check('"恢复"触发器存在', () => assert(st.up !== null, '找不到"恢复"触发器 —— 需要先重建'))

console.log('\n【1】断开 ⇒ 标记"掉线"触发器')
// 先连上（把状态推到 up），再断开
await connectThenClose(800)
reset()
const s2 = new WebSocket(`ws://127.0.0.1:${String(PORT)}/`, { headers: { authorization: `Bearer ${TOKEN}` } })
await new Promise((resolve, reject) => {
  s2.on('open', () => resolve())
  s2.on('error', reject)
  setTimeout(() => reject(new Error('超时')), 5000)
})
await new Promise((r) => setTimeout(r, 900))
reset()
s2.close()
await new Promise((r) => setTimeout(r, 1800))
st = readTriggers()
check('"掉线"被标记', () => assert(st.down?.next_fire_at !== null, `next=${String(st.down?.next_fire_at)}`))
check('"恢复"未被误标记', () => assert(st.up?.next_fire_at === null, `up=${String(st.up?.next_fire_at)}`))

console.log('\n【2】★ 幂等：同一状态反复观察不重复标记')
reset()
await connectThenClose(700)
reset()
// 现在状态是 up。再连一次（还是 up）⇒ "掉线"不该被标记
const s3 = new WebSocket(`ws://127.0.0.1:${String(PORT)}/`, { headers: { authorization: `Bearer ${TOKEN}` } })
await new Promise((resolve, reject) => {
  s3.on('open', () => resolve())
  s3.on('error', reject)
  setTimeout(() => reject(new Error('超时')), 5000)
})
await new Promise((r) => setTimeout(r, 1000))
st = readTriggers()
check('状态仍是 up 时，"掉线"保持未标记（边沿检测生效）', () =>
  assert(st.down?.next_fire_at === null, `down=${String(st.down?.next_fire_at)}`),
)
s3.close()
await new Promise((r) => setTimeout(r, 1200))

console.log('\n【3】恢复 ⇒ 标记"恢复"触发器')
reset()
await connectThenClose(700)
st = readTriggers()
check('"恢复"被标记', () => assert(st.up?.next_fire_at !== null, `next=${String(st.up?.next_fire_at)}`))

console.log('\n【4】★★ 再次断线 ⇒ **仍能触发**（端到端台子抓到的那个真 bug）')
reset()
const s4 = new WebSocket(`ws://127.0.0.1:${String(PORT)}/`, { headers: { authorization: `Bearer ${TOKEN}` } })
await new Promise((resolve, reject) => {
  s4.on('open', () => resolve())
  s4.on('error', reject)
  setTimeout(() => reject(new Error('超时')), 5000)
})
await new Promise((r) => setTimeout(r, 900))
reset()
s4.close()
await new Promise((r) => setTimeout(r, 1800))
st = readTriggers()
check('第二次断线**仍然**被标记', () =>
  assert(
    st.down?.next_fire_at !== null,
    'down=null —— 说明"两个事件名各判边沿"的老 bug 还在（qq.disconnected 那侧看不到恢复）',
  ),
)

reset()
const final = readTriggers()
console.log('\n  收尾（复位后）：')
for (const r of final.rows) console.log(`    [${r.title}] next=${r.next_fire_at ?? 'null'} fired=${r.fire_count}`)
opened.db.close()

console.log(`\n${'─'.repeat(58)}`)
console.log(`  验收③（非破坏性）：**${String(pass)} 通过 / ${String(fail)} 失败**`)
console.log(`${'─'.repeat(58)}\n`)
if (fail > 0) process.exitCode = 1
