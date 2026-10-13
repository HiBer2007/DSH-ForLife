/**
 * 给分层根加**启动期可写自检**（GOAL 第 4 条）。
 *
 * ## 为什么必须加（真机实测）
 *
 * 2026-10-07 真机部署发现：**冷层的子目录不存在时，写入会静默失败** ——
 *
 *     $ touch /cold/tiers/cold/x
 *     touch: /cold/tiers/cold/x: No such file or directory      rc=1
 *     $ docker logs dsh | grep -iE '冷层|cold|tier'
 *     （空 —— 应用一句话都不报）
 *
 * **⇒ 沉降 / 归档 / 备份全部写不进去，而日志里什么都没有。**
 * 这比"崩了"更难发现 —— 崩了至少有栈；**静默失败会让人以为"跑得好好的"**。
 *
 * ## 设计
 *
 * - **纯函数**：`resolveTierRoots` 保持零 I/O（它有单测、且被三处调用）——
 *   自检**单独一个函数**，只在**启动时**调一次；
 * - **不抛异常**：自检失败不该阻止插件加载（记忆本体还能用，只是沉降不可用）；
 * - **返回结构而不是打日志**：调用方决定怎么报（插件用 `always`，CLI 用 stdout）。
 */
import { accessSync, constants, mkdirSync } from 'node:fs'

import type { StorageTier, TierRoots } from './storage-tiers.ts'

/** 某一层的可写检查结果。 */
export interface TierWritability {
  readonly tier: StorageTier
  readonly root: string
  /** 可写（或已成功创建）。 */
  readonly writable: boolean
  /** 不可写的原因（可写时为 undefined）。 */
  readonly reason?: string
  /** 是这次自检**新建**的目录（说明原来不存在）。 */
  readonly created?: boolean
}

/**
 * 检查每一层的根路径**是否可写**；不可写时**尝试创建**（只建一层，不递归造整棵树）。
 *
 * @param roots - `resolveTierRoots()` 的结果。
 * @param options.create - 是否尝试创建缺失的目录（默认 `true`）。
 */
export function checkTierWritability(
  roots: TierRoots,
  options: { readonly create?: boolean } = {},
): readonly TierWritability[] {
  const create = options.create ?? true
  const out: TierWritability[] = []

  for (const tier of ['hot', 'warm', 'cold'] as const) {
    const root = roots.roots[tier]
    let created = false

    // ① 先试直接写权限
    try {
      accessSync(root, constants.W_OK)
      out.push({ tier, root, writable: true })
      continue
    } catch {
      // 不可写 —— 可能是"不存在"，也可能是"权限不够"
    }

    // ② 不存在就试着建（**只建这一层**）
    if (create) {
      try {
        mkdirSync(root, { recursive: true })
        created = true
      } catch (error) {
        out.push({ tier, root, writable: false, reason: `创建失败：${String(error).slice(0, 120)}` })
        continue
      }
      try {
        accessSync(root, constants.W_OK)
        out.push({ tier, root, writable: true, created })
        continue
      } catch (error) {
        out.push({ tier, root, writable: false, created, reason: `建好了但不可写：${String(error).slice(0, 120)}` })
        continue
      }
    }

    out.push({ tier, root, writable: false, reason: '不可写（且未尝试创建）' })
  }

  return out
}

/**
 * 把自检结果转成**给运维看的一行话**（没有问题时返回 `undefined`）。
 *
 * ★ 特意把「退回了」也算进警告 ——
 * 用户以为分了三层在放、实际全在一块的盘上，那是最容易误解的状态。
 */
export function describeTierWritability(
  checks: readonly TierWritability[],
  fellBack: readonly { readonly tier: StorageTier; readonly from: StorageTier }[],
): string | undefined {
  const bad = checks.filter((c) => !c.writable)
  const fallback = fellBack.map((f) => `${f.tier}→${f.from}`)

  if (bad.length === 0 && fallback.length === 0) return undefined

  const parts: string[] = []
  for (const c of bad) {
    // ★ 说清后果，不只是说"不可写"
    const consequence =
      c.tier === 'cold'
        ? '沉降/归档/备份会**静默失败**'
        : c.tier === 'warm'
          ? '温层写入会失败'
          : '**记忆本体不可用**'
    parts.push(`${c.tier}（${c.root}）不可写 —— ${c.reason ?? ''} ⇒ ${consequence}`)
  }
  if (fallback.length > 0) {
    parts.push(`退回了：${fallback.join(' / ')}（数据没有真的分成三层放）`)
  }
  return parts.join('；')
}
