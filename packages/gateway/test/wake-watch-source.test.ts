/**
 * 监视事件源的守卫测试。
 *
 * ## 最值得守的三条
 *
 * 1. **首次观察不触发** —— "文件本来就在那里"不该在服务启动瞬间触发一次，
 *    那不是"变化"。
 * 2. **边沿检测** —— 文件放在那里 10 分钟，1 秒一次轮询会触发 600 次。
 * 3. **`file.changed` 用内容哈希而不是 mtime** ——
 *    "内容变了但 mtime 没变"会被漏掉，"touch 一下但内容没变"会被误报。
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { createWakeTrigger, getWakeTrigger, openDatabase } from '@forlife/store'

import { createWatchSource, evaluateCondition, parseWatchSpec } from '../src/wake-watch-source.ts'

const AT = new Date('2026-10-06T12:00:00.000Z')

/** 造一个工作区 + 一个 db。 */
function setup(): {
  root: string
  db: ReturnType<typeof openDatabase>['db']
  source: ReturnType<typeof createWatchSource>
  close: () => void
} {
  const base = mkdtempSync(join(tmpdir(), 'forlife-watch-'))
  const root = join(base, 'ws')
  mkdirSync(root, { recursive: true })
  const opened = openDatabase({ file: ':memory:' })
  const source = createWatchSource({ db: opened.db, workspaceRoot: root, now: () => AT })
  return {
    root,
    db: opened.db,
    source,
    close: () => {
      opened.db.close()
      rmSync(base, { recursive: true, force: true })
    },
  }
}

/** 建一条 watcher 触发器。 */
function mkWatch(
  db: ReturnType<typeof openDatabase>['db'],
  condition: string,
  path: string,
  over: { scope?: string; enabled?: boolean; title?: string } = {},
): string {
  const r = createWakeTrigger(db, {
    kind: 'watcher',
    scope: over.scope ?? 'onebot11:123',
    title: over.title ?? `盯 ${path}`,
    prompt: '看看',
    spec: { condition, path },
    createdBy: 'test',
    now: AT,
  })
  assert.equal(r.ok, true, r.reason)
  if (over.enabled === false) db.prepare('UPDATE wake_triggers SET enabled = 0 WHERE id = ?').run(r.row!.id)
  return r.row!.id
}

test('parseWatchSpec：坏 JSON / 未知条件 / 空路径都返回 undefined', () => {
  assert.deepEqual(parseWatchSpec('{"condition":"file.exists","path":"a.txt"}'), { condition: 'file.exists', path: 'a.txt' })
  assert.equal(parseWatchSpec('不是 JSON'), undefined)
  assert.equal(parseWatchSpec('{"condition":"乱写","path":"a"}'), undefined)
  assert.equal(parseWatchSpec('{"condition":"file.exists","path":"  "}'), undefined)
})

test('★ 路径走工作区沙箱（读不能成为绕过沙箱的口子）', () => {
  const s = setup()
  try {
    const bad = evaluateCondition({ condition: 'file.exists', path: '../../etc/passwd' }, s.root)
    assert.equal(bad.met, false)
    assert.match(bad.detail, /路径不合法/)
    // 指纹里带上原因 —— 否则用户只看到"一直没触发"，而真因是路径写错了
    assert.match(bad.fingerprint, /^invalid:/)
  } finally {
    s.close()
  }
})

test('file.exists：存在则成立', () => {
  const s = setup()
  try {
    writeFileSync(join(s.root, 'a.txt'), 'hi', 'utf8')
    assert.equal(evaluateCondition({ condition: 'file.exists', path: 'a.txt' }, s.root).met, true)
    assert.equal(evaluateCondition({ condition: 'file.exists', path: 'b.txt' }, s.root).met, false)
  } finally {
    s.close()
  }
})

test('★ file.changed 用**内容哈希**：内容变了指纹就变，touch 一下不变', () => {
  const s = setup()
  try {
    const p = join(s.root, 'log.txt')
    writeFileSync(p, '第一版', 'utf8')
    const a = evaluateCondition({ condition: 'file.changed', path: 'log.txt' }, s.root)

    // 内容变了 ⇒ 指纹变
    writeFileSync(p, '第二版', 'utf8')
    const b = evaluateCondition({ condition: 'file.changed', path: 'log.txt' }, s.root)
    assert.notEqual(a.fingerprint, b.fingerprint, '内容变了指纹必须变')

    // 内容相同（重写一遍同样的内容）⇒ 指纹不变
    writeFileSync(p, '第二版', 'utf8')
    const c = evaluateCondition({ condition: 'file.changed', path: 'log.txt' }, s.root)
    assert.equal(b.fingerprint, c.fingerprint, '内容没变指纹不该变（用 mtime 的话这里会误报）')
  } finally {
    s.close()
  }
})

test('★ 首次观察**不触发**（"文件本来就在"不是"变化"）', () => {
  const s = setup()
  try {
    writeFileSync(join(s.root, 'already.txt'), 'x', 'utf8')
    mkWatch(s.db, 'file.exists', 'already.txt')

    const first = s.source.tick()
    assert.equal(first.length, 1)
    assert.equal(first[0]?.triggered, false, '首次观察不该触发')
    assert.match(first[0]?.detail ?? '', /首次观察/)
  } finally {
    s.close()
  }
})

test('★ 边沿检测：文件出现时触发一次，之后 100 次轮询不再触发', () => {
  const s = setup()
  try {
    const id = mkWatch(s.db, 'file.exists', 'new.txt')
    s.source.tick() // 首次观察（文件不存在）

    writeFileSync(join(s.root, 'new.txt'), 'x', 'utf8')
    const appeared = s.source.tick()
    assert.equal(appeared[0]?.triggered, true, '文件出现要触发')
    assert.equal(getWakeTrigger(s.db, id)?.next_fire_at, AT.toISOString())

    // 复位（模拟引擎处理过）
    s.db.prepare('UPDATE wake_triggers SET next_fire_at = NULL WHERE id = ?').run(id)

    for (let i = 0; i < 100; i += 1) {
      const again = s.source.tick()
      assert.equal(again[0]?.triggered, false, `第 ${String(i + 2)} 次轮询不该再触发`)
    }
  } finally {
    s.close()
  }
})

test('file.absent：文件消失时触发', () => {
  const s = setup()
  try {
    writeFileSync(join(s.root, 'temp.txt'), 'x', 'utf8')
    mkWatch(s.db, 'file.absent', 'temp.txt')
    s.source.tick() // 首次：文件在，条件不成立

    rmSync(join(s.root, 'temp.txt'))
    const gone = s.source.tick()
    assert.equal(gone[0]?.triggered, true, '文件消失要触发')
  } finally {
    s.close()
  }
})

test('file.changed：内容变化触发；内容不变不触发', () => {
  const s = setup()
  try {
    const p = join(s.root, 'c.txt')
    writeFileSync(p, 'v1', 'utf8')
    mkWatch(s.db, 'file.changed', 'c.txt')
    s.source.tick()

    writeFileSync(p, 'v2', 'utf8')
    assert.equal(s.source.tick()[0]?.triggered, true, '内容变了要触发')

    // 复位后内容不变 ⇒ 不触发
    s.db.prepare('UPDATE wake_triggers SET next_fire_at = NULL').run()
    assert.equal(s.source.tick()[0]?.triggered, false, '内容没变不该触发')
  } finally {
    s.close()
  }
})

test('停用的 watcher 完全不参与轮询', () => {
  const s = setup()
  try {
    mkWatch(s.db, 'file.exists', 'x.txt', { enabled: false })
    assert.equal(s.source.tick().length, 0)
  } finally {
    s.close()
  }
})

test('★ scope=* 的监视：条件成立也不标记（如实回报原因）', () => {
  const s = setup()
  try {
    mkWatch(s.db, 'file.exists', 'z.txt', { scope: '*' })
    s.source.tick()
    writeFileSync(join(s.root, 'z.txt'), 'x', 'utf8')
    const out = s.source.tick()
    assert.equal(out[0]?.triggered, false)
    assert.match(out[0]?.detail ?? '', /没有绑定会话/)
  } finally {
    s.close()
  }
})

test('条件从成立变回不成立：只记状态，不触发（那是恢复，不是事件）', () => {
  const s = setup()
  try {
    writeFileSync(join(s.root, 'g.txt'), 'x', 'utf8')
    mkWatch(s.db, 'file.exists', 'g.txt')
    s.source.tick()
    // 文件消失
    rmSync(join(s.root, 'g.txt'))
    const out = s.source.tick()
    assert.equal(out[0]?.triggered, false)
    assert.match(out[0]?.detail ?? '', /条件不再成立/)
  } finally {
    s.close()
  }
})
