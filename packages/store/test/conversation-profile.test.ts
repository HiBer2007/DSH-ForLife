/**
 * 会话档案的守卫测试。
 *
 * 最值得守的一条：**用户改过的画像，模型不能覆盖**。
 * 不守的话，模型下一次自动总结就会把用户的纠正悄悄抹掉，
 * 而用户只会觉得"我改了但它又变回去了" —— 这种问题几乎无法排查。
 *
 * 第二条：备注**排在画像前面**。顺序本身在告诉模型该信哪个，
 * 比在提示词里写一句"以备注为准"更可靠（不依赖模型记得住那句话）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  getConversationProfile,
  openDatabase,
  renderProfileForPrompt,
  setConversationImpression,
  setConversationNote,
} from '@forlife/store'

test('备注与画像分开存（权威性不同，不能合成一列）', () => {
  const opened = openDatabase({ file: ':memory:' })
  try {
    setConversationNote(opened.db, { conversationKey: 'onebot11:1', note: '这是我妹妹' })
    setConversationImpression(opened.db, { conversationKey: 'onebot11:1', impression: '说话简短，常用表情包' })

    const profile = getConversationProfile(opened.db, 'onebot11:1')
    assert.equal(profile?.note, '这是我妹妹')
    assert.equal(profile?.impression, '说话简短，常用表情包')
    assert.equal(profile?.impression_source, 'model', '模型写的应标为 model')
  } finally {
    opened.db.close()
  }
})

test('★ 用户改过的画像，模型不能覆盖（否则用户会觉得"改了又变回去"）', () => {
  const opened = openDatabase({ file: ':memory:' })
  try {
    // 模型先写一版
    setConversationImpression(opened.db, { conversationKey: 'k', impression: '模型猜的：可能是同事' })

    // 用户改成正确的
    const userWrite = setConversationImpression(opened.db, {
      conversationKey: 'k',
      impression: '用户纠正：是我妹妹，别当成同事',
      source: 'user',
    })
    assert.equal(userWrite, true)
    assert.equal(getConversationProfile(opened.db, 'k')?.impression_source, 'user')

    // 模型再想自动更新 ⇒ **必须被拒**
    const modelRetry = setConversationImpression(opened.db, {
      conversationKey: 'k',
      impression: '模型又猜：应该是同事',
      source: 'model',
      respectUserEdit: true,
    })
    assert.equal(modelRetry, false, '模型不该覆盖用户修正过的画像')
    assert.match(getConversationProfile(opened.db, 'k')?.impression ?? '', /我妹妹/, '用户的版本必须还在')

    // 但用户自己再改 ⇒ 当然要生效
    const userAgain = setConversationImpression(opened.db, {
      conversationKey: 'k',
      impression: '用户又改了一次',
      source: 'user',
      respectUserEdit: true,
    })
    assert.equal(userAgain, true)
    assert.equal(getConversationProfile(opened.db, 'k')?.impression, '用户又改了一次')
  } finally {
    opened.db.close()
  }
})

test('备注不会被写画像的操作抹掉（两条写路径互不干扰）', () => {
  const opened = openDatabase({ file: ':memory:' })
  try {
    setConversationNote(opened.db, { conversationKey: 'k', note: '重要：只谈工作' })
    setConversationImpression(opened.db, { conversationKey: 'k', impression: '画像一' })
    setConversationImpression(opened.db, { conversationKey: 'k', impression: '画像二' })

    assert.equal(getConversationProfile(opened.db, 'k')?.note, '重要：只谈工作', '写画像不该动备注')
  } finally {
    opened.db.close()
  }
})

test('★ 渲染给模型时：备注排在画像前面（顺序本身在说明该信哪个）', () => {
  const text = renderProfileForPrompt({
    conversation_key: 'k',
    note: '这是我妹妹',
    impression: '说话简短',
    impression_source: 'model',
    updated_by: 'user',
    updated_at: '2026-10-06T00:00:00.000Z',
  })
  const noteAt = text.indexOf('这是我妹妹')
  const impressionAt = text.indexOf('说话简短')
  assert.ok(noteAt !== -1 && impressionAt !== -1)
  assert.ok(noteAt < impressionAt, '备注（权威）必须排在画像（推测）前面')

  // 模型自己写的画像要**标明"可能有误"**，否则模型会把自己的猜测当成事实
  assert.match(text, /可能有误/)
})

test('用户修正过的画像要标明来源（模型才知道这条不是自己猜的）', () => {
  const text = renderProfileForPrompt({
    conversation_key: 'k',
    note: null,
    impression: '是我妹妹',
    impression_source: 'user',
    updated_by: 'user',
    updated_at: '2026-10-06T00:00:00.000Z',
  })
  assert.match(text, /主人修正过/)
  assert.ok(!text.includes('可能有误'), '用户写的画像不该被标成"可能有误"')
})

test('空档案渲染成空串（不产生"主人对这里的说明："这种空壳）', () => {
  assert.equal(renderProfileForPrompt(undefined), '')
  assert.equal(
    renderProfileForPrompt({
      conversation_key: 'k',
      note: null,
      impression: null,
      impression_source: 'model',
      updated_by: 'user',
      updated_at: 'x',
    }),
    '',
  )
  // 只有备注时也不该多出画像那一行
  const onlyNote = renderProfileForPrompt({
    conversation_key: 'k',
    note: '只有备注',
    impression: null,
    impression_source: 'model',
    updated_by: 'user',
    updated_at: 'x',
  })
  assert.match(onlyNote, /只有备注/)
  assert.ok(!onlyNote.includes('画像'), '没有画像时不该渲染画像行')
})
