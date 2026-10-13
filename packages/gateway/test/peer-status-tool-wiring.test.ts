/**
 * ★★ `peer_input_status` → 工具 的**接线守卫**（用户 2026-10-11 裁定，见 `FIX_PLAN.md` §60 ① / §64）。
 *
 * ## 用户原话
 * 「**不再成为唤醒条件**，而是成为一个**模型可以用来查询的工具**，用来确认对方的状态；
 *  同时**如果他试图对群聊使用，工具返回报错并且提醒不能查询群聊的状态**。」
 *
 * ## 这条改动有两个"半边"，各自都能单独坏掉
 * 1. ★ **摘掉半边**：它必须**不在** `WAKE_CONDITIONS` / 概率表 / 分组里
 *    —— 少摘一处，它仍然是"能唤醒的条件"，而事件路径根本不会唤醒它 ⇒
 *    **面板上有个永远不发生的开关**（这正是改动前的病）。
 * 2. ★ **接上半边**：工具必须**真的**在 `QQ_TOOL_NAMES` 里、**真的**在返回数组里、
 *    而且 `execute` **真的**按 `qq_sessions.kind` 分流
 *    —— 少接一处，模型就没有问状态的入口，而"摘掉"那半边会让这个能力**彻底消失**。
 *
 * ## 为什么守卫要读源码而不是只跑行为
 * 行为测试能证明"函数被调用时是对的"，**证明不了"它被接上了"** ——
 * 本项目栽过好几次："东西写好了、没人调"（§52 的幂等检查、§54 的守卫、§55 的插件侧守卫）。
 * ⇒ 这里一律**读源码 + 去注释 + 断言语句位置**。
 *
 * ★ 每条守卫都跑过注入验证（把对应的那行改坏 ⇒ 红；还原 ⇒ 绿）。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { WAKE_CONDITIONS, WAKE_CONDITION_GROUPS } from '../src/wake.ts'

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8')

/**
 * 去掉源码里的注释（**尊重字符串/模板字面量**）。
 *
 * ★ 必须这么做：本仓注释写得很细，而"它已经被摘掉了"这句话**就写在注释里**
 * ⇒ 不去注释的话，`includes('peer_input_status')` 会命中注释、结论正好相反。
 */
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

// ════════════════════════════════════════════════════════════════════════════
// ① 摘掉半边
// ════════════════════════════════════════════════════════════════════════════

test('★★ 摘掉①：`peer_input_status` 不在 `WAKE_CONDITIONS` 里', () => {
  assert.ok(
    !(WAKE_CONDITIONS as readonly string[]).includes('peer_input_status'),
    '★ 它**不再是唤醒条件**（用户 2026-10-11）。若它回到这张表，' +
      '面板与基线又会说"它能唤醒"，而事件路径永远不会唤醒它 ⇒ 一个永远不发生的开关。',
  )
})

test('★★ 摘掉②：`peer_input_status` 不在任何会话分组里', () => {
  const listed = WAKE_CONDITION_GROUPS.flatMap((g) => [...g.conditions] as string[])
  assert.ok(
    !listed.includes('peer_input_status'),
    '★ 分组是"面板展示哪些条件"的唯一事实来源 ⇒ 它也不该在这里。',
  )
})

test('★★ 摘掉③：概率表里没有 `peer_input_status`（源码级，去注释后）', () => {
  const body = stripComments(read('../src/scheduler.ts'))
  assert.ok(
    !body.includes('peer_input_status'),
    '★ `scheduler.ts` 的概率表里不许再有它 —— 有的话就是"配了也不会发生"的第二处。',
  )
})

test('★★ 摘掉④：`WAKE_CONDITION_PRODUCERS` 里没有它的键（源码级）', () => {
  const body = stripComments(read('../src/wake.ts'))
  // ★ 断言的是**键的位置**：`  peer_input_status: {` 这种形状，而不是任意出现
  assert.ok(
    !/^\s*peer_input_status:\s*\{/m.test(body),
    '★ 那张表按 `WakeCondition` 索引 ⇒ 留一个已摘掉的键会是类型错误，' +
      '而如果类型被放宽（比如 `Record<string, …>`），它就会**静默留下**。',
  )
})

// ════════════════════════════════════════════════════════════════════════════
// ② 接上半边
// ════════════════════════════════════════════════════════════════════════════

test('★★ 接上①：`peer_status` 在 `QQ_TOOL_NAMES` 里', () => {
  const body = stripComments(read('../../dsh-component/src/qq-tools.ts'))
  const idx = body.indexOf('export const QQ_TOOL_NAMES')
  assert.ok(idx >= 0, '找不到 `QQ_TOOL_NAMES`（形状变了？守卫要跟着改）')
  const tail = body.slice(idx, body.indexOf('] as const', idx))
  assert.ok(
    tail.includes("'peer_status'"),
    '★ 工具名表是"有哪些工具"的唯一事实来源（测试与文档共用一份）⇒ 必须在这里。',
  )
})

test('★★ 接上②：`peerStatusTool` 落在 `buildQqTools` 的**返回数组**里（语句位置）', () => {
  const body = stripComments(read('../../dsh-component/src/qq-tools.ts'))
  // ⚠️ 本文件里有**很多** `return [`（每个工具内部都有）⇒ 必须锚在**最后一个**，
  //    那才是 `buildQqTools` 自己的返回。★ 我第一次写成了 `/return \[…/`（取第一个），
  //    结果读到了某个工具内部的数组、守卫假红 —— 这正是"守卫要断言**位置**"的理由。
  const lastReturn = body.lastIndexOf('return [')
  assert.ok(lastReturn >= 0, '找不到 `buildQqTools` 的 `return [...]`（形状变了？守卫要跟着改）')
  const close = body.indexOf(']', lastReturn)
  assert.ok(close > lastReturn, '找不到返回数组的收尾 `]`')
  const returned = body.slice(lastReturn, close)
  assert.ok(
    returned.includes('peerStatusTool'),
    '★ **只定义不返回 = 模型根本拿不到它**。本仓栽过"写了没人调"好几次 ⇒ ' +
      '这里断言的是**返回数组里真的有它**，而不是"文件里出现过这个名字"。',
  )
})

test('★★ 接上③：`execute` 里按 `qq_sessions.kind` 分流，且**群聊分支先返回错误**', () => {
  const body = stripComments(read('../../dsh-component/src/qq-tools.ts'))
  const start = body.indexOf('const peerStatusTool =')
  assert.ok(start >= 0, '找不到 `peerStatusTool` 的定义')
  const tool = body.slice(start, body.indexOf('\n  })', start))
  // ★ 必须查会话表拿 kind —— 不查就没法判群/私聊
  assert.ok(
    tool.includes('SELECT kind FROM qq_sessions WHERE conversation_key = ?'),
    '★ 必须查 `qq_sessions.kind`：会话键 `onebot11:<id>` 本身**看不出**是群还是私聊。',
  )
  // ★ 群聊分支必须存在，且带着用户要的那句话
  assert.ok(tool.includes("row.kind === 'group'"), '★ 群聊分支不见了 —— 用户明确要求它报错')
  assert.ok(
    tool.includes('Group status cannot be queried'),
    '★ 用户原话要求"**提醒不能查询群聊的状态**" ⇒ 这句话必须在返回值里。' +
      '（★ 2026-10-11 `FIX_PLAN.md` §78.10：模型可见文案改英文 ⇒ 断言跟着改成英文版；' +
      '"能不能查"这个**要求本身**没变，只是它的措辞。）',
  )
  // ★★ 语句位置：群聊判定必须在 `isPeerTyping` **之前** ——
  //    反过来的话群聊会先算出一个 typing 值再被丢掉，且"先答后错"的形状容易被改回来
  const groupIdx = tool.indexOf("row.kind === 'group'")
  const typingIdx = tool.indexOf('isPeerTyping(runtime.db')
  assert.ok(typingIdx > groupIdx, '★ 群聊判定必须**在** `isPeerTyping` 之前（先拦后答）')
})

test('★★ 接上④：**不认识的会话也报错**，不许像 `parseTarget()` 那样兜成私聊', () => {
  const body = stripComments(read('../../dsh-component/src/qq-tools.ts'))
  const start = body.indexOf('const peerStatusTool =')
  const tool = body.slice(start, body.indexOf('\n  })', start))
  assert.ok(
    tool.includes('row === undefined'),
    '★ 必须显式处理"查不到这个会话"——对一个还没进表的群答"没人打字"，' +
      '是一句**看起来像答案的错话**，比报错坏得多。',
  )
  // ★ 反向断言：不许在这个工具里调用 `parseTarget(`（它的兜底是 'private'）
  assert.ok(
    !tool.includes('parseTarget('),
    '★ 不许用 `parseTarget()` —— 它把不认识的会话兜成 `private`，' +
      '那正是"看起来像答案的错话"的来源。',
  )
})
