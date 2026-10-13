/**
 * ★★ 方块字符判定（面板把二维码"贴紧渲染"靠的就是它）。
 *
 * 用户 2026-10-13 报的真问题：NapCat 的登录二维码是**一行行方块字符**（每行一条日志），
 * 而日志行的 `padding: 1px` + `line-height: 1.6` 把它**竖着拉开约 60%**
 * ⇒ 二维码变成长方形、手机扫不出来。
 *
 * ★ 修法就是"认出这些行、贴紧渲染"，所以**"认不认得出来"必须被测试钉住** ——
 * 之前这段逻辑只写在 `.vue` 里，**没有任何测试**（而它当时还因为 CSS 落在 `<style>`
 * 外面而**根本没生效**，属于双重假绿）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { BLOCK_ART_MIN_CHARS, BLOCK_ART_RATIO, isBlockArt } from '../src/lib/block-art.ts'

/** 一行真实的二维码（取自用户 2026-10-13 的截图）。 */
const QR_ROW = '█ ▄▄▄▄▄ █▀ █▀▀▀ ▀▀▄ █ ▄▀▄██ ▄▄▄▄▄ █'
/** 二维码最上面那一行（全是半块字符）。 */
const QR_EDGE = '▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄'

test('★★★ 真的二维码行 ⇒ 认得出来（认不出就还会被拉长）', () => {
  assert.equal(isBlockArt(QR_ROW), true)
  assert.equal(isBlockArt(QR_EDGE), true)
})

test('★★ 普通日志一行都不许被误伤（误伤会把正常日志的行距也压掉）', () => {
  assert.equal(isBlockArt('[OneBot] 已连接'), false)
  assert.equal(isBlockArt('收到一条群消息：今天天气不错'), false)
  assert.equal(isBlockArt('{"level":"info","module":"caddy","text":"handling request"}'), false)
  assert.equal(isBlockArt('https://txz.qq.com/p?k=hKPPZMnI8iLfGyGiwSQKSCWoEN87UZPn'), false)
})

test('★ 短行不算（少于 8 个字符）—— 几个方块不足以拼成图', () => {
  assert.equal(isBlockArt('█▀▄'), false)
  assert.equal(isBlockArt('█ ▀ ▄'), false)
  assert.equal(isBlockArt(''), false)
  assert.ok(BLOCK_ART_MIN_CHARS >= 8)
})

test('★★ 判据是"占比"而不是"有没有方块"：掺了太多普通字符就不算图', () => {
  // 方块占一半（< 60%）⇒ 不算
  // ★ 8 个方块 + 8 个汉字 = 50%（< 60%）⇒ 不算（★ 我第一版写成 16 个方块，算出来是 67%，反被测试抓出来）
  const half = '████████普通文字普通文字'
  assert.ok(isBlockArt(half) === false, '占比不足 60% 不算')
  // 同一个函数对"纯方块"要给 true（否则上面那条断言等于没意义）
  assert.equal(isBlockArt('████████████████'), true)
  assert.ok(BLOCK_ART_RATIO > 0.5 && BLOCK_ART_RATIO <= 0.6, '阈值应落在 0.5~0.6 之间')
})
