/**
 * 模型死循环监控（用户要求："如果模型连续输出了上百次同样/重复的文字
 * （陷入死循环）则自动停之本轮次然后重启。这个检查需要智能/自动进行"）。
 *
 * ## 为什么"数重复次数"不够（"智能/自动"要求在哪）
 *
 * 最笨的做法是"同一句话出现 N 次就停"。它有两个洞：
 *
 * 1. **模型不会一字不差地重复** —— 它会在重复里插入变化：
 *    `好的，我明白了。` / `好的，我明白了！` / ` 好的，我明白了。`
 *    ⇒ **必须归一化**（去空白、统一标点、忽略大小写）；
 * 2. **循环常常是"周期"而不是"整句重复"** ——
 *    `我先看看…我先看看…我先看看…` 或者
 *    `A B C A B C A B C`（三个一组转圈）。
 *    只看"整句相同"的话，**周期循环会漏掉**。
 *
 * 所以这个检测器看**三件事**，任一条越线就判定：
 * - **重复率**：最近 N 条里，归一化后**不同**的条数太少；
 * - **周期性**：最近一段文本是**某个短周期在重复**（`abcabcabc`）；
 * - **原地打转**：连续多条**首尾相同**（改了几个字，但说的还是同一件事）。
 *
 * ## 为什么"停本轮"而不是"重试同一轮"
 *
 * 用户要的是"**停之本轮次然后重启**"。
 * **重试同一轮是错的** —— 上下文里已经堆满了那堆重复文字，
 * 模型看到它只会**接着循环**（而且更容易循环）。
 * 所以 `stop` 的语义是：**丢掉这一轮的产出，从干净的状态重来**。
 * 返回的 `action` 里区分了 `stop-and-restart` 与 `warn`，
 * 由调用方决定怎么重启（我们不该在这里猜）。
 *
 * ## 一条纪律：**判定要能解释**
 *
 * 返回 `reason` 而不是布尔 —— 否则线上出现"莫名其妙被停了"时，
 * **没人知道是哪条规则误判了**。三个信号各自报数，便于调阈值。
 *
 * @module @forlife/store/loop-guard
 */

/** 归一化：去掉所有"不影响语义"的差异。 */
export function normalizeForLoop(text: string): string {
  return (
    text
      // 空白（含全角空格）全部去掉 —— 换行/缩进不该算"不同的输出"
      .replace(/[\s\u3000]+/g, '')
      // 标点统一（模型经常在重复里换标点：`。` / `！` / `，`）
      .replace(/[，,、；;：:]/g, ',')
      .replace(/[。.！!？?…~～]+/g, '.')
      .replace(/[""'']/g, '"')
      .toLowerCase()
  )
}

/**
 * 两条归一化文本的**相似度**（0..1）。
 *
 * 用**公共前缀 + 公共后缀**占较短那条的比例 ——
 * 这正是"改了几个字但说的还是同一件事"的形状：
 * 开头一样、结尾一样（或结尾只差一点），中间换词。
 *
 * **不用编辑距离**：那个是 O(n²)，而这里要跑在**每一次模型输出**上；
 * 前后缀比对是 O(n)，够用且够快。
 */
export function similarity(a: string, b: string): number {
  const shorter = Math.min(a.length, b.length)
  if (shorter === 0) return 0
  let pre = 0
  while (pre < shorter && a[pre] === b[pre]) pre += 1
  let suf = 0
  while (suf < shorter - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf += 1
  return (pre + suf) / shorter
}

/** 判定结果。 */
export interface LoopVerdict {
  /** `ok` 正常 / `warn` 可疑 / `stop-and-restart` 判定死循环。 */
  readonly action: 'ok' | 'warn' | 'stop-and-restart'
  /** **能解释**的判定理由（哪条规则、各自多少）。 */
  readonly reason: string
  /** 三个信号的读数（便于调阈值与排障）。 */
  readonly signals: {
    readonly samples: number
    readonly distinct: number
    readonly repeatRatio: number
    readonly period: number
    readonly headTailMatch: number
  }
}

/** 阈值（**都能调** —— 不同模型/任务的"正常重复"程度不一样）。 */
export interface LoopPolicy {
  /**
   * 看最近多少条。
   *
   * **不能太小**：太小时正常对话也会"重复"（比如连说三句"嗯"）；
   * **不能太大**：太大会把"隔了很久又说了一遍"也算进去。
   */
  readonly window: number
  /** 重复率**达到**这个值就算可疑（0..1）。 */
  readonly repeatRatio: number
  /** 周期长度 ≤ 这个值，且重复 ≥ `minPeriodRepeats` 次 ⇒ 判周期循环。 */
  readonly maxPeriod: number
  readonly minPeriodRepeats: number
  /** 连续多少条"首尾相同"算原地打转。 */
  readonly headTailRun: number
}

/**
 * 默认阈值。
 *
 * 用户说的"**上百次**"是**明确越线**的量级 —— 默认阈值比它**早得多**地拦下来
 * （到 100 次才停的话，token 早就烧完了）。这里取 ~12 条高度重复即停：
 * 正常对话里**不会**出现 12 条归一化后只有 2–3 种的内容。
 */
export const DEFAULT_LOOP_POLICY: LoopPolicy = {
  window: 24,
  repeatRatio: 0.85,
  maxPeriod: 200,
  minPeriodRepeats: 6,
  headTailRun: 8,
}

/**
 * 死循环检测器。
 *
 * **有状态**（要跨多次输出累计），所以是类不是纯函数。
 * 每次 `feed()` 一条**新的模型输出**（一段文本 / 一次工具调用的摘要）。
 */
export class LoopGuard {
  private readonly policy: LoopPolicy
  private readonly recent: string[] = []
  private all = ''

  constructor(policy: LoopPolicy = DEFAULT_LOOP_POLICY) {
    this.policy = policy
  }

  /** 喂一条新的模型输出，返回判定。 */
  feed(text: string): LoopVerdict {
    const norm = normalizeForLoop(text)
    if (norm !== '') {
      this.recent.push(norm)
      if (this.recent.length > this.policy.window) this.recent.shift()
      // 保留一段原文用于周期检测（**只留够检测的长度**，别把整轮存下来）
      this.all = (this.all + norm).slice(-Math.max(this.policy.maxPeriod * this.policy.minPeriodRepeats * 2, 4000))
    }
    return this.judge()
  }

  /** 只判定、不喂新数据（用于"现在什么状态"）。 */
  judge(): LoopVerdict {
    const samples = this.recent.length
    const distinct = new Set(this.recent).size
    // **重复率**：不同条数越少越可疑。1 - distinct/samples
    const repeatRatio = samples === 0 ? 0 : 1 - distinct / samples

    const period = this.detectPeriod()
    const headTailMatch = this.headTailRun()

    const signals = { samples, distinct, repeatRatio, period, headTailMatch }

    // 样本太少 ⇒ **不下结论**（那是"还没看够"，不是"正常"）
    if (samples < Math.min(6, this.policy.window)) {
      return { action: 'ok', reason: `样本不足（${String(samples)} 条），不下结论`, signals }
    }

    // ── ① 周期循环（**最典型的死循环**：短周期反复）──
    if (period > 0) {
      return {
        action: 'stop-and-restart',
        reason: `**周期循环**：最近文本是 ${String(period)} 字符的周期在重复（≥ ${String(this.policy.minPeriodRepeats)} 次）`,
        signals,
      }
    }

    // ── ② 高度重复 ──
    if (repeatRatio >= this.policy.repeatRatio && samples >= 8) {
      return {
        action: 'stop-and-restart',
        reason:
          `**高度重复**：最近 ${String(samples)} 条里只有 ${String(distinct)} 种不同内容` +
          `（重复率 ${(repeatRatio * 100).toFixed(0)}% ≥ ${(this.policy.repeatRatio * 100).toFixed(0)}%）`,
        signals,
      }
    }

    // ── ③ 原地打转（改了几个字，说的还是同一件事）──
    if (headTailMatch >= this.policy.headTailRun) {
      return {
        action: 'stop-and-restart',
        reason: `**原地打转**：连续 ${String(headTailMatch)} 条首尾相同（改了几个字但说的是同一件事）`,
        signals,
      }
    }

    // ── 可疑但未越线 ⇒ **warn**（让人有机会在真死循环前看到）──
    if (repeatRatio >= this.policy.repeatRatio * 0.7 || headTailMatch >= this.policy.headTailRun - 2) {
      return {
        action: 'warn',
        reason: `可疑：重复率 ${(repeatRatio * 100).toFixed(0)}%、首尾相同 ${String(headTailMatch)} 条（都还没越线）`,
        signals,
      }
    }

    return { action: 'ok', reason: '正常', signals }
  }

  /**
   * 周期检测：**最短的那个重复周期**。
   *
   * 做法：对每个候选周期 `p`（1..maxPeriod），检查尾部 `p * minRepeats` 个字符
   * 是否由**同一个 p 长片段**重复而成。**取最小的 p**（最短周期最能说明"卡住了"）。
   *
   * **为什么从短到长找**：`abcabcabc` 的周期是 3，不是 9 ——
   * 报 9 的话人看不出"它其实在重复三个字"。
   */
  private detectPeriod(): number {
    const minRepeats = this.policy.minPeriodRepeats
    for (let p = 1; p <= this.policy.maxPeriod; p += 1) {
      const need = p * minRepeats
      if (this.all.length < need) break
      const tail = this.all.slice(-need)
      const unit = tail.slice(0, p)
      let ok = true
      for (let i = p; i < need; i += p) {
        if (tail.slice(i, i + p) !== unit) {
          ok = false
          break
        }
      }
      if (ok) return p
    }
    return 0
  }

  /**
   * "首尾相同"的连续条数（从最新往回数）。
   *
   * **为什么要看首尾而不是整句**：模型在原地打转时常常**开头和结尾不变、
   * 中间换几个词** —— 整句比对会判成"不同"，而人一眼就看得出它在重复。
   *
   * 短文本（< 8 字符）**不算** —— `嗯` / `好的` 这类短回应天然会重复，
   * 把它们算进去会**误杀正常对话**。
   */
  /**
   * "**在原地打转**"的连续条数（从最新往回数）。
   *
   * ## 为什么不是"首尾一字不差"（**测试暴露的**）
   *
   * 第一版要求"开头 6 字与结尾 6 字都相同"。
   * 而真实打转里，**变化常常就在末尾**：
   *   `…然后再继续处理第 1 种情况` / `…第 2 种情况` / `…第 3 种情况`
   * ⇒ 尾巴不同 ⇒ **第一版判成"正常"，漏掉最典型的打转**。
   *
   * ## 改成"相似度"
   *
   * 算**公共前缀长度 + 公共后缀长度**，占较短那条的比例。
   * 相邻两条相似度 ≥ 0.8 才算"打转的一步" ——
   * 这样"只换末尾几个字"和"只换中间几个词"**都能抓到**。
   *
   * **短文本（< 8 字符）不算** —— `嗯` / `好的` 这类短回应天然会重复，
   * 把它们算进去会**误杀正常对话**。
   */
  private headTailRun(): number {
    const SIMILAR = 0.8
    let run = 0
    for (let i = this.recent.length - 1; i >= 1; i -= 1) {
      const cur = this.recent[i] ?? ''
      const prev = this.recent[i - 1] ?? ''
      if (cur.length < 8 || prev.length < 8) break
      if (similarity(prev, cur) < SIMILAR) break
      run += 1
    }
    return run
  }

  /** 清空（**重启本轮时必须调** —— 否则上一轮的重复会被算进新一轮）。 */
  reset(): void {
    this.recent.length = 0
    this.all = ''
  }
}

/**
 * 给一段**很长的文本**做整体体检（不是逐条喂）。
 *
 * 用途：模型一轮输出了 10 万字的重复内容，而我们是**事后**才看到的
 * （比如从日志、从已经落库的消息里）。
 *
 * **与 `LoopGuard` 的区别**：那个是"在线逐条"，这个是"离线整段"。
 * 两者都要，因为在线能**及时止损**，离线能**事后追查**。
 */
export function scanForLoop(text: string, policy: LoopPolicy = DEFAULT_LOOP_POLICY): LoopVerdict {
  const norm = normalizeForLoop(text)
  const guard = new LoopGuard(policy)
  // 按"句"切（中文标点已归一化成 `.`）
  const parts = norm.split('.').filter((s) => s !== '')
  if (parts.length === 0) {
    return {
      action: 'ok',
      reason: '空文本',
      signals: { samples: 0, distinct: 0, repeatRatio: 0, period: 0, headTailMatch: 0 },
    }
  }
  // 逐句喂（**只喂最后 window*2 句** —— 前面的是正常内容，不该影响判定）
  for (const p of parts.slice(-policy.window * 2)) guard.feed(p)
  // 再整体做一次周期检测（整段可能是 `abcabc...` 而没有标点）
  const whole = new LoopGuard(policy)
  whole.feed(norm.slice(-Math.max(policy.maxPeriod * policy.minPeriodRepeats * 2, 4000)))
  const v = guard.judge()
  const w = whole.judge()
  return w.action === 'stop-and-restart' && v.action !== 'stop-and-restart' ? w : v
}
