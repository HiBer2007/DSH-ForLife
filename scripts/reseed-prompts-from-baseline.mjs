/**
 * **把库里的提示词重新播种成当前基线**（一次性运维动作，`FIX_PLAN.md` §78.15）。
 *
 * ## 什么时候用它
 *
 * `seedDefaultPrompts()` **只在没有 active 版本时**播种 ⇒ 基线后来改了，库里那份不会追
 * （§78.8 查出来的那件事：生产跑着一份 4 天前的中文基线）。
 * 用户在 2026-10-12 裁定「① 重新播种到英文」⇒ 用这个脚本一次做完。
 *
 * ## 它做的三件事（与面板保存**完全同一套**）
 *
 * 1. `savePromptRevision(db, { slug, text, createdBy: 'admin', note })` —— 校验 + 规范化 + 落库；
 * 2. `recordAdminAction(db, { action: 'prompt.edit', … })` —— 审计留痕（面板保存也会记这条）；
 * 3. 打印"改了什么"（旧 sha → 新 sha、token 数），并提示**要重启 dsh**（插件有提示词缓存）。
 *
 * ## 安全闸（★ 别去掉）
 *
 * - **默认拒绝覆盖"人改过的"那份**：库里 active 的 `created_by` 不是 `system` 就停下
 *   （那是面板上人写的，覆盖它正是 §78.8 划的红线）。真要覆盖得显式 `--force`；
 * - 必须显式 `--yes`（这个脚本会改模型的提示词，不能"手滑跑一下"）；
 * - `--dry-run` 只看不改。
 *
 * ## 跑法（在 dsh 容器里，因为库在那儿）
 *
 * ★ **必须放到某个包的目录下**（不能放 `/tmp`）：镜像里 `/app/node_modules` 只有 `@deepseek-ai`，
 * `@forlife/*` 的软链在**各个包自己的** `node_modules` 下 ⇒ 放 `/tmp` 会
 * `ERR_MODULE_NOT_FOUND: Cannot find package '@forlife/store'`（真机踩过）。
 *
 * ```
 * docker cp scripts/reseed-prompts-from-baseline.mjs \
 *   forlife-dsh-1:/app/packages/dsh-component/reseed-prompts.mjs
 * docker exec forlife-dsh-1 node /app/packages/dsh-component/reseed-prompts.mjs --dry-run
 * docker exec forlife-dsh-1 node /app/packages/dsh-component/reseed-prompts.mjs --yes
 * docker restart forlife-dsh-1     # ★ 插件有缓存，必须重启才生效
 * ```
 */
import { readFileSync } from 'node:fs'

const DB = process.env.FORLIFE_DB ?? '/data/dsh/forlife/db/forlife.sqlite'
const BASELINE = process.env.FORLIFE_BASELINE ?? '/app/packages/contracts/plan-baseline.json'

const argv = process.argv.slice(2)
const YES = argv.includes('--yes')
const FORCE = argv.includes('--force')
const DRY = argv.includes('--dry-run')

if (!YES && !DRY) {
  console.error('✖ 这个脚本会改模型的提示词。请显式加 --yes（或 --dry-run 只看不改）。')
  process.exit(2)
}

const { openDatabase, activePrompt, savePromptRevision, PROMPT_SLUGS, promptSeedDrift } = await import('@forlife/store')
const { recordAdminAction } = await import('/app/packages/gateway/src/reports.ts')

/** 槽位 → 基线键（与 `store/src/prompt-store.ts` 的 `seedDefaultPrompts` 同一套口径）。 */
const KEY = { 'p1-system': 'prompt.p1Default', 'p2-style': 'prompt.p2Default' }

const baseline = JSON.parse(readFileSync(BASELINE, 'utf8'))
const opened = openDatabase({ file: DB })

console.log(`库：${DB}`)
console.log(`基线：${BASELINE}`)
console.log('')

let refused = 0
let changed = 0
let same = 0

for (const slug of PROMPT_SLUGS) {
  const active = activePrompt(opened.db, slug)
  const text = String(baseline.params[KEY[slug]].v)
  const label = `${slug}`.padEnd(10)

  if (active === undefined) {
    console.log(`${label} 库里没有 active 版本 ⇒ 会新建一版（这份不会覆盖任何东西）`)
  } else if (active.text === text) {
    console.log(`${label} 与基线逐字一致（${active.sha256.slice(0, 12)}…）⇒ 不用动`)
    same += 1
    continue
  } else if (active.createdBy !== 'system' && !FORCE) {
    console.log(
      `${label} ✖ **拒绝覆盖**：库里那份是 \`${active.createdBy}\` 建的（${active.createdAt}）` +
        `，那是人/模型写的，不是播种的 ⇒ 要覆盖请显式 --force`,
    )
    refused += 1
    continue
  }

  if (DRY) {
    console.log(`${label} [dry-run] ${active?.sha256.slice(0, 12) ?? '(无)'}… → 基线 ${String(text.length)} 字符`)
    continue
  }

  const result = savePromptRevision(opened.db, {
    slug,
    text,
    createdBy: 'admin',
    note:
      '用户 2026-10-12 裁定「按英文基线重新播种」（原话："① 重新播种到英文"）；' +
      '基线文案见 packages/contracts/plan-baseline.json 的 ' +
      KEY[slug] +
      '。改前那份的中文原文可用 git show cee6b76:packages/contracts/plan-baseline.json 查到。',
  })
  if (!result.ok) {
    console.log(`${label} ✖ 校验没过：${result.errors.join('；')}`)
    process.exitCode = 1
    continue
  }
  if (!result.changed) {
    console.log(`${label} 规范化后与当前版本一致 ⇒ 没有产生新版本`)
    same += 1
    continue
  }

  // ★ 与面板保存同一条审计（面板走 api.ts，也记这一条）
  recordAdminAction(opened.db, {
    action: 'prompt.edit',
    actor: 'admin',
    subject: slug,
    detail: { from: active?.sha256 ?? null, to: result.revision.sha256, tokens: result.revision.tokenCount, via: 'reseed-script' },
  })
  console.log(
    `${label} ✓ ${active?.sha256.slice(0, 12) ?? '(无)'}… → ${result.revision.sha256.slice(0, 12)}…` +
      `（${String(result.revision.tokenCount)} token）`,
  )
  changed += 1
}

console.log('')
console.log('改后读数（库里 vs 基线）：')
for (const row of promptSeedDrift(opened.db)) {
  console.log(`  ${row.slug.padEnd(10)} ${row.verdict.padEnd(8)} 库里 ${row.activeSha256?.slice(0, 12) ?? '(无)'}… / 基线 ${row.baselineSha256.slice(0, 12)}…`)
}
console.log('')
console.log(`小结：改了 ${String(changed)} · 本来一致 ${String(same)} · 拒绝 ${String(refused)}`)
if (DRY) console.log('（--dry-run：什么都没改）')
else if (changed > 0) {
  console.log('')
  console.log('★ 下一步（必须）：docker restart forlife-dsh-1 —— 插件里有提示词缓存，不重启不生效。')
  console.log('  重启后在启动日志里应当看到这两行变成「与基线一致」。')
}
opened.close()
