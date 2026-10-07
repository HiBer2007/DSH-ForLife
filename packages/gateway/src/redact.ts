/**
 * 日志脱敏（阶段 10 交付物 4）。
 *
 * ## 为什么在**写入侧**做
 *
 * `log-buffer.ts` 里有一条刻意的判断：
 *
 * > 刻意**不**做日志脱敏：脱敏属于**写入侧**的职责（密钥根本不该进日志）。
 * > 在展示侧做脱敏会给人"已经安全了"的错觉，而**真正的泄露早就发生了**。
 *
 * **这个判断是对的** —— 但它成立的前提是"**写入侧真的做了**"。
 * 而在此之前**两侧都没做**：日志文件里就是原文。
 * 日志会被复制、打包、发给别人看 —— **一旦写下去就收不回来了**。
 *
 * 所以这个模块是**写入侧**的那一半：**在字符串进日志之前**把它处理掉。
 *
 * ## 脱敏 vs 隐藏（**两者都要，但目的不同**）
 *
 * - **脱敏**（这里做的）：留下可辨认的形状（`1234***789`）——
 *   排障时要能对上"是不是同一个号"；
 * - **隐藏**（密钥）：**什么都不留**（`oc_sk_***`）——
 *   密钥没有任何"需要辨认"的场景，留长度都算多余。
 *
 * 把密钥也做成"留头留尾"是错的：那等于**泄露了它的一部分**，
 * 而没有任何人需要靠那部分来排障。
 *
 * ## 一个容易忽略的点：**URL 里的密钥**
 *
 * `https://api.example.com/v1?key=sk-xxxx` —— 只脱敏 `Authorization` 头是不够的。
 * 查询串里的密钥同样会进日志，而且**更常见**（很多 SDK 用 query 传 key）。
 *
 * @module @forlife/gateway/redact
 */

/** QQ 号：5–12 位数字。**太长的不动**（可能是别的数字，比如时间戳）。 */
const QQ_PATTERN =
  // **排除后面紧跟单位的**：`耗时 12345 毫秒`、`处理了 12345 条` 里的数字
  // 不是 QQ 号，而 5 位数字在日志正文里**太常见**了。
  // 只按长度判断会把一堆正常的量误判成号码。
  /(?<!\d)([1-9]\d{4,11})(?!\d)(?!\s*(?:毫秒|秒钟|秒|分钟|条|次|个|字节|字|ms|MB|KB|GB|%))/g

/** 密钥形状（各家前缀 + 通用长随机串）。 */
const KEY_PATTERNS: readonly { readonly name: string; readonly re: RegExp; readonly replacement: string }[] = [
  // **每项自带替换文本** —— 统一用 `${name}_***` 的话，
  // `sk-xxx` 会被换成 `sk_***`，**看起来像另一家的前缀**（排障时误导人）。
  { name: 'oc_sk', re: /oc_sk_[A-Za-z0-9_-]{6,}/g, replacement: 'oc_sk_***' },
  { name: 'sk', re: /sk-[A-Za-z0-9_-]{8,}/g, replacement: 'sk-***' },
  // 通用长十六进制串（32 位以上）
  { name: 'hex', re: /(?<![A-Za-z0-9])[a-f0-9]{32,}(?![A-Za-z0-9])/gi, replacement: '[长串已隐藏]' },
  { name: 'gh', re: /gh[pousr]_[A-Za-z0-9]{20,}/g, replacement: 'gh_***' },
  { name: 'xox', re: /xox[baprs]-[A-Za-z0-9-]{10,}/g, replacement: 'xox-***' },
]

/** 图片 / 媒体 URL（QQ 的图片链接带鉴权参数，泄露等于给别人访问权）。 */
const MEDIA_URL_PATTERN = /https?:\/\/[^\s"'<>]*?(?:multimedia\.qq\.com|gchat\.qpic\.cn|qpic\.cn|\.jpg|\.jpeg|\.png|\.gif|\.webp)[^\s"'<>]*/gi

/** 查询串里的敏感参数名。 */
const SENSITIVE_QUERY = /([?&](?:key|token|access_token|api_key|apikey|secret|password|passwd|pwd)=)[^&\s"'<>]+/gi

/** `Authorization: Bearer xxx` 之类的头。 */
const AUTH_HEADER = /(authorization\s*[:=]\s*)(?:bearer\s+)?(?!\*\*\*)[^\s,;"']+/gi

/**
 * 脱敏一个字符串（**写入侧用**）。
 *
 * **顺序有讲究**：先处理 URL（它内部可能含密钥），再处理头，最后才是通用形状。
 * 反过来的话，URL 里的密钥会先被"通用形状"打码，
 * 而 URL 本身还留着 —— 结果是**看起来脱敏了、其实链接还能点**。
 */
export function redact(text: string): string {
  let out = text

  // ① 图片 URL **整条**替换（不是打码一部分）——
  //    这类链接自带鉴权参数，留一部分等于留访问权
  out = out.replace(MEDIA_URL_PATTERN, '[媒体URL已隐藏]')

  // ② 查询串里的敏感参数（**保留参数名**，便于排障看出"这里本来有个 key"）
  out = out.replace(SENSITIVE_QUERY, '$1***')

  // ③ 认证头（**保留头名**，同样为了排障）
  out = out.replace(AUTH_HEADER, '$1***')

  // ④ 密钥形状：**什么都不留**（除了前缀，用于认出"这是哪家的密钥"）
  for (const { re, replacement } of KEY_PATTERNS) {
    out = out.replace(re, replacement)
  }

  // ⑤ QQ 号：**留头尾**（排障要能对上"是不是同一个号"）
  out = out.replace(QQ_PATTERN, (m) => (m.length <= 6 ? `${m.slice(0, 2)}***` : `${m.slice(0, 4)}***${m.slice(-3)}`))

  return out
}

/** 脱敏一个值（对象会**逐字段**处理，数组逐项）。 */
export function redactValue(value: unknown): unknown {
  if (typeof value === 'string') return redact(value)
  if (Array.isArray(value)) return value.map((v) => redactValue(v))
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) {
      // **键名也可能是敏感的**（比如 `{ "sk-xxx": "..." }` 这种很少见，
      // 但 `{"password": "..."}` 的值必须处理 —— 那是下面这行做的）
      out[redact(k)] = redactValue(v)
    }
    return out
  }
  return value
}

/**
 * 包一个 logger，**让脱敏不可能被忘掉**。
 *
 * 直接导出 `redact` 的话，每个调用点都要记得调它 ——
 * 而"记得调"是靠不住的（本项目里已经踩过多次"接线忘了"）。
 * 包一层之后，**写入路径上只有这一个 logger**。
 */
export function redactingLogger(
  sink: (message: string) => void,
): (message: string) => void {
  return (message: string): void => {
    sink(redact(message))
  }
}

/**
 * 检查一个字符串**是否还有敏感内容**（自检用）。
 *
 * 用途：启动时对已有日志做一次体检，或在测试里断言"脱敏真的生效了"。
 * **返回命中的形状名**（而不是布尔）—— 便于知道漏了哪一类。
 */
export function findSensitive(text: string): readonly string[] {
  const hits: string[] = []
  if (MEDIA_URL_PATTERN.test(text)) hits.push('媒体URL')
  MEDIA_URL_PATTERN.lastIndex = 0
  if (SENSITIVE_QUERY.test(text)) hits.push('查询串密钥')
  SENSITIVE_QUERY.lastIndex = 0
  if (AUTH_HEADER.test(text)) hits.push('认证头')
  AUTH_HEADER.lastIndex = 0
  for (const { name, re } of KEY_PATTERNS) {
    if (re.test(text)) hits.push(`密钥(${name})`)
    re.lastIndex = 0
  }
  return hits
}
