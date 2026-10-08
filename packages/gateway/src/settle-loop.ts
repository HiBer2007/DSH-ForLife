/**
 * 维护循环（PLAN 阶段 9 交付物 1 的"定时"那一半 + 交付物 4 的"定时"那一半）。
 *
 * **它做两件事**：blob 沉降 + 碎片索引合并与淘汰。
 * 两者都是**低频运维动作**，各自起一个定时器只会让日志更难读、间隔更难协调。
 * （文件名还叫 settle-loop 是历史原因；职责已经是"维护"了。）
 *
 * ## 沉降循环（原说明）
 *
 * ## 为什么需要一个"循环"而不只是 `settleBlobs` 函数
 *
 * `settleBlobs` 只是**一次**沉降。交付物 1 要的是「**定时**沉降任务」——
 * 而"定时"意味着：进程活着的时候它自己会跑，而不是等人手动调。
 *
 * 没有这一层的话，交付物 1 只是"有沉降能力"，不是"有沉降"。
 *
 * ## 四条设计（都从项目里已有的循环学来）
 *
 * 1. **没配根路径 ⇒ 不启动**（而不是跑一个什么都不做的循环）——
 *    与 `wake-system-monitor` 的"没配挂载点就不起循环"一致。
 * 2. **自己接住异常** —— 定时器里抛异常会**静默杀死整个循环**，
 *    沉降从此失效而没人知道。
 * 3. **一轮跑完再排下一轮**（不是固定间隔硬塞）——
 *    沉降可能跑很久；固定间隔会让轮次堆积，和唤醒引擎那个
 *    "每秒重放"的 bug 是同一类。
 * 4. **汇报结果** —— 界面与日志要能看到"搬了几条、失败几条"，
 *    否则"沉降没生效"和"没有东西可沉"看起来一模一样。
 *
 * @module @forlife/gateway/settle-loop
 */
import type { DatabaseSync } from 'node:sqlite'

import {
  evictFragments,
  fragmentThresholdFromEnv,
  markFragmentCleaned,
  shouldRunFragmentMaintenance,
  mergeFragmentIndex,
  planFragmentMaintenance,
  resolveTierRoots,
  checkTierWritability,
  describeTierWritability,
  settleBlobs,
  settlePolicyFromEnv,
  longSettlePolicyFromEnv,
  settleLongEntries,
  type MoveFile,
} from '@forlife/store'

/** 循环配置（从环境变量解析）。 */
export interface SettleLoopConfig {
  readonly enabled: boolean
  readonly intervalMs: number
  readonly limit: number
  readonly disabledReason: string | undefined
}

/** 从环境变量读碎片维护策略。 */
export function fragmentPolicyFromEnv(env: Record<string, string | undefined>): { keepDays: number; limit: number } {
  const rawDays = Number(env['FORLIFE_FRAGMENT_KEEP_DAYS'] ?? '')
  const rawLimit = Number(env['FORLIFE_FRAGMENT_LIMIT'] ?? '')
  return {
    // 默认 30 天：刚沉淀完就删的话，"长期记忆写得对不对"还没人验证过，
    // 而那时碎片是**唯一的对照物**。
    keepDays: Number.isFinite(rawDays) && rawDays >= 0 ? rawDays : 30,
    limit: Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : 200,
  }
}

/** 从环境变量读循环配置。 */
export function settleLoopConfigFromEnv(env: Record<string, string | undefined>): SettleLoopConfig {
  const hot = env['FORLIFE_ROOT_HOT']
  if (hot === undefined || hot.trim() === '') {
    // **没配根路径 ⇒ 明确禁用**（而不是跑一个什么都不做的循环）
    return {
      enabled: false,
      intervalMs: 0,
      limit: 0,
      disabledReason: '没有配置 FORLIFE_ROOT_HOT，沉降循环未启动（不知道往哪搬）',
    }
  }
  const raw = Number(env['FORLIFE_SETTLE_INTERVAL_MS'] ?? '')
  // 默认 30 分钟：沉降是**低频**运维动作，跑太勤只会白扫表
  const intervalMs = Number.isFinite(raw) && raw >= 10_000 ? raw : 30 * 60_000
  const rawLimit = Number(env['FORLIFE_SETTLE_LIMIT'] ?? '')
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : 50
  return { enabled: true, intervalMs, limit, disabledReason: undefined }
}

/** 一轮的结果摘要（给日志与界面）。 */
export interface SettleTickResult {
  readonly moved: number
  readonly skipped: number
  readonly failed: number
  /** 失败的原因（最多几条，够排障就行）。 */
  readonly failures: readonly string[]
  /** 碎片维护：合并了几次、淘汰了几条、拒删了几条。 */
  readonly fragments?: { readonly merged: boolean; readonly evicted: number; readonly refused: number; readonly orphans: number }
  /**
   * 长期记忆的 HDD 沉降（PLAN §6.3 的"定时任务扫描"）。
   *
   * **与 blob 沉降分开报**：两者的失败含义不同 ——
   * blob 失败是"文件没搬成"，长期条目失败是"那条记忆还在 SSD 上"（可重试，不是丢数据），
   * 混在一个数字里就分不出是哪一类出了事。
   */
  readonly longTerm?: {
    readonly settled: number
    readonly skipped: number
    readonly failed: number
    readonly failures: readonly string[]
    /** 归档实际落在哪（冷层退回时它和热数据在同一块盘上，日志要能看出来）。 */
    readonly coldRoot: string
    readonly fellBack: boolean
  }
}

/** 沉降循环。 */
export interface SettleLoop {
  /** 跑一轮（测试直接调它）。 */
  readonly tick: () => Promise<SettleTickResult>
  readonly stop: () => void
  readonly config: SettleLoopConfig
}

/** 启动沉降循环。 */
export function startSettleLoop(options: {
  readonly db: DatabaseSync
  readonly env: Record<string, string | undefined>
  readonly moveFile: MoveFile
  readonly log: (message: string) => void
  readonly now?: () => Date
  readonly setIntervalImpl?: (fn: () => void, ms: number) => { unref?: () => void }
  readonly clearIntervalImpl?: (handle: unknown) => void
  readonly setTimeoutImpl?: (fn: () => void, ms: number) => { unref?: () => void }
}): SettleLoop {
  const log = options.log
  const config = settleLoopConfigFromEnv(options.env)
  const setIntervalFn = options.setIntervalImpl ?? ((fn, ms) => setInterval(fn, ms))
  const clearIntervalFn = options.clearIntervalImpl ?? ((h) => clearInterval(h as never))
  const setTimeoutFn = options.setTimeoutImpl ?? ((fn, ms) => setTimeout(fn, ms))

  if (!config.enabled) {
    log(`维护循环未启用：${String(config.disabledReason)}`)
    return {
      config,
      tick: async () => ({ moved: 0, skipped: 0, failed: 0, failures: [] }),
      stop: () => {},
    }
  }

  let stopped = false
  let handle: { unref?: () => void } | undefined

  const tick = async (): Promise<SettleTickResult> => {
    const roots = resolveTierRoots(options.env)

    // ★★ 2026-10-08 真机实测后加的：**分层根的可写自检**。
    //
    //   冷层子目录不存在时，写入会**静默失败**（touch 报 No such file or directory，
    //   而应用日志里一句话都没有）⇒ 沉降/归档/备份全部写不进去，
    //   而运维以为"跑得好好的"。**这比崩了更难发现。**
    //
    //   ⇒ 启动时自检一次，不可写就**明确喊出来**（并说清后果）。
    //   自检**不抛异常** —— 冷层不可用不该阻止维护循环启动（热层还能干活）。
    const tierChecks = checkTierWritability(roots)
    const tierWarning = describeTierWritability(tierChecks, roots.fellBack)
    if (tierWarning !== undefined) {
      log('⚠️ 存储分层有问题：' + tierWarning)
    } else {
      log('存储分层就绪：hot/warm/cold 三层根都可写')
    }
    const outcomes = await settleBlobs({
      db: options.db,
      roots,
      policy: settlePolicyFromEnv(options.env),
      moveFile: options.moveFile,
      limit: config.limit,
      log,
      ...(options.now === undefined ? {} : { now: options.now }),
    })
    const moved = outcomes.filter((o) => o.action === 'moved').length
    const skipped = outcomes.filter((o) => o.action === 'skipped').length
    const failed = outcomes.filter((o) => o.action === 'failed').length
    const failures = outcomes.filter((o) => o.action === 'failed').map((o) => `${o.id}：${o.reason}`)
    if (moved > 0 || failed > 0) {
      log(`维护一轮（沉降）：搬了 ${String(moved)} 条、跳过 ${String(skipped)} 条、失败 ${String(failed)} 条`)
    }

    // ── 碎片维护（PLAN 阶段 9 交付物 4）──────────────────────────────
    //
    // **为什么放在同一个循环里**：两者都是"低频运维动作"，
    // 各自起一个定时器只会让日志更难读、间隔更难协调。
    //
    // **顺序有讲究：先合并索引、再淘汰** ——
    // 合并不动数据，先做它可以让后面的淘汰在一个更紧凑的索引上跑。
    let fragments: SettleTickResult['fragments']
    try {
      // ★ **超限才动手**（验收标准 #4）—— 不是"到点就扫"。
      //
      // 差别在**代价**："到点就扫"每 30 分钟全表扫一遍，**大部分时候什么也没做**；
      // "超限才动手"平时不扫，攒到阈值才扫 —— 而那正是"超限"要表达的意思。
      const decision = shouldRunFragmentMaintenance(options.db, fragmentThresholdFromEnv(options.env))
      if (!decision.shouldRun) {
        fragments = { merged: false, evicted: 0, refused: 0, orphans: 0 }
        log(`碎片维护跳过：${decision.reason}`)
      } else {
        const merged = mergeFragmentIndex(options.db)
        // **先算计划再执行** —— 删除不可逆，计划是唯一能提前发现"算法写错了"的机会
        const plan = planFragmentMaintenance(options.db, fragmentPolicyFromEnv(options.env))
        const evicted = evictFragments(options.db, plan.evictable.map((f) => f.id))
        fragments = {
          merged: merged.ok,
          evicted: evicted.evicted,
          refused: evicted.refused.length,
          orphans: plan.orphaned.length,
        }
        if (evicted.evicted > 0 || plan.orphaned.length > 0) {
          log(`碎片维护：淘汰 ${String(evicted.evicted)} 条、拒删 ${String(evicted.refused.length)} 条、归宿已丢 ${String(plan.orphaned.length)} 条｜${plan.reason}`)
        }
        // **记下"刚清理过"** —— 否则时间兜底会在每次重启后又触发一次
        markFragmentCleaned(options.db)
      }
    } catch (error) {
      // **碎片维护失败不该让沉降也失败** —— 两件事互相独立
      log(`碎片维护异常（沉降不受影响）：${String(error).slice(0, 160)}`)
    }

    // ── 长期记忆的 HDD 沉降（PLAN §6.3 的"定时任务扫描"那一半）──────────
    //
    // 为什么**接在这个循环里**（而不是插件侧另起一个定时器）：
    //  1. 这里已经在做"低频运维动作"的定时，并且已经有了三条纪律
    //     （没配就不启动 / 自己接住异常 / 一轮跑完再排下一轮）；
    //  2. **冷层根路径（`FORLIFE_ROOT_COLD`）是这个进程解析的** ——
    //     插件进程（dsh 宿主）不保证拿得到那套环境变量，而"不知道往哪搬"时
    //     唯一诚实的做法是不搬；
    //  3. 插件侧 `MemoryRuntime.settle()` 是**中期→长期**的沉降（另一件事），
    //     它跑在宿主进程里、可能被多个 profile 各起一份；HDD 沉降是全局运维，
    //     只该有一个owner。**两件事共用一个循环**也让日志能对上时间线。
    //
    // 顺序放在最后：它最慢（要写文件），而前面两件事不该等它。
    let longTerm: SettleTickResult['longTerm']
    try {
      const coldRoot = roots.roots.cold
      const fellBack = roots.fellBack.some((f) => f.tier === 'cold')
      const policy = longSettlePolicyFromEnv(options.env)
      const settledOutcomes = await settleLongEntries({
        db: options.db,
        coldRoot,
        policy,
        log,
        ...(options.now === undefined ? {} : { now: options.now }),
      })
      const settled = settledOutcomes.filter((o) => o.action === 'settled').length
      const longSkipped = settledOutcomes.filter((o) => o.action === 'skipped').length
      const longFailed = settledOutcomes.filter((o) => o.action === 'failed').length
      const longFailures = settledOutcomes.filter((o) => o.action === 'failed').map((o) => `${o.id}：${o.reason}`)
      longTerm = { settled, skipped: longSkipped, failed: longFailed, failures: longFailures, coldRoot, fellBack }
      if (settled > 0 || longFailed > 0) {
        log(`维护一轮（长期记忆沉降）：沉了 ${String(settled)} 条、跳过 ${String(longSkipped)} 条、失败 ${String(longFailed)} 条`)
      }
      if (settled > 0 && fellBack) {
        // **不假装有 HDD**：库里只有 ssd/hdd 两个值，表达不了"落在哪块盘"，
        // 所以退回时必须在日志里说清 —— 否则运维会以为冷数据真的在另一块盘上。
        log(`⚠️ 冷层退回了（没配 FORLIFE_ROOT_COLD）：这 ${String(settled)} 条的归档实际落在 ${coldRoot}，与热数据同一块盘`)
      }
      for (const reason of longFailures) log(`长期沉降失败：${reason}`)
    } catch (error) {
      // **长期沉降失败不该让 blob 沉降/碎片维护的结果丢掉**（三件事互相独立）
      log(`长期记忆沉降异常（其余维护不受影响）：${String(error).slice(0, 160)}`)
    }

    return { moved, skipped, failed, failures, ...(fragments === undefined ? {} : { fragments }), ...(longTerm === undefined ? {} : { longTerm }) }
  }

  /**
   * **一轮跑完再排下一轮**（不是固定间隔硬塞）。
   *
   * 沉降可能跑很久（几万条 blob）。固定间隔会让轮次堆积 ——
   * 那与唤醒引擎"每秒重放同一条触发器"是同一类 bug
   * （真机烧了 141 次模型调用的那个）。
   */
  const schedule = (): void => {
    if (stopped) return
    handle = setTimeoutFn(() => {
      void tick()
        .catch((error: unknown) => {
          // **自己接住异常** —— 定时器里抛异常会静默杀死整个循环
          log(`维护一轮异常：${String(error).slice(0, 200)}`)
        })
        .finally(() => {
          schedule()
        })
    }, config.intervalMs)
    handle.unref?.()
  }

  schedule()
  log(`维护循环已启动：每 ${String(Math.round(config.intervalMs / 60_000))} 分钟一轮（blob 沉降每次最多 ${String(config.limit)} 条 + 长期记忆 HDD 沉降每次最多 ${String(longSettlePolicyFromEnv(options.env).batchSize)} 条 + 碎片合并/淘汰）`)

  return {
    config,
    tick,
    stop: () => {
      stopped = true
      if (handle !== undefined) clearIntervalFn(handle)
    },
  }
}
