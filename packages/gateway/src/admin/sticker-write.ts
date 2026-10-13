/**
 * 表情库的编辑接口：改描述/标签、删除。
 *
 * 全部在网关内（表情库本来就是网关自己的数据），不涉及跨进程调用。
 *
 * ## 删除为什么是"标记"而不是真删
 *
 * 表情有**指纹**（sha256）。真删掉那一行的话，同一张图再次出现会被当成全新的 ——
 * 于是"水印判定""学来的标记""使用统计"全部从零开始，
 * 而用户看到的是"我删过的图又回来了，还带着水印判定问了一遍"。
 *
 * 所以删除标记成 `rejected` 并写明原因（保留指纹与判定），
 * 与"白名单外/带水印被拒"走同一条路径 —— 库里只有一种"不可用"的状态，不会分叉。
 *
 * @module @forlife/gateway/admin/queries-stickers
 */
import type { DatabaseSync } from 'node:sqlite'

import { rejectStickerAsset, saveStickerDescription } from '@forlife/store'

/** 改描述与标签。 */
export function updateStickerDescription(
  db: DatabaseSync,
  input: {
    readonly assetId: string
    readonly description: string
    readonly emotionTags: readonly string[]
    readonly updatedBy: string
    readonly now?: Date
  },
): { readonly ok: boolean; readonly reason: string } {
  const exists = db.prepare('SELECT id FROM sticker_assets WHERE id = ?').get(input.assetId) as { id: string } | undefined
  if (exists === undefined) return { ok: false, reason: `库里没有这个表情：${input.assetId}` }

  const description = input.description.trim()
  if (description === '') {
    // 空描述**不能存**：表情库的价值全在描述上（检索靠它），
    // 存一个空描述等于让检索命中一个"什么都没说"的条目。
    return { ok: false, reason: '描述不能为空 —— 空描述会让检索命中一个什么都没说的条目' }
  }

  saveStickerDescription(db, {
    assetId: input.assetId,
    description,
    emotionTags: [...input.emotionTags],
    // 标成人工来源：之后模型重新描述时，界面上能看出这版是人写的
    model: `manual:${input.updatedBy}`,
    ...(input.now === undefined ? {} : { now: input.now }),
  })
  return { ok: true, reason: '已保存' }
}

/** 删除（标记为 rejected，保留指纹与判定）。 */
export function deleteStickerAsset(
  db: DatabaseSync,
  input: { readonly assetId: string; readonly reason: string; readonly now?: Date },
): { readonly ok: boolean; readonly reason: string } {
  const row = db.prepare('SELECT sha256, status FROM sticker_assets WHERE id = ?').get(input.assetId) as
    | { sha256: string; status: string }
    | undefined
  if (row === undefined) return { ok: false, reason: `库里没有这个表情：${input.assetId}` }

  rejectStickerAsset(db, {
    sha256: row.sha256,
    reason: `人工删除：${input.reason}`,
    ...(input.now === undefined ? {} : { now: input.now }),
  })
  return { ok: true, reason: '已删除（标记为 rejected，指纹与判定保留）' }
}
