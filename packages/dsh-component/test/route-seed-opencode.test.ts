/**
 * OpenCode Go 播种的守卫测试。
 *
 * 守三件事：
 *  1. 只补空表（用户手工调过的档位映射比我们的默认值权威）；
 *  2. 密钥**只存引用名**，绝不进库（表结构是这么设计的，别在这里破功）；
 *  3. 免费模型过期后不进库 —— 库里留下一条"看起来能用、其实随时会计费"的候选，
 *     比没有候选更危险。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { openDatabase } from '@forlife/store'

import { seedOpenCodeGoRoutes } from '../src/route-seed.ts'

/** 复核期内。 */
const IN_WINDOW = new Date('2026-10-08T00:00:00Z')
/** 复核期外。 */
const EXPIRED = new Date('2026-11-01T00:00:00Z')

function freshDb(): ReturnType<typeof openDatabase> {
  return openDatabase({ file: ':memory:' })
}

test('空库：播种四个角色 + 登记端点，密钥只存引用', () => {
  const opened = freshDb()
  try {
    const result = seedOpenCodeGoRoutes(opened.db, { now: IN_WINDOW })
    assert.equal(result.seeded, true, result.reason)
    assert.ok(result.count >= 4, '至少四个角色各一行')

    const roles = opened.db.prepare('SELECT DISTINCT role FROM model_routes ORDER BY role').all() as { role: string }[]
    assert.deepEqual(
      roles.map((row) => row.role),
      ['L1', 'L2', 'L3', 'minimum'],
    )

    const endpoint = opened.db
      .prepare('SELECT id, base_url, api_key_ref, type, mode, enabled FROM inference_endpoints WHERE id = ?')
      .get('ep-opencode-go') as
      | { id: string; base_url: string; api_key_ref: string; type: string; mode: string; enabled: number }
      | undefined
    assert.ok(endpoint !== undefined, '端点必须被登记（否则面板的端点页显示 0 个，与候选链自相矛盾）')
    assert.equal(endpoint.base_url, 'https://opencode.ai/zen/go/v1')
    assert.equal(endpoint.type, 'cloud-api')
    assert.equal(endpoint.mode, 'remote-api')
    assert.equal(endpoint.enabled, 1)

    // 密钥**只存引用名**：真 key 长得像 oc_sk_xxx，库里绝不能出现
    assert.equal(endpoint.api_key_ref, 'FORLIFE_OPENCODE_GO_KEY')
    const dump = JSON.stringify(opened.db.prepare('SELECT * FROM inference_endpoints').all())
    assert.ok(!dump.includes('oc_sk_'), '数据库里绝不能出现明文密钥')
  } finally {
    opened.db.close()
  }
})

test('已有路由配置时完全不动（不覆盖用户手工调过的映射）', () => {
  const opened = freshDb()
  try {
    opened.db
      .prepare(
        `INSERT INTO model_routes (id, role, rank, provider, model, reasoning_effort, enabled, note, updated_by, updated_at)
         VALUES ('mr_manual', 'L1', 0, 'my-provider', 'my-model', 'low', 1, '手工配置', 'admin', '2026-10-01T00:00:00Z')`,
      )
      .run()

    const result = seedOpenCodeGoRoutes(opened.db, { now: IN_WINDOW })
    assert.equal(result.seeded, false)
    assert.match(result.reason, /已有 1 行/)

    const row = opened.db.prepare("SELECT provider, model FROM model_routes WHERE id = 'mr_manual'").get() as {
      provider: string
      model: string
    }
    assert.equal(row.provider, 'my-provider', '用户的配置必须原样保留')
    assert.equal(row.model, 'my-model')
    assert.equal(
      (opened.db.prepare('SELECT COUNT(*) AS v FROM inference_endpoints').get() as { v: number }).v,
      0,
      '没播种就不该登记端点',
    )
  } finally {
    opened.db.close()
  }
})

test('免费模型过期后：不进库，且原因里说明排除了几个', () => {
  const opened = freshDb()
  try {
    const result = seedOpenCodeGoRoutes(opened.db, { now: EXPIRED })
    assert.equal(result.seeded, true)

    const models = (opened.db.prepare('SELECT model FROM model_routes').all() as { model: string }[]).map((row) => row.model)
    assert.ok(!models.includes('space-bunny-free'), '幽灵模型（上游已下架）绝不能进库')
    assert.ok(!models.includes('longcat-2.5-preview-free'), '过期免费模型绝不能进库')
    assert.ok(models.includes('deepseek-v4.1-flash'), '付费模型不受复核期影响')
    assert.match(result.reason, /1 个免费模型因超出复核期被排除/)
  } finally {
    opened.db.close()
  }
})
