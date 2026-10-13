/**
 * 投喂的**输入侧**：把"用户塞进来的东西"变成一个**有界文本流**，顺带做附件决策。
 *
 * ## 为什么这一层必须存在（用户 2026-10-09 的口径）
 *
 * > 让系统自动切分，分段投入，这样可以应对**用户自己塞入的巨量记忆**
 * > （尤其是**试图塞入一个巨大的数据库**的）
 *
 * 关键在那句"**不能假设调用方会自己切好**"：
 *  - 调用方可能给一个 100 MB 的**字符串**（CLI 的 `--text`、HTTP 的 JSON body）；
 *  - 可能给一个**文件**（几 GB 的导出）；
 *  - 可能给一个**目录**（几百份资料，每份一个来源）；
 *  - 也可能给一个**根本不是文本**的东西（zip / sqlite 二进制）—— 那属于**附件决策**：
 *    明确跳过并说明原因，而不是把二进制当记忆喂进去（那会污染检索，还会撑爆窗口）。
 *
 * 所以这一层回答三个问题：**这是什么？能不能喂？怎么读成有界流？**
 *
 * ## "有界"是硬要求
 *
 * V8 的单个字符串上限约 512M 字符 ⇒ "任意大"的输入不可能先读成一个字符串。
 * 文件一律走 `createReadStream` 的异步迭代（块大小 {@link FEED_READ_CHUNK_CHARS}），
 * 由 `feed-chunk.ts` 的流式切分负责"内存只留一个窗口"。
 *
 * ## 目录扫描的取舍照抄既有 CLI（不是新策略）
 *
 * 只认 `.md` / `.txt`、跳过 `node_modules` / `.git` / `.runtime` / `dist`、
 * 顺序**排序**（同一个目录两次扫描必须给出同样的来源→段落映射，否则重导会错位）。
 * 显式点名的文件**不看后缀**（人点名了就是要喂它），但二进制仍然会被拦下。
 *
 * @module @forlife/gateway/feed-ingest
 */
import { createReadStream, readdirSync, statSync } from 'node:fs'
import { isAbsolute, join, relative } from 'node:path'

/** 目录扫描认识的后缀（其余文件**静默跳过** —— 别把二进制读进来当记忆）。 */
export const FEED_TEXT_EXTENSIONS: readonly string[] = ['.md', '.txt']

/** 目录扫描跳过的目录名（它们不属于"资料"）。 */
export const FEED_SKIP_DIRS: readonly string[] = ['node_modules', '.git', '.runtime', 'dist']

/** 一次读多少字符：够大（少几次系统调用）又够小（内存有界）。 */
export const FEED_READ_CHUNK_CHARS = 1 << 20

/**
 * "这不是文本"（附件决策的结论）。
 *
 * 单独一个错误类型而不是返回 `undefined`：调用方要把**原因**如实报给用户
 * （"跳过 zip / 含 NUL 字节"），而返回值里的 `undefined` 与"文件是空的"分不开。
 */
export class FeedBinaryError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FeedBinaryError'
  }
}

/** 取扩展名（小写；没有扩展名就是空串）。 */
function extensionOf(file: string): string {
  const index = file.lastIndexOf('.')
  return index <= 0 ? '' : file.slice(index).toLowerCase()
}

/**
 * 递归收集资料文件（跳过 {@link FEED_SKIP_DIRS} 与不认识的后缀），返回**排序后**的绝对路径。
 *
 * 显式给一个文件时不看后缀（人点名了就是要喂它）；给目录时才按后缀过滤。
 *
 * @param target - 文件或目录路径。
 * @returns 绝对路径数组（稳定顺序）。
 * @throws 路径不存在/不可读时抛（由入口层变成一行人话 + 非零退出码）。
 */
export function listFeedFiles(target: string): readonly string[] {
  const stats = statSync(target)
  if (stats.isFile()) return [target]
  const out: string[] = []
  for (const entry of readdirSync(target, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (FEED_SKIP_DIRS.includes(entry.name)) continue
      out.push(...listFeedFiles(join(target, entry.name)))
      continue
    }
    if (entry.isFile() && FEED_TEXT_EXTENSIONS.includes(extensionOf(entry.name))) out.push(join(target, entry.name))
  }
  return out.sort()
}

/**
 * 来源名：相对当前目录的路径、一律用正斜杠。
 *
 * 为什么用相对路径而不是绝对路径：来源是"同一份东西"的身份标识。
 * 用绝对路径的话，换机器、换 checkout 目录、甚至换个盘符，都会让"重导"变成"新喂一份"。
 * 为什么统一正斜杠：Windows 与容器里同一个文件要能得到**同一个**来源名。
 */
export function sourceOfFeedFile(file: string, cwd: string = process.cwd()): string {
  const rel = relative(cwd, file)
  const chosen = rel === '' || rel.startsWith('..') || isAbsolute(rel) ? file : rel
  return chosen.replace(/\\/g, '/')
}

/**
 * 把一个文件读成**有界文本流**（附件决策在这里：含 NUL 字节 ⇒ 抛 {@link FeedBinaryError}）。
 *
 * 为什么按块查 NUL 而不是"先读前几 KB 判一次"：二进制文件里 NUL 可能在很后面
 * （比如一个带长文本头的二进制格式），按块查是顺手的、代价是 O(n) 的，
 * 而**误喂一个二进制**的代价是它的内容进 FTS、进窗口、还要人工清。
 *
 * @param file - 文件路径。
 * @returns 文本块（utf8 解码）。
 * @throws {@link FeedBinaryError} 当内容看起来不是文本时。
 */
export async function* readFeedFilePieces(file: string): AsyncGenerator<string> {
  const stream = createReadStream(file, { encoding: 'utf8', highWaterMark: FEED_READ_CHUNK_CHARS })
  for await (const piece of stream) {
    const text = typeof piece === 'string' ? piece : piece.toString('utf8')
    if (text.includes('\0')) {
      throw new FeedBinaryError(`含 NUL 字节 —— 看起来不是文本（按附件跳过）：${file}`)
    }
    yield text
  }
}
