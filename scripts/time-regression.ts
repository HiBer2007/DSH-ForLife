/**
 * 时间感知回归运行器（阶段 4 交付物 9）。
 *
 * 用法：
 *   node scripts/time-regression.ts                 # 自检：只打印题面与判分规则
 *   node scripts/time-regression.ts --driver=headless --profile forlife-headless
 *
 * **两组对比**是本脚本的核心：同一套题分别在"挂时间感知"与"不挂"下各跑一遍。
 * 不挂那一组靠环境变量 `FORLIFE_DISABLE_TIME=1` 关掉注入与 `now()` 工具
 * （实现见 memory-core 的判定与 clock-tools 的开关）。
 *
 * 为什么默认只自检：本机没有模型凭据，跑真模型会直接失败。
 * 与其假装跑过，不如明确说"需要凭据"——这也是验收里那条 [~] 的原因。
 */
import { execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { compareRegression, scoreRegression, timeQuestions } from '../packages/memory-core/src/index.ts'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 解析命令行参数。 */
function arg(name: string, fallback?: string): string | undefined {
  const hit = process.argv.find((value) => value.startsWith(`--${name}=`))
  return hit === undefined ? fallback : hit.slice(name.length + 3)
}

/** 用 headless 驱动问一道题。 */
function askHeadless(profile: string, prompt: string, disableTime: boolean): string {
  try {
    return execFileSync('dsh', ['--profile', profile, '--no-open', prompt], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      shell: true,
      timeout: 180_000,
      env: {
        ...process.env,
        ...(disableTime ? { FORLIFE_DISABLE_TIME: '1' } : {}),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; message?: string }
    // 失败也要把原因带回去判分（"答不出来"本身就是一种结果）
    return `${err.stdout ?? ''}\n${err.stderr ?? ''}\n（调用失败：${err.message ?? ''}）`
  }
}

/** 主流程。 */
function main(): number {
  const questions = timeQuestions(new Date())
  const driver = arg('driver', 'selfcheck')

  if (driver === 'selfcheck') {
    console.log('题库自检（不调用模型）：\n')
    for (const question of questions) {
      console.log(`  ${question.id}: ${question.question}`)
      console.log(`      期望命中：${question.expect.map(String).join(' | ')}`)
      if (question.reject !== undefined) console.log(`      禁止出现：${question.reject.map(String).join(' | ')}`)
    }
    console.log(
      '\n要跑真模型对比，请给凭据后执行：\n' +
        '  node scripts/time-regression.ts --driver=headless --profile forlife-headless\n' +
        '（本机没有模型凭据，所以这一项在验收里标 [~]）',
    )
    return 0
  }

  const profile = arg('profile', 'forlife-headless') ?? 'forlife-headless'
  const runGroup = (disableTime: boolean): Record<string, string> => {
    const answers: Record<string, string> = {}
    for (const question of questions) {
      answers[question.id] = askHeadless(profile, question.question, disableTime)
    }
    return answers
  }

  console.log('第 1 组：挂时间感知…')
  const withClock = scoreRegression(questions, runGroup(false))
  console.log('第 2 组：对照组（关掉时间感知）…')
  const withoutClock = scoreRegression(questions, runGroup(true))

  const verdict = compareRegression(withClock, withoutClock)
  console.log(`\n挂：${String(withClock.correct)}/${String(withClock.total)}`)
  console.log(`不挂：${String(withoutClock.correct)}/${String(withoutClock.total)}`)
  console.log(`\n结论：${verdict.verdict}`)
  return verdict.causal ? 0 : 1
}

process.exit(main())
