/**
 * 端点探测的**目录漂移**检测。
 *
 * ## 这个测试是为一个真实事故写的
 *
 * 2026-10-09 部署后手工跑了一次探测，才发现授权清单里写着 `space-bunny-free`、
 * L1 降级链的最后一档还指着它 —— 而上游 `GET /models` 返回的 45 个模型里
 * **没有这个 id**（只有 `space-bunny`，免费档被撤了）。
 *
 * 复核期机制（`free.recheckDays`）挡不住这种情况：它只看时间，不看模型还在不在。
 * 唯一的发现途径是**人工比对**上游清单 —— 而探测本来就已经把清单拿回来了。
 *
 * 所以这里钉三件事：
 *  1. 声明了但上游没有 ⇒ 要报出来；
 *  2. 上游有但没声明 ⇒ **不要**报（Go 计划给几十个，我们只授权几个，那是预期）；
 *  3. 漂移**不改健康判定**（端点没坏，烂的是我们的目录）。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import type { DatabaseSync } from 'node:sqlite'

import { probeAllEndpoints, type HealthFetch } from '../src/endpoint-health.ts'

/** 只实现探测真正会走到的几个方法。 */
function fakeDb(rows: readonly unknown[]): DatabaseSync {
  const statement = {
    all: (): readonly unknown[] => rows,
    get: (): undefined => undefined,
    run: (): { changes: number } => ({ changes: 1 }),
  }
  return { prepare: (): typeof statement => statement } as unknown as DatabaseSync
}

/** 上游返回给定模型清单。 */
function modelsFetch(ids: readonly string[]): HealthFetch {
  return () =>
    Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ data: ids.map((id) => ({ id })) }),
    })
}

/** base_url 故意用一个**没有额度 provider** 的域名 ⇒ 额度检查走 unsupported，不碰网络。 */
const ENDPOINT = 'https://example.invalid/v1'

function endpointRow(models: string | null): unknown {
  return { id: 'ep-x', base_url: ENDPOINT, api_key_ref: null, models }
}

test('★ 目录漂移：声明的模型上游不认 ⇒ 写进 note 并单独吼一声', async () => {
  const logs: string[] = []
  const results = await probeAllEndpoints({
    db: fakeDb([endpointRow(JSON.stringify([{ id: 'deepseek-v4.1-flash' }, { id: 'space-bunny-free' }]))]),
    fetchImpl: modelsFetch(['deepseek-v4.1-flash', 'space-bunny', 'kimi-k3']),
    log: (message) => logs.push(message),
  })

  assert.equal(results.length, 1)
  assert.equal(results[0]?.ok, true, '漂移不该把端点判成不健康 —— 端点本身是好的')

  const note = results[0]?.note ?? ''
  assert.match(note, /目录漂移/, 'note 要带上漂移标记，否则面板上看不见')
  assert.match(note, /space-bunny-free/, 'note 要点名是哪个模型')
  assert.ok(!note.includes('kimi-k3'), '上游有但没声明的**不算漂移**（能用 ≠ 允许用）')

  const shouted = logs.find((line) => line.includes('目录漂移') && line.startsWith('⚠'))
  assert.ok(shouted !== undefined, '要有一条显眼的 ⚠ 日志，否则没人会去看面板的 note')
  assert.match(shouted, /opencode-go\.ts/, '要指出该改哪个文件')
})

test('没有漂移 ⇒ note 里不该出现漂移字样（别把正常情况报成异常）', async () => {
  const logs: string[] = []
  const results = await probeAllEndpoints({
    db: fakeDb([endpointRow(JSON.stringify([{ id: 'a' }, { id: 'b' }]))]),
    fetchImpl: modelsFetch(['a', 'b', 'c', 'd']),
    log: (message) => logs.push(message),
  })

  assert.ok(!(results[0]?.note ?? '').includes('目录漂移'))
  assert.ok(!logs.some((line) => line.includes('目录漂移')))
})

test('声明的写法两种都认：字符串数组与对象数组', async () => {
  const results = await probeAllEndpoints({
    db: fakeDb([endpointRow(JSON.stringify(['alive', 'ghost']))]),
    fetchImpl: modelsFetch(['alive']),
    log: () => {},
  })
  assert.match(results[0]?.note ?? '', /ghost/)
})

test('models 字段为空 / 不是 JSON ⇒ 不报漂移（那是配置校验的事，不是探测的事）', async () => {
  for (const raw of [null, '', '   ', 'not json', '{"id":"x"}']) {
    const logs: string[] = []
    const results = await probeAllEndpoints({
      db: fakeDb([endpointRow(raw)]),
      fetchImpl: modelsFetch(['a']),
      log: (message) => logs.push(message),
    })
    assert.equal(results[0]?.ok, true, `${String(raw)} 不该影响健康判定`)
    assert.ok(!logs.some((line) => line.includes('目录漂移')), `${String(raw)} 不该报漂移`)
  }
})

test('端点连不上时只报错误，不报漂移（没拿到清单，无从比对）', async () => {
  const logs: string[] = []
  const results = await probeAllEndpoints({
    db: fakeDb([endpointRow(JSON.stringify([{ id: 'ghost' }]))]),
    fetchImpl: () => Promise.reject(new Error('connect ECONNREFUSED')),
    log: (message) => logs.push(message),
  })

  assert.equal(results[0]?.ok, false)
  assert.ok(!logs.some((line) => line.includes('目录漂移')), '拿不到上游清单就不该猜漂移')
})
