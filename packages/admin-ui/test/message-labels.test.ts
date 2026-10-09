/**
 * 面板「消息类型标签」的守卫（审计 §6.2 的面板显示方向）。
 *
 * 两件事必须钉住：
 *  ① **语音/视频不再显示成「（无文本）」** —— 那是审计点名的现象：
 *     用户看到的是一条空消息，而实际上那里有一条语音；
 *  ② **段名清单列全**（以审计 §二 的 NapCat 实测 24 种 segment 枚举为准）——
 *     少一个的后果是那个类型在面板上显示成 `[未解析:mface]` 这样的英文代号。
 *
 * @module admin-ui/test/message-labels
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import {
  inboundPreview,
  mediaKindLabel,
  MEDIA_KIND_LABELS,
  SEGMENT_LABELS,
  translateSegmentTokens,
} from '../src/utils/message-labels.ts'

test('媒体类型：4 个取值全部有中文（以前只有图片/文件）', () => {
  assert.deepEqual(MEDIA_KIND_LABELS, { image: '图片', file: '文件', record: '语音', video: '视频' })
  assert.equal(mediaKindLabel('record'), '语音')
  assert.equal(mediaKindLabel('video'), '视频')
  // 未知取值/没有值 ⇒ undefined（让调用方决定怎么显示，而不是替它编一个名字）
  assert.equal(mediaKindLabel('hologram'), undefined)
  assert.equal(mediaKindLabel(undefined), undefined)
  assert.equal(mediaKindLabel(7), undefined)
})

test('★ 语音消息不再显示成「（无文本）」——审计点名的那一条', () => {
  assert.equal(inboundPreview({ mediaKind: 'record', text: '' }), '[语音]')
  assert.equal(inboundPreview({ mediaKind: 'video', text: '   ' }), '[视频]')
  // 真的什么都没有时，仍然如实说"无文本"
  assert.equal(inboundPreview({ mediaKind: null, text: '' }), '（无文本）')
})

test('网关自己写的占位符不重复（`text` 已经是 `[图片]` 时不再加一个前缀）', () => {
  assert.equal(inboundPreview({ mediaKind: 'image', text: '[图片]' }), '[图片]')
  assert.equal(inboundPreview({ mediaKind: 'file', text: '[文件] 报告.pdf' }), '[文件] 报告.pdf')
  // 正文与媒体类型不一致时，两个都要显示（那是两条信息）
  assert.equal(inboundPreview({ mediaKind: 'image', text: '看这个' }), '[图片] 看这个')
  // 只有媒体类型、正文是别的占位符
  assert.equal(inboundPreview({ mediaKind: 'record', text: '[未解析:mface]' }), '[语音] [商城表情]')
})

test('★ 段名清单列全：审计 §二 的 24 种 segment 枚举一个都不少', () => {
  const fromAudit = [
    'text', 'image', 'music', 'video', 'record', 'file', 'at', 'reply', 'json', 'face', 'mface', 'markdown',
    'node', 'forward', 'xml', 'poke', 'dice', 'rps', 'miniapp', 'contact', 'location', 'onlinefile', 'flashtransfer',
  ]
  for (const name of fromAudit) {
    assert.ok(SEGMENT_LABELS[name] !== undefined, `段名 ${name} 没有中文标签（面板会显示英文代号）`)
  }
  assert.equal(Object.keys(SEGMENT_LABELS).length, 23)
})

test('占位符翻译：认识的翻中文，不认识的**原样留着**（不许编）', () => {
  assert.equal(translateSegmentTokens('[未解析:mface]'), '[商城表情]')
  assert.equal(translateSegmentTokens('前面 [未解析:forward] 后面'), '前面 [合并转发] 后面')
  assert.equal(translateSegmentTokens('[未解析:未来新段]'), '[未解析:未来新段]')
  assert.equal(translateSegmentTokens('没有任何占位符'), '没有任何占位符')
})

test('媒体标签与段名标签是**两个来源**，各自独立（别互相覆盖）', () => {
  // media_kind 只有 4 个取值，段名有 23 个 —— 合并成一张表就会两边都不准
  assert.equal(Object.keys(MEDIA_KIND_LABELS).length, 4)
  assert.ok(Object.keys(SEGMENT_LABELS).length > Object.keys(MEDIA_KIND_LABELS).length)
})

/** 去掉源码里的注释（尊重字符串/模板字面量）—— 注释里提到旧写法不算"还在用旧写法"。 */
function stripComments(source: string): string {
  let out = ''
  let i = 0
  let quote: string | undefined
  while (i < source.length) {
    const ch = source.charAt(i)
    const next = source.charAt(i + 1)
    if (quote !== undefined) {
      if (ch === '\\') {
        out += ch + next
        i += 2
        continue
      }
      if (ch === quote) quote = undefined
      out += ch
      i += 1
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch
      out += ch
      i += 1
      continue
    }
    if (ch === '/' && next === '/') {
      while (i < source.length && source.charAt(i) !== '\n') i += 1
      continue
    }
    if (ch === '/' && next === '*') {
      i += 2
      while (i < source.length && !(source.charAt(i) === '*' && source.charAt(i + 1) === '/')) i += 1
      i += 2
      continue
    }
    out += ch
    i += 1
  }
  return out
}

const viewCode = (name: string): string =>
  stripComments(readFileSync(new URL(`../src/views/${name}`, import.meta.url), 'utf8'))

test('★ 两个视图**真的用了**这份标签表（修了库、界面照旧 = 没修）', () => {
  const conversations = viewCode('ConversationsView.vue')
  assert.match(conversations, /inboundPreview\(\{ mediaKind: row\['mediaKind'\], text: row\['text'\] \}\)/, '入站预览没有走标签表')
  // 旧的内联映射（只认图片/文件）不许回来
  assert.doesNotMatch(conversations, /media === 'image' \? '\[图片\] '/, '又回到了只映射图片/文件的老写法')

  const media = viewCode('MediaView.vue')
  assert.match(media, /mediaKindLabel\(row\['mediaKind'\]\)/, '媒体类型列没有走标签表')
  assert.doesNotMatch(media, /row\['mediaKind'\] === 'image' \? '图片'/, '又回到了只映射图片/文件的老写法')
})
