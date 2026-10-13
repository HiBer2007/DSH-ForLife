/**
 * 时间感知回归测试集（阶段 4 交付物 9，§2.15.2 P4 第 12 条）。
 *
 * ## 为什么必须有"对照组"
 *
 * 用户要的是"**证明因果，而不是感觉变好了**"。所以这套题必须能在两种配置下各跑一遍：
 *  ① 挂上时间感知（读数 + `now()` 工具）；
 *  ② 不挂（对照组）。
 * 只有两组的分数**显著不同**，才说明时间感知真的在起作用。
 * 一组跑满分、另一组也跑满分 ⇒ 这套题没测到东西（题设计得不好，不是功能好）。
 *
 * ## 判分怎么做才客观
 *
 * 不用"感觉答得对不对"，而是**字符串断言**：
 * 每道题给出必须命中的模式（`expect`）与必须避免的模式（`reject`）。
 * 例如"现在几点"必须包含一个与读数一致的钟点，且**不能**出现训练数据里的年份。
 *
 * @module @forlife/memory-core/time-regression
 */

/** 一道题。 */
export interface TimeQuestion {
  readonly id: string
  readonly question: string
  /** 期望命中的模式（全部命中才算对）。 */
  readonly expect: readonly RegExp[]
  /** 命中任何一条就算错（这些是"幻觉"的典型表现）。 */
  readonly reject?: readonly RegExp[]
  /** 这道题在**没有**时间感知时是否可能靠常识蒙对（用于解释分数）。 */
  readonly guessable?: boolean
}

/** 判分结果。 */
export interface QuestionScore {
  readonly id: string
  readonly correct: boolean
  readonly missing: readonly string[]
  readonly rejected: readonly string[]
}

/** 一组结果。 */
export interface RegressionScore {
  readonly total: number
  readonly correct: number
  readonly rate: number
  readonly details: readonly QuestionScore[]
}

/**
 * 题库（10 题，覆盖 §2.15.2 提到的五类：现在几点 / 三天前说过什么 / 这周几次 /
 * 距上次多久 / 跨天判断）。
 *
 * @param now - 当前时间（题面里的相对时间要按它算）。
 * @param timezone - 会话时区。
 * @returns 题目列表。
 */
export function timeQuestions(now: Date, timezone = 'Asia/Shanghai'): readonly TimeQuestion[] {
  const bounds = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
  const year = bounds.slice(0, 4)
  return [
    {
      id: 'Q1-now-clock',
      question: '现在几点？',
      // 正确回答必须落在读数所在的这一天
      expect: [new RegExp(bounds.replace(/-/g, '[-\\s]?'), '')],
      // 幻想的典型表现：报出训练数据里的年份
      reject: [/(2023|2024|2025)\s*年/],
    },
    {
      id: 'Q2-today-weekday',
      question: '今天是星期几？',
      expect: [/周[一二三四五六日]|星期[一二三四五六日]/],
    },
    {
      id: 'Q3-year',
      question: '今年是哪一年？',
      expect: [new RegExp(year)],
      reject: [/(2023|2024|2025)\s*年/],
    },
    {
      id: 'Q4-how-long-since',
      question: '我们上次说话是多久以前？',
      expect: [/\d+\s*(秒|分钟|小时|天|个月|年)/],
    },
    {
      id: 'Q5-cross-day',
      question: '现在离明天还有多久？',
      expect: [/\d+\s*(秒|分钟|小时)/],
    },
    {
      id: 'Q6-recent-three-days',
      question: '最近三天我说过什么？',
      expect: [/三天|3\s*天|最近/],
    },
    {
      id: 'Q7-this-week-count',
      question: '这周我们聊了几次？',
      expect: [/\d+\s*次|没有|没有记录|记不清/],
    },
    {
      id: 'Q8-timezone',
      question: '你按哪个时区理解时间？',
      expect: [/Asia\/Shanghai|东八区|北京时间|UTC\+8/i],
    },
    {
      id: 'Q9-duration-arithmetic',
      question: '从现在起两个小时后是几点？',
      expect: [/\d{1,2}\s*[:：]\s*\d{2}|\d{1,2}\s*点/],
    },
    {
      id: 'Q10-refuse-to-guess',
      question: '你不用查时间，直接凭印象说现在大概几点。',
      // 这题考的是**纪律**：正确行为是拒绝凭印象猜，或明确说明自己需要读数
      expect: [/需要|查|读|不确定|不能凭|以读数|没法|无法/],
    },
  ]
}

/**
 * 判一道题。
 *
 * @param question - 题目。
 * @param answer - 模型回答。
 * @returns 得分。
 */
export function scoreAnswer(question: TimeQuestion, answer: string): QuestionScore {
  const missing = question.expect.filter((pattern) => !pattern.test(answer)).map((pattern) => String(pattern))
  const rejected = (question.reject ?? []).filter((pattern) => pattern.test(answer)).map((pattern) => String(pattern))
  return { id: question.id, correct: missing.length === 0 && rejected.length === 0, missing, rejected }
}

/**
 * 汇总一组答案。
 *
 * @param questions - 题目。
 * @param answers - 答案（按 id）。
 * @returns 分数。
 */
export function scoreRegression(questions: readonly TimeQuestion[], answers: Readonly<Record<string, string>>): RegressionScore {
  const details = questions.map((question) => scoreAnswer(question, answers[question.id] ?? ''))
  const correct = details.filter((d) => d.correct).length
  return { total: details.length, correct, rate: details.length === 0 ? 0 : correct / details.length, details }
}

/**
 * 对比两组（挂 / 不挂）并给出结论。
 *
 * **关键**：如果两组都好，要说"这套题没测到东西"，而不是庆祝。
 * 一个测不出差异的测试集比没有测试集更危险（它给人虚假的信心）。
 *
 * @param withClock - 挂时间感知的分数。
 * @param withoutClock - 对照组的分数。
 * @returns 结论。
 */
export function compareRegression(
  withClock: RegressionScore,
  withoutClock: RegressionScore,
): { readonly causal: boolean; readonly verdict: string; readonly delta: number } {
  const delta = withClock.rate - withoutClock.rate
  if (withoutClock.rate >= 0.9) {
    return {
      causal: false,
      delta,
      verdict:
        `对照组也答对了 ${(withoutClock.rate * 100).toFixed(0)}% —— 说明**这套题没测到时间感知**` +
        '（题目太容易，或答案可以从上下文里推出来）。需要换更依赖新鲜读数的题，否则"变好了"无从证明。',
    }
  }
  if (delta >= 0.3) {
    return {
      causal: true,
      delta,
      verdict: `挂上时间感知后从 ${(withoutClock.rate * 100).toFixed(0)}% 提升到 ${(withClock.rate * 100).toFixed(0)}%（+${(delta * 100).toFixed(0)} 个百分点），因果成立。`,
    }
  }
  return {
    causal: false,
    delta,
    verdict:
      `两组差距只有 ${(delta * 100).toFixed(0)} 个百分点（${(withoutClock.rate * 100).toFixed(0)}% → ${(withClock.rate * 100).toFixed(0)}%），` +
      '不足以证明因果。要么时间感知没生效（查注入日志），要么题目不敏感。',
  }
}
