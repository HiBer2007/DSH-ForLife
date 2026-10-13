/**
 * ★★★ **"模型会读到的句子"英文棘轮**（`FIX_PLAN.md` §78.16）。
 *
 * ## 这个面是什么
 *
 * 工具 schema 那个面已经全 0（`dsh-component/test/tool-schema-english.test.ts`），
 * 但**模型读到的字**不止 schema：每轮注入的框架文字、工具返回值里的 `hint/note/reason`、
 * 以及进上下文的通知块，都来自**库函数**。
 *
 * 这一支守的就是那些库函数：**它们的返回串里还剩多少中文**。
 *
 * ## 判据（与 `.runtime/audit-tool-libs-zh.mjs` 同一套，读数要对得上）
 *
 * 取函数体（到下一个顶层 `export` 为止），逐行看：
 *   - 含中日韩字符，且
 *   - 不是注释行，且
 *   - **不是** `log(` / `atLevel(` / `always(` / `console.*` 这类**运维日志**（那些按 §76.5② 保留中文）。
 *
 * ## 纪律
 *
 * 数字**只能往下调**（与工具 schema 那条棘轮同一个规矩）：
 * 翻了就把上限调下来；★ 谁要往上加，先想清楚"这句话是给模型看的吗"。
 *
 * ## 明确**不在**这里的（按设计保留中文，别顺手翻掉）
 *
 * - `buildForwardNodes` / `buildForwardNodesFromIds`：合并转发**卡片正文** ——
 *   那是 **QQ 用户**看到的字，不是模型看的；
 * - `admin-ui/utils/message-labels.ts`：面板那张消息段标签表；
 * - 所有 `runtime.ts` / `api.ts`（面板接口）里的运维与面板文案。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

/** 中日韩统一表意文字（与工具棘轮同一套判据）。 */
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/

/** 运维/面板日志：这些**不翻**，数的时候要排掉。 */
const LOG_CALL = /\b(?:log|atLevel|always|console\.\w+)\s*\(/

/**
 * ★ **棘轮**：`文件 → 函数名 → 上限`。数字只许往下调。
 *
 * ★★ **0 = 已翻完**（2026-10-12 的 §78.16 第 1/2 批）；其余数字 = 还没翻的余量。
 */
const CEILING: Readonly<Record<string, Readonly<Record<string, number>>>> = {
  // ── ★ 已翻完（0）：时间读数 / 每轮入站块 / 限流理由 / 未读积压 / 送达确认 ──
  'packages/memory-core/src/clock.ts': {
    renderTimeBlock: 0,
    describeReason: 0,
    formatDuration: 0,
    formatRelative: 0,
    formatHuman: 0,
  },
  'packages/gateway/src/turns.ts': { buildTurnPrompt: 0 },
  'packages/gateway/src/limits.ts': { backlogReadQuota: 0, decideSendQuota: 0, deliverPacing: 0 },
  'packages/gateway/src/backlog.ts': { backlogNotice: 0, renderBacklogNotice: 0 },
  'packages/gateway/src/outbox.ts': { waitForConfirmation: 0 },
  // ── 还没翻（数字只许往下调）──
  'packages/gateway/src/feed-batch.ts': { feedInput: 0 }, // ✅ 2026-10-12 第 3 批翻完
  'packages/gateway/src/sticker-service.ts': { createStickerService: 0 }, // ✅ 2026-10-12 第 3 批翻完
  'packages/gateway/src/sticker-vision.ts': { createStickerVisionDescriber: 0 }, // ✅ 只翻了**报错**；给视觉模型的那段提示**故意留中文**（它产出的是数据：中文描述与检索标签）
  'packages/gateway/src/port-service.ts': { createPortService: 0 }, // ✅ 2026-10-12 第 3 批翻完
  'packages/router/src/routes.ts': { decideSwitch: 0, assertNotSubagentSwitch: 0 }, // ✅ 换模型的拒绝理由 + 路由表 note
  'packages/gateway/src/feed.ts': { FEED_DELETE_HINT: 1 }, // ★ 只剩一个**故意的**中文：面板页面名「记忆条目」（那句话是给模型转述给人的，页面名照抄才找得到）
  'packages/gateway/src/status.ts': { setModelStatus: 0 }, // ✅ 2026-10-12 第 3 批翻完
  // ★ 这一条**不是**模型面（面板/代理运维文案，按 §76.5② 保留中文）：
  //   它出现在这里只是因为 `dsh-component/route-seed.ts` 会 import 它 ⇒ 登记上限只为"别涨"。
  'packages/gateway/src/caddy.ts': { createCaddyClient: 28 },
}

/** 去注释（按行处理，够用；块注释里的行整行丢弃）。 */
function stripComments(lines: readonly string[]): string[] {
  let inBlock = false
  return lines.map((line) => {
    let out = line
    if (inBlock) {
      const end = out.indexOf('*/')
      if (end < 0) return ''
      out = out.slice(end + 2)
      inBlock = false
    }
    const block = out.indexOf('/*')
    if (block >= 0) {
      const end = out.indexOf('*/', block + 2)
      if (end < 0) {
        inBlock = true
        out = out.slice(0, block)
      } else {
        out = out.slice(0, block) + out.slice(end + 2)
      }
    }
    const lineComment = out.indexOf('//')
    return lineComment >= 0 ? out.slice(0, lineComment) : out
  })
}

/** 取一个函数/常量的体（到下一个顶层 `export` 为止）。 */
function bodyOf(source: string, name: string): string | undefined {
  const pattern = new RegExp(`export\\s+(?:async\\s+)?(?:function|const)\\s+${name}\\b`)
  const start = source.search(pattern)
  if (start < 0) return undefined
  const rest = source.slice(start)
  const next = rest.slice(1).search(/\nexport\s/)
  return next < 0 ? rest : rest.slice(0, next + 1)
}

test('★★★ 模型会读到的库函数：中文行数不得超过棘轮（只许往下调）', () => {
  const readings: string[] = []
  const over: string[] = []

  for (const [file, functions] of Object.entries(CEILING)) {
    const source = stripComments(readFileSync(file, 'utf8').split(/\r?\n/)).join('\n')
    for (const [name, ceiling] of Object.entries(functions)) {
      const body = bodyOf(source, name)
      assert.ok(body !== undefined, `★ ${file} 里找不到 ${name}（改名了就要来改这张表，别让它静默失效）`)
      const count = String(body)
        .split('\n')
        .filter((line) => CJK.test(line) && !LOG_CALL.test(line)).length
      readings.push(`${file.split('/').pop() ?? file}·${name} ${String(count)}/${String(ceiling)}`)
      if (count > ceiling) over.push(`${name}（${file}）：现在 ${String(count)} 行，上限 ${String(ceiling)}`)
    }
  }

  assert.deepEqual(
    over,
    [],
    '★ 这些库函数里**新出现了中文**（模型会读到）—— 要么翻掉，要么先问"这句是给模型看的吗"：\n' +
      over.join('\n'),
  )
  // 读数打出来，方便一眼看到"还剩多少"（与 `.runtime/audit-tool-libs-zh.mjs` 的数要对得上）
  console.log(`    ${readings.join(' · ')}`)
})

test('★ 已经在棘轮里的函数**仍然存在**（改名/删除必须来改表，不能静默失效）', () => {
  for (const [file, functions] of Object.entries(CEILING)) {
    const source = readFileSync(file, 'utf8')
    for (const name of Object.keys(functions)) {
      assert.match(
        source,
        new RegExp(`export\\s+(?:async\\s+)?(?:function|const)\\s+${name}\\b`),
        `${file} 里必须仍然导出 ${name}`,
      )
    }
  }
})
