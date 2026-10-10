/**
 * 投喂子系统（`feed-batch.ts`）的行为测试 —— **真库、真切分、真分批**。
 *
 * ## 守的是什么
 *
 *  ① **切分由系统做**：一段"用户自己塞进来的巨量记忆"（没有空行的一坨）
 *     会被切成很多片、分成很多批 —— 而调用方**没有**切；
 *  ② **段间让出控制权**：批与批之间真的 `await` 了让出（用注入的 `yieldBetween` 数次数），
 *     而不是"一口气把 N 段全写进中期记忆"（2026-10-09 真机实测过的死锁）；
 *  ③ **同一个来源 = 同一个 scope**：分批不许多长出几个来源（`indexOffset` 的落点），
 *     段落序号全局连续 ⇒ 批量大小怎么调都不会让整份文档重写一遍；
 *  ④ **跨批的 tail 归档**：重导变短时，上一版多出来的段落仍然被归档
 *     （每批各自扫一遍会把别的批的段误归档，所以收尾只做一次）；
 *  ⑤ **会话记账**：投喂期看得见进度、结束后**回到正常**（不做"永远半梦半醒"）；
 *  ⑥ **两种入口切出来的一样**：文件（流式）与字符串（整段）对同一份内容给出同样的切片。
 *
 * 每个用例开一个独立的内存库（共享库会让用例之间产生隐式顺序依赖）。
 *
 * @module @forlife/gateway/test/feed-batch
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import type { DatabaseSync } from 'node:sqlite'

import { defaultFor } from '@forlife/contracts'
import { openDatabase } from '@forlife/store'

import { feedInput, firstFeedResult } from '../src/feed-batch.ts'
import { feedIdFor } from '../src/feed.ts'
import { FEED_FRAME_PLACEHOLDERS, feedModeText } from '../src/feed-frame.ts'
import { beginFeedSession, readFeedSession } from '../src/feed-session.ts'

const opened: { close: () => void }[] = []
const dirs: string[] = []

after(() => {
  for (const handle of opened) handle.close()
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

function freshDb(): DatabaseSync {
  const handle = openDatabase({ file: ':memory:' })
  opened.push(handle)
  return handle.db
}

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'forlife-feed-batch-'))
  dirs.push(dir)
  return dir
}

/** 所有测试注入这个"让出"：数次数，不真的等（真等会让整个测试套变慢）。 */
function countingYield(): { readonly calls: () => number; readonly fn: () => Promise<void> } {
  let count = 0
  return {
    calls: () => count,
    fn: async (): Promise<void> => {
      count += 1
    },
  }
}

/** 造"用户塞进来的一坨"：**没有空行**（JSONL / dump 的形状）。 */
function bigBlob(lines: number): string {
  return Array.from({ length: lines }, (_, i) => `第 ${String(i)} 条记录：这一行讲的是过去发生的某件事。`).join('\n')
}

/** 一坨"没有空行"的巨量文本 —— 老守卫只看段数，会把它当成**一条**记忆写进去。 */
test('★★ 巨量单条文本：系统自己切分、分批投入、批间让出控制权', async () => {
  const db = freshDb()
  const ceiling = defaultFor<number>('feed.chunkMaxTokens')
  const yields = countingYield()

  const run = await feedInput(db, {
    as: 'knowledge',
    text: bigBlob(12_000),
    source: 'dump/huge.jsonl',
    yieldBetween: yields.fn,
  })
  const result = firstFeedResult(run)
  assert.ok(result !== undefined)
  assert.equal(result.ok, true, run.error ?? '喂食失败')
  // ★ 片数下限**从天花板推导**，不写死绝对量级。
  //   旧版写死 `chunkCount > 100` —— 那只是 `feed.chunkMaxTokens = 2000`
  //   那个年代的**副产品**，不是不变量：天花板一放宽，片数就掉到个位数，
  //   于是"测试红了"其实什么都没证明（2026-10-10 实测栽过）。
  const totalTokens = result.details.reduce((sum, detail) => sum + detail.tokenCount, 0)
  assert.ok(result.chunkCount > 1, `一坨 12k 行必须被切开（实际 ${String(result.chunkCount)} 片）`)
  assert.ok(
    result.chunkCount >= Math.ceil(totalTokens / ceiling),
    `片数至少要"总量÷天花板"那么多（实际 ${String(result.chunkCount)} < ⌈${String(totalTokens)}/${String(ceiling)}⌉）`,
  )
  // ★ "分批"只在**片数真的超过一批**时才断言 —— 否则测的是 `feed.batchMaxChunks`
  //   而不是"切分"。批数 = ⌈片数 ÷ batchMaxChunks⌉，片数不到一批时它恒为 1。
  if (result.chunkCount > defaultFor<number>('feed.batchMaxChunks')) {
    assert.ok((result.batches ?? 0) >= 2, `片数超过一批时必须分批（实际 ${String(result.batches)} 批）`)
    assert.ok(yields.calls() >= (result.batches ?? 1) - 1, '批与批之间必须让出控制权')
  }

  // 每一段都 ≤ 天花板（这正是"一条炸掉窗口"那条故障的反面）
  for (const detail of result.details) {
    assert.ok(detail.tokenCount <= ceiling, `有段超限：${String(detail.tokenCount)} > ${String(ceiling)}`)
  }
  // 段落序号全局连续（indexOffset 的落点）：没有"两个第 0 段"
  const indexed = result.details.filter((detail) => detail.index >= 0).map((detail) => detail.index)
  assert.deepEqual(
    indexed,
    Array.from({ length: indexed.length }, (_, i) => i),
    '分批之后段落序号必须仍然全局连续',
  )
  // 同一个来源 = 同一个 scope（不许多长出几个来源）
  const scopes = db.prepare('SELECT DISTINCT source_scope AS s FROM long_memory_entries').all() as unknown as { s: string }[]
  assert.deepEqual(scopes.map((row) => row.s), ['feed:dump/huge.jsonl'])
  // 落库条数 == 明细里"真的写了"的条数（没有静默丢段）
  const rows = (db.prepare('SELECT count(*) AS n FROM long_memory_entries').get() as { n: number }).n
  assert.equal(rows, result.inserted + result.updated + result.unchanged)
})

test('★★ 同一份内容：文件（流式）与字符串（整段）切出来的**正文完全一样**', async () => {
  // ⚠️ 两个**独立**的库：跨来源判重会把"同一份内容换个来源再喂"整片判成重复
  //（那是既有语义：宁漏不误杀），拿它来比"切片一不一样"就跑偏了。
  const dbText = freshDb()
  const dbFile = freshDb()
  const dir = tempDir()
  const content = `${bigBlob(4000)}\n\n${'另一段中文内容。'.repeat(300)}`
  const file = join(dir, 'dump.md')
  writeFileSync(file, content, 'utf8')

  const fromText = firstFeedResult(
    await feedInput(dbText, { as: 'knowledge', text: content, source: 'diff/text', yieldBetween: countingYield().fn }),
  )
  const fromFile = firstFeedResult(
    // 文件是"某个源的快照" ⇒ 必须显式声明（这里声明"没有外部源"）
    await feedInput(dbFile, {
      as: 'knowledge',
      paths: [file],
      source: 'diff/file',
      refresh: { kind: 'none', reason: '测试：临时写的文件，没有外部源' },
      yieldBetween: countingYield().fn,
    }),
  )
  assert.equal(fromText?.ok, true)
  assert.equal(fromFile?.ok, true)

  const rowsOf = (db: DatabaseSync, scope: string): string[] =>
    (
      db.prepare('SELECT content FROM long_memory_entries WHERE source_scope = ? ORDER BY id').all(scope) as unknown as {
        content: string
      }[]
    ).map((row) => row.content)

  assert.deepEqual(
    rowsOf(dbFile, 'feed:diff/file'),
    rowsOf(dbText, 'feed:diff/text'),
    '换个入口喂同一份文件，切片必须一模一样（否则重导会整体重写）',
  )
  assert.equal(fromFile?.chunkCount, fromText?.chunkCount)
  assert.equal(fromFile?.tokens, fromText?.tokens)
})

test('★★ 重导变短（跨批）：上一版多出来的段落被归档，而且是**收尾时一次**做的', async () => {
  const db = freshDb()
  const yields = countingYield()
  const paragraphs = (count: number): string =>
    Array.from({ length: count }, (_, i) => `片段 ${String(i)}：${'关于部署、回滚与备份的一段独立记录。'.repeat((i % 3) + 1)}`).join('\n\n')

  // 120 段 ⇒ 至少 3 批（每批 50）
  const first = firstFeedResult(
    await feedInput(db, { as: 'knowledge', text: paragraphs(120), source: 'notes/long.md', yieldBetween: yields.fn }),
  )
  assert.ok((first?.batches ?? 0) >= 3, `第一版必须跨多批（实际 ${String(first?.batches)}）`)

  // 第二版只剩 5 段 ⇒ 115 个 id 上的条目是"上一版多出来的"
  const second = firstFeedResult(
    await feedInput(db, { as: 'knowledge', text: paragraphs(5), source: 'notes/long.md', yieldBetween: yields.fn }),
  )
  assert.equal(second?.ok, true)
  assert.equal(second?.chunkCount, 5)

  const archived = (
    db.prepare("SELECT id FROM long_memory_entries WHERE status = 'archived'").all() as unknown as { id: string }[]
  ).map((row) => row.id)
  // 判重可能让某些段没真的插进去（相似度高的短句），所以不断言"正好 115"，
  // 而是断言**语义**：留下来的必须是前 5 段的 id，其余全部归档
  const kept = new Set(Array.from({ length: 5 }, (_, i) => feedIdFor('notes/long.md', i)))
  for (const id of archived) assert.ok(!kept.has(id), `第 ${id} 段不该被归档（它还在这一版里）`)
  const active = (
    db.prepare("SELECT id FROM long_memory_entries WHERE status = 'active'").all() as unknown as { id: string }[]
  ).map((row) => row.id)
  for (const id of active) assert.ok(kept.has(id), `第 ${id} 段是上一版多出来的，必须被归档`)
  assert.ok(archived.length >= 1, '这个用例必须真的归档掉一些东西（否则它什么都没验证）')
})

test('★ dryRun：一个字都不写，也**不**记会话（"我在消化记忆"会是假话）', async () => {
  const db = freshDb()
  const run = await feedInput(db, { as: 'knowledge', text: bigBlob(200), source: 'dry/run', dryRun: true, yieldBetween: countingYield().fn })
  const result = firstFeedResult(run)
  assert.equal(result?.dryRun, true)
  assert.equal(result?.inserted, 0)
  assert.equal((db.prepare('SELECT count(*) AS n FROM long_memory_entries').get() as { n: number }).n, 0)
  assert.equal(readFeedSession(db), undefined, 'dryRun 不该留下会话记录')
  assert.equal(feedModeText(db), '')
})

test('★ 会话记账：投喂期读得到进度，结束后**回到正常**（不永远半梦半醒）', async () => {
  const db = freshDb()
  const seen: { batches: number; chunks: number; source: string }[] = []
  const run = await feedInput(db, {
    as: 'experience',
    text: bigBlob(12_000),
    source: 'diary/huge',
    yieldBetween: countingYield().fn,
    onProgress: (progress) => {
      // 回调里读库：证明"别的进程/别的轮次"此刻能看到什么
      const session = readFeedSession(db)
      assert.ok(session !== undefined, '投喂期必须有会话记录（否则模型不知道自己半梦半醒）')
      seen.push({ batches: session.batches, chunks: session.chunks, source: session.source })
    },
  })
  const ok = firstFeedResult(run)
  assert.equal(ok?.ok, true)
  // ★ 批数由**天花板 × feed.batchMaxChunks** 决定，不该写死。
  //   旧版直接断言 `seen.length >= 2` —— 天花板一放宽，同一坨输入只剩一批，
  //   于是"必须有多批"变成了在测**参数取值**而不是测**记账逻辑**（2026-10-10 栽过）。
  const batches = ok?.batches ?? 1
  assert.ok(seen.length >= 1, '投喂期必须能读到会话进度（否则模型不知道自己半梦半醒）')
  if (batches >= 2) {
    assert.ok(seen.length >= 2, '真的分成多批时，才谈得上"一段一段浮上来"')
    assert.ok(seen.at(-1)!.chunks > seen[0]!.chunks, '进度必须往前走')
  }
  assert.equal(seen[0]?.source, 'diary/huge')
  assert.equal(readFeedSession(db), undefined, '投喂结束 = 醒来：会话记录必须被收掉')
  assert.equal(feedModeText(db), '', '结束之后提示段必须回到空串')
})

test('★ 会话：记录坏掉/太旧都当"没有"（渲染路径只读不写，不能抛）', async () => {
  const db = freshDb()
  db.prepare("INSERT INTO forlife_state (key, value) VALUES ('feed_session', ?)").run('{不是 JSON')
  assert.equal(readFeedSession(db), undefined)
  assert.equal(feedModeText(db), '')

  // 陈旧：更新的时间已经超过 feed.sessionStaleMs ⇒ 当没有（进程崩了不会让模型永远半梦半醒）
  const stale = new Date(Date.now() - defaultFor<number>('feed.sessionStaleMs') * 2).toISOString()
  beginFeedSession(db, { source: 'x', as: 'knowledge', now: new Date(stale) })
  assert.equal(readFeedSession(db), undefined)
  assert.equal(feedModeText(db), '')
  assert.ok(readFeedSession(db, { ignoreStale: true }) !== undefined, '写的人自己读回来时不该被自己的陈旧判定挡掉')
})

test('★ 投喂期提示段：非空、带进度、占位符全部被替换掉', async () => {
  const db = freshDb()
  const run = await feedInput(db, {
    as: 'knowledge',
    text: bigBlob(12_000),
    source: 'notes/frame.md',
    yieldBetween: countingYield().fn,
    onProgress: () => {
      const text = feedModeText(db)
      assert.ok(text.includes('半梦半醒'), '框架措辞必须在（用户口径）')
      assert.ok(!text.includes('{{'), `占位符必须全部替换掉：${text.slice(0, 120)}`)
      assert.ok(text.includes('notes/frame.md'), '要报出当前来源（让人知道在消化哪一份）')
      assert.ok(!/^\s*$/.test(text), '投喂期不能是空白串（空白串会被宿主原样插进提示词）')
    },
  })
  assert.equal(firstFeedResult(run)?.ok, true)
})

test('★ 基线里的框架文案只使用**白名单里的**占位符（写了 {{xxx}} 而没人替换就是撒谎）', () => {
  const template = defaultFor<string>('feed.dreamFrame')
  const found = [...template.matchAll(/\{\{([a-zA-Z0-9_]+)\}\}/g)].map((match) => match[1] ?? '')
  assert.ok(found.length > 0, '文案里必须有占位符（否则"进度一段一段浮上来"就是假的）')
  for (const name of found) {
    assert.ok(
      FEED_FRAME_PLACEHOLDERS.includes(name),
      `文案里有 ${name}，但代码认的占位符只有 ${FEED_FRAME_PLACEHOLDERS.join(' / ')} —— 它会被原样留给她看见`,
    )
  }
})

test('★ 流式输入必须显式给 source（来源要参与 id 派生，而流只能读一遍）', async () => {
  const db = freshDb()
  const run = await feedInput(db, {
    as: 'knowledge',
    stream: (function* () {
      yield '一段流式内容。'
    })(),
  })
  assert.equal(run.ok, false)
  assert.match(run.error ?? '', /必须显式给 source/)
})

test('★ 附件决策：目录里的二进制被跳过并说明原因，文本照喂', async () => {
  const db = freshDb()
  const dir = tempDir()
  writeFileSync(join(dir, 'a.md'), '第一份资料。', 'utf8')
  writeFileSync(join(dir, 'blob.md'), `看起来是文本\u0000其实是二进制`, 'utf8')

  const run = await feedInput(db, {
    as: 'knowledge',
    paths: [dir],
    refresh: { kind: 'none', reason: '测试：临时目录，没有外部源' },
    yieldBetween: countingYield().fn,
  })
  assert.equal(run.units.length, 1, '只有文本那一份被喂')
  assert.equal(run.skipped.length, 1, '二进制那一份必须如实报出来（不许静默吞掉）')
  assert.match(run.skipped[0]?.reason ?? '', /NUL 字节/)
  assert.equal(run.ok, false, '有跳过项 ⇒ 这次不算全成功')
})

test('★ 校验：一次只给一种输入；空输入报核心那句原文', async () => {
  const db = freshDb()
  const both = await feedInput(db, { as: 'knowledge', text: 'a', items: [{ content: 'b' }] })
  assert.equal(both.ok, false)
  assert.match(both.error ?? '', /一次只能给一种输入/)

  const none = await feedInput(db, { as: 'knowledge' })
  assert.equal(none.ok, false)
  assert.match(none.error ?? '', /没有可喂的内容/)

  const empty = await feedInput(db, { as: 'knowledge', items: [{ content: '   \n  ' }] })
  assert.equal(empty.ok, false)
  assert.match(empty.error ?? '', /没有可喂的内容/)

  const blankText = await feedInput(db, { as: 'knowledge', text: '   ' })
  assert.equal(blankText.ok, false)
  assert.match(blankText.error ?? '', /没有可喂的内容/)
})

test('★ 缺省来源：仍然按**切分前**的内容派生（与核心同一条式子，天花板不参与）', async () => {
  const db = freshDb()
  const text = bigBlob(30)
  const first = firstFeedResult(await feedInput(db, { as: 'knowledge', text, yieldBetween: countingYield().fn }))
  assert.match(first?.source ?? '', /^knowledge:[0-9a-f]{8}$/)
  const again = firstFeedResult(await feedInput(db, { as: 'knowledge', text, yieldBetween: countingYield().fn }))
  assert.equal(again?.source, first?.source, '同样的内容重复喂必须幂等（来源不随天花板/批大小变）')
  assert.equal(again?.inserted, 0)
})

test('★ 目录里多个文件：每个文件一个来源（互不覆盖），且共用一个会话（进度只增不减）', async () => {
  const db = freshDb()
  const dir = tempDir()
  // 文件要够大，才谈得上"跨批"；但**跨几批**由天花板决定，本测试不假设具体批数
  writeFileSync(join(dir, 'a.md'), bigBlob(12_000), 'utf8')
  writeFileSync(join(dir, 'b.md'), bigBlob(12_000).replace(/第 /g, '第B'), 'utf8')
  const progressChunks: number[] = []
  const run = await feedInput(db, {
    as: 'knowledge',
    paths: [dir],
    refresh: { kind: 'none', reason: '测试：临时目录，没有外部源' },
    yieldBetween: countingYield().fn,
    onProgress: (progress) => progressChunks.push(progress.chunks),
  })
  assert.equal(run.ok, true)
  assert.equal(run.units.length, 2)
  const scopes = (db.prepare('SELECT DISTINCT source_scope AS s FROM long_memory_entries ORDER BY s').all() as unknown as { s: string }[]).map(
    (row) => row.s,
  )
  assert.equal(scopes.length, 2, '两个文件必须是两个来源（同源会互相覆盖）')
  // ★ 旧版写死 `>= 4`（"两个文件各跨多批"）—— 那是 `feed.chunkMaxTokens = 2000`
  //   那个年代的副产品：批数由**天花板 × batchMaxChunks**决定，天花板一放宽就掉到 1。
  //   本测试真正钉的是**单调性**（下面那段），不是回调次数。
  assert.ok(progressChunks.length >= 1, `两个文件都必须有进度回调（实际 ${String(progressChunks.length)} 次）`)
  for (let i = 1; i < progressChunks.length; i += 1) {
    assert.ok(
      (progressChunks[i] as number) >= (progressChunks[i - 1] as number),
      `进度不许往回跳（第 ${String(i)} 次：${String(progressChunks[i - 1])} → ${String(progressChunks[i])}）—— ` +
        '提示段说的是"记忆一段一段浮上来"',
    )
  }
  assert.equal(readFeedSession(db), undefined, '一次投喂做完才收会话')
})
