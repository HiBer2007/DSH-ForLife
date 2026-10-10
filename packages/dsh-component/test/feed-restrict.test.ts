/**
 * 投喂期工具收窄的守卫（用户 2026-10-10 指定）。
 *
 * ## 这个文件在钉什么
 *
 * 用户原话：「**只开放有关于记忆和文件读写的工具**，其他的比如 **QQ、沙箱**等都不开放
 * **以限制其不允许干别的**」。
 *
 * 那条要求有两种写法，而**只有一种能被测试钉住**：
 *  - 「不许有 QQ 工具」⇒ 只能靠**枚举**（DSH 以后加一个新的 QQ 工具，我就漏了）
 *  - 「**只许有这些**」⇒ 白名单，**反面 + 正面都能钉**
 *
 * ⇒ 我们用白名单（`allow`），而这个文件**两侧都钉**：
 *  - **反面**：用户点名的那几类（`qq_*` / 沙箱 / 子代理 / 状态类）**一个都不许在里面**
 *  - **正面**：白名单里的名字**必须真的存在**（拼错的名字会让"限制"**静默失效**）
 *  - **机制**：必须用 `allow`（白名单），**不许**用 `deny`（黑名单）——
 *    黑名单的失败方向是"悄悄多给了一个能发 QQ 消息的工具"
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  FEED_ALLOWED_TOOLS,
  FEED_FORBIDDEN_EXACT,
  FEED_FORBIDDEN_PREFIXES,
  restrictToolsForFeed,
  type ToolRestrictFilter,
} from '../src/feed-restrict.ts'

test('★★ 反面：QQ / 沙箱 / 子代理 / 状态类**一个都不许**在投喂白名单里', () => {
  // 一份"用户点名不许开"的**具体工具名**清单 —— 取自生产启动日志里的 43 个工具
  // （`qq_*` 一整族 + `pwsh` + 子代理 + 会改状态/排未来事的那些）
  const forbidden = [
    'qq_reply',
    'qq_react',
    'qq_typing',
    'qq_send_image',
    'qq_send_file',
    'qq_recall',
    'qq_forward',
    'qq_requests',
    'qq_handle_request',
    'qq_contacts',
    'qq_send_sticker',
    'qq_mention_all',
    'qq_group_notice',
    'sticker_search',
    'sticker_import',
    'sticker_save',
    'pwsh', // ★ 用户原话点名的"沙箱"
    'workflow',
    'subagent',
    'subagent_fork',
    'set_status',
    'clear_system_status',
    'schedule_wake',
    'register_watcher',
    'switch_model',
  ]
  for (const name of forbidden) {
    assert.ok(
      !FEED_ALLOWED_TOOLS.includes(name),
      `「${name}」**不许**在投喂白名单里 —— 用户要的是"限制它不允许干别的"（QQ/沙箱都不开放）`,
    )
  }

  // 前缀清单也要真的能挡住 —— 免得有人把 `qq_` 从常量里删掉却没人发现
  for (const prefix of FEED_FORBIDDEN_PREFIXES) {
    const leaked = FEED_ALLOWED_TOOLS.filter((tool) => tool.startsWith(prefix))
    assert.deepEqual(leaked, [], `没有工具该以「${prefix}」开头出现在白名单里`)
  }
  for (const name of FEED_FORBIDDEN_EXACT) {
    assert.ok(!FEED_ALLOWED_TOOLS.includes(name), `「${name}」在点名禁用的清单里`)
  }
})

test('★★ 正面：白名单非空、无重复、且**只含记忆与文件读写**', () => {
  assert.ok(FEED_ALLOWED_TOOLS.length > 0, '白名单不能是空的 —— 空的等于"她什么都干不了"')
  assert.equal(
    new Set(FEED_ALLOWED_TOOLS).size,
    FEED_ALLOWED_TOOLS.length,
    '白名单里不许有重复（重复说明有人手工合过两份清单）',
  )

  // 每一条都得归入"记忆"或"文件读写"两组之一 —— 归不进去的就是**混进来的**
  const memory = new Set(['remember', 'push_mid_memory', 'feed_memory', 'recall_longterm', 'recall_full', 'recall_mid'])
  const fileSystem = new Set(['read', 'read_image', 'write', 'edit'])
  for (const tool of FEED_ALLOWED_TOOLS) {
    assert.ok(
      memory.has(tool) || fileSystem.has(tool),
      `「${tool}」既不是记忆工具也不是文件读写工具 —— 用户只开放这两类。` +
        '要加新的类别，先问用户（这条断言就是那道门）',
    )
  }
})

test('★★ 机制：用 `allow` 白名单（**不是** `deny` 黑名单），且 dispose 幂等', () => {
  const seen: ToolRestrictFilter[] = []
  let disposed = 0
  const host = {
    restrict: (filter: ToolRestrictFilter) => {
      seen.push(filter)
      return {
        dispose: () => {
          disposed += 1
        },
      }
    },
  }

  const logs: string[] = []
  const release = restrictToolsForFeed(host, (message) => logs.push(message))

  assert.equal(seen.length, 1, '只该调一次 restrict')
  const filter = seen[0] as ToolRestrictFilter
  assert.ok(filter.allow !== undefined, '★ 必须用 `allow`（白名单）—— 见文件头"黑名单必然漏"')
  assert.equal(filter.deny, undefined, '★ 不许用 `deny`：黑名单的失败方向是"悄悄多给了一个工具"')
  assert.deepEqual(
    [...(filter.allow as ReadonlySet<string>)].sort(),
    [...FEED_ALLOWED_TOOLS].sort(),
    'allow 集合必须**逐字**来自那个常量 —— 别在调用处再拼一份',
  )

  // 收窄这件事必须**留痕**（否则排障时没人知道那一轮为什么她不能发消息）
  assert.ok(
    logs.some((line) => line.includes('收窄')),
    `收窄必须打一行日志（实际：${logs.join(' | ')}）`,
  )

  // ★ 幂等：解除函数会被"正常路径的 finally"和"超时路径"各调一次
  release()
  release()
  assert.equal(disposed, 1, 'dispose 必须幂等 —— 调两次不许把宿主搞炸')
  assert.ok(
    logs.some((line) => line.includes('恢复')),
    '解除也要留痕（"什么时候恢复的"同样是排障要问的）',
  )
})
