/**
 * 工作区沙箱：把文件访问限制在 `workspaceRoot` 之内。
 *
 * ## 为什么不能靠"检查字符串里有没有 `..`"
 *
 * 这是最容易被绕过的一类检查。绕过方式随手就有：
 *  - `....//`（去掉一层后又是 `..`）
 *  - 绝对路径（`/etc/passwd`、`C:\Windows\...`）
 *  - 符号链接：路径里**一个 `..` 都没有**，但链接指向外面
 *  - Windows 的短名（`PROGRA~1`）、大小写差异、`\\?\` 前缀
 *  - NUL 字节截断（`safe.txt\0../../etc/passwd`）
 *
 * 所以判定用**解析后的真实路径**：先拼、再 `resolve`、再**确认结果仍在根之下**。
 * 字符串检查只用来**提前给出更好的错误信息**，不作为安全依据。
 *
 * ## 符号链接为什么必须单独处理
 *
 * `resolve()` 只做**词法**规范化，不碰文件系统 —— 所以
 * `root/link` 指向 `/etc` 时，`resolve(root, 'link/passwd')` 仍然"在根之下"，
 * 但**真实**文件在外面。因此还要对**已存在的最深祖先目录**做 `realpath`，
 * 再确认它仍在根的 realpath 之下。
 *
 * @module @forlife/gateway/workspace
 */
import { existsSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, join, normalize, resolve, sep } from 'node:path'

/** 判定结果。 */
export type WorkspaceCheck =
  | { readonly ok: true; readonly absolutePath: string }
  | { readonly ok: false; readonly reason: string }

/** 工作区配置。 */
export interface WorkspaceOptions {
  /** 工作区根目录（会做 realpath，所以传软链也能正确判定）。 */
  readonly root: string
}

/**
 * 把一个**相对路径**解析到工作区内。
 *
 * @param root - 工作区根。
 * @param relativePath - 调用方给的相对路径。
 * @returns 通过则给出绝对路径；否则给出**具体原因**（不是笼统的"非法路径"）。
 */
export function resolveInWorkspace(root: string, relativePath: string): WorkspaceCheck {
  // ① NUL 字节：某些底层调用会在 NUL 处截断，于是"检查的路径"与"实际打开的路径"不是同一个
  if (relativePath.includes('\0')) return { ok: false, reason: '路径含 NUL 字节' }

  if (relativePath.trim() === '') return { ok: false, reason: '路径为空' }

  // ② 绝对路径直接拒。不"帮忙转成相对"——那会让人以为绝对路径是可用的，
  //    而在别的调用点上就会有人真的传绝对路径进来。
  if (isAbsolute(relativePath)) return { ok: false, reason: `不接受绝对路径：${relativePath}` }

  // Windows 盘符形式（`C:foo` 这种"相对当前盘"的写法 isAbsolute 会返回 false）
  if (/^[a-zA-Z]:/.test(relativePath)) return { ok: false, reason: `不接受盘符路径：${relativePath}` }

  // ③ "只由点组成"的段：遍历与 Win32 歧义写法都拒。
  //    放在字符串检查**之前**：它接住的正是字符串检查漏掉的那批（'.. ' / '...'）。
  if (hasDotOnlySegment(relativePath)) {
    return { ok: false, reason: `路径含"只由点组成"的段（遍历或 Win32 歧义写法）：${relativePath}` }
  }

  // ④ 提前给出更好的错误（**不作为安全依据**）
  const normalizedInput = normalize(relativePath)
  if (normalizedInput === '..' || normalizedInput.startsWith(`..${sep}`)) {
    return { ok: false, reason: `路径越出工作区：${relativePath}` }
  }

  // ④ 真正的判定：解析后必须仍在根之下
  let realRoot: string
  try {
    realRoot = realpathSync(root)
  } catch {
    return { ok: false, reason: `工作区根不存在或不可访问：${root}` }
  }

  const candidate = resolve(realRoot, relativePath)
  if (!isInside(realRoot, candidate)) {
    return { ok: false, reason: `路径越出工作区：${relativePath}` }
  }

  // ⑤ 符号链接：对**已存在的最深祖先**做 realpath，再确认仍在根之下。
  //    只查 candidate 本身不够 —— 目标文件可能还不存在（要新建），
  //    但它的父目录已经是个指向外面的软链。
  const ancestor = deepestExistingAncestor(candidate)
  if (ancestor !== undefined) {
    try {
      const realAncestor = realpathSync(ancestor)
      if (!isInside(realRoot, realAncestor)) {
        return { ok: false, reason: `路径经符号链接越出工作区（${ancestor} → ${realAncestor}）` }
      }
    } catch {
      return { ok: false, reason: `无法解析路径的真实位置：${ancestor}` }
    }
  }

  return { ok: true, absolutePath: candidate }
}


/**
 * 是否存在"只由点组成"的路径段（剥掉尾部空格后）。
 *
 * 为什么要单独判这个：原来的检查只匹配 `..`，于是 `'.. '` / `'...'` / `'a/.. '`
 * **全部放行**。本机实测它们被文件系统当作字面目录名（不是真绕过），
 * 但那是 **Win32 版本相关**的行为 —— 部分 Win32 API 会剥掉路径段末尾的空格与点。
 * 一旦走到那条路径上，放行的路径就变成真实逃逸。
 *
 * 规则：**只由点组成的段，要么是遍历，要么是 Win32 歧义写法，两种都拒。**
 * 正常文件名不会只由点组成，所以不会误伤。
 */
export function hasDotOnlySegment(input: string): boolean {
  return input
    .split(/[\\/]+/)
    .filter((segment) => segment !== '')
    .some((segment) => /^\.+$/.test(segment.replace(/ +$/, '')))
}

/** 判断 `child` 是否在 `parent` 之下（含等于）。Windows 上大小写不敏感。 */
export function isInside(parent: string, child: string): boolean {
  const normalizeCase = (value: string): string => (process.platform === 'win32' ? value.toLowerCase() : value)
  const p = normalizeCase(parent.endsWith(sep) ? parent : parent + sep)
  const c = normalizeCase(child)
  // 相等也算"之内"（工作区根本身）
  return c === normalizeCase(parent) || c.startsWith(p)
}

/** 找**已存在的最深祖先**（用于 realpath 检查）。 */
function deepestExistingAncestor(target: string): string | undefined {
  let current = target
  for (;;) {
    if (existsSync(current)) return current
    const parent = resolve(current, '..')
    if (parent === current) return undefined
    current = parent
  }
}

/** 判定一个已存在的路径是不是普通文件（工作区检查之外的额外约束）。 */
export function isRegularFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/** 拼一个工作区内的路径（**只用于展示**；真正的判定走 `resolveInWorkspace`）。 */
export function joinWorkspace(root: string, relativePath: string): string {
  return join(root, relativePath)
}
