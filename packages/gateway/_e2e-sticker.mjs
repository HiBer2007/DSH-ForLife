/**
 * 「把图片存为表情包」的真机端到端验证。
 *
 * 与单测的区别：这里用**真实的视觉模型**（水印检查 + 描述各一次真实调用），
 * 走的是和线上完全一样的代码路径。上次跑到这里被 400 MissingSessionID 挡住，
 * 修好后这次应该能走完 —— 这正是"真实调用验证"的价值：
 * 单测里注入的 fetch 忠实地执行了我写错的假设，什么也没发现。
 */
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

import { createStickerService } from './src/sticker-service.ts'
import { createStickerVisionDescriber } from './src/sticker-vision.ts'
import { createWatermarkChecker } from './src/sticker-watermark.ts'

const key = readFileSync('D:/DSH-ForLife/.runtime/secrets/opencode-go.key', 'utf8').trim()
const vision = { model: 'deepseek-v4.1-flash', baseUrl: 'https://opencode.ai/zen/go/v1', apiKey: key, sessionId: 'dsh-forlife-vision' }

const bytes = readFileSync('D:/DSH-ForLife/.runtime/qrcode.png')
const mime = bytes[0] === 0xff ? 'image/jpeg' : 'image/png'
console.log(`  真实图片：${bytes.length} 字节，mime=${mime}`)

const db = new DatabaseSync('D:/DSH-ForLife/.runtime/dsh/forlife/db/forlife.sqlite')
const service = createStickerService({
  db,
  storageRoot: 'D:/DSH-ForLife/.runtime/dsh/forlife/db/stickers',
  watermark: createWatermarkChecker(vision),
  describer: createStickerVisionDescriber(vision),
})

console.log('\n  ① 入库（水印检查 + 描述，两次真实模型调用）…')
const t0 = Date.now()
const result = await service.add({ bytes, mime, source: 'manual', ours: true, scope: 'onebot11:2166227840' })
console.log(`     status = ${result.status}（${String(Date.now() - t0)} ms）`)
console.log(`     ${result.reason}`)
if (result.description !== undefined) console.log(`     描述：${result.description}`)
if (result.emotionTags !== undefined) console.log(`     标签：${result.emotionTags.join('、')}`)

if (result.status === 'rejected') {
  console.log('\n  ✖ 被拒 ⇒ 端到端未通过')
  db.close()
  process.exit(0)
}

console.log('\n  ② 指纹复用（同一张图第二次 ⇒ 应为 0 次视觉调用）…')
const t1 = Date.now()
const again = await service.add({ bytes, mime, source: 'learned', ours: false })
console.log(`     status = ${again.status}，calledModel = ${String(again.calledModel)}（${String(Date.now() - t1)} ms）`)
console.log(`     ${again.reason}`)

console.log('\n  ③ 检索（自然语言）…')
for (const query of ['二维码', '黑白方块', '猫']) {
  const hits = service.find(query, { limit: 1 })
  const top = hits[0]
  console.log(`     「${query}」→ ${top === undefined ? '无命中' : `命中（${top.score.toFixed(2)}）`}`)
}

console.log('\n  ④ 发送入队…')
const sent = service.send({ to: 'onebot11:2166227840', assetId: result.assetId ?? '' })
console.log(`     ok=${String(sent.ok)} ${sent.reason}`)

console.log('\n  ⑤ 库内状态：')
for (const r of db.prepare('SELECT status, COUNT(*) AS n FROM sticker_assets GROUP BY status').all()) console.log(`     ${r.status}: ${r.n}`)
const stored = db.prepare('SELECT storage_path FROM sticker_assets LIMIT 1').get()
console.log(`     落盘路径：${stored?.storage_path ?? '(无)'}`)
db.close()
