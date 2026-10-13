/**
 * 日志**卫生**：日志文本里不许出现 Markdown 与"笔记"。
 *
 * ## 为什么要有这个模块（用户原话）
 *
 * > 「**你在日志里面塞笔记？？？？？而且日志能解析 MD 格式吗就敢写 MD**」
 *
 * 起因是启动时那条 WARN：它里面塞了 Markdown 粗体、反引号、`文件:行号`、
 * 一整段**设计论证**，最后还有一句「**待用户拍板**：从 WAKE_CONDITIONS 摘掉，还是真接进唤醒矩阵」。
 *
 * 三个问题，一个比一个重：
 *
 * 1. **Markdown 在日志查看器里不会被渲染** —— `**粗体**` 只会变成一堆星号，
 *    **可读性比不写还差**。
 * 2. **日志消息里写设计说明 + 待办** —— 那是**文档**，该进 `FIX_PLAN.md`；
 *    日志是**运行时事件流**，不是笔记本。
 * 3. ★★ 最重的：把「**待用户拍板**」塞进 `warn` ⇒
 *    **每次启动都弹一条"需要你决策"的告警**，而那件事几天前就该在计划里。
 *    ⇒ 日志因此**失去可信度**：满屏待办的地方，真出事时没人看。
 *
 * ## 分工：能机械清的当场清
 *
 * | 形状 | 处理 |
 * | :--- | :--- |
 * | Markdown 粗体 / 行内代码 / 标题井号 | ★ **运行时清掉**（{@link cleanLogText}） |
 * | 换行（一条日志该是一行） | ★ **运行时压平** |
 * | `TODO` / `FIXME` / `待用户拍板` | ★★ **运行时换成一句短标记** —— <br>原文该**搬进 `FIX_PLAN.md`**，而不是继续躺在日志里 |
 * | `文件:行号` 引用 | ★ **只报告**（它本身可能是有用的定位信息，交给守卫测试判断上下文） |
 *
 * ★ 这些都在**入口处**做（`createLogger` / `log-sink.ts`），不依赖任何人"记得别写" ——
 *   与 `redact.ts` 的 `redactingLogger`（「**让脱敏不可能被忘掉**」）是同一个思路。
 *
 * ★★ **为什么必须有运行时这一道**：日志正文常常**不在日志调用那一行** ——
 *   本模块的起因那条（`wake.ts:185` 的"待用户拍板"）就是从**数据表**里拼出来的
 *   （`describeWakeProducerGaps()`）⇒ **只扫"像日志调用"的源码行根本扫不到它**。
 *
 * @module @forlife/gateway/admin/log-hygiene
 */

/**
 * 「笔记」的**判定**与**清除**必须用同一份词表。
 *
 * ★★ 为什么单独抽出来：第一版我把它们写成了两套 ——
 * `test` 认识 `待决策`，而 `clean` 的替换只匹配 `待拍板`/`待用户拍板`
 * ⇒ **探测得到、却清不掉**（端到端演示里 `待决策` 原样留在了日志里）。
 * 这正是本仓反复强调的"**只有一处实现**"（对比 `log-levels.ts` 里 `atLeast` 那段注释）。
 */
const NOTE_WORDS = '待(?:用户)?拍板|待定项|待决策|待确认'
interface NoiseShape {
  readonly name: string
  /** 命中判据（**只用来判定**；`clean` 才是改写）。 */
  readonly test: RegExp
  /** 运行时改写；不提供 ⇒ 只报告、不改写。 */
  readonly clean?: (text: string) => string
}

const SHAPES: readonly NoiseShape[] = [
  {
    name: 'Markdown 粗体',
    test: /\*\*[^*\n]+\*\*/,
    clean: (t) => t.replace(/\*\*([^*\n]+)\*\*/g, '$1'),
  },
  {
    name: 'Markdown 行内代码',
    test: /`[^`\n]+`/,
    clean: (t) => t.replace(/`([^`\n]+)`/g, '$1'),
  },
  {
    name: 'Markdown 标题',
    // 行首的 #{1,6} + 空格（★ 不碰 `#123` 这种编号）
    test: /(?:^|\n)#{1,6}\s+\S/,
    clean: (t) => t.replace(/(^|\n)#{1,6}\s+/g, '$1'),
  },
  {
    name: '换行',
    test: /\n/,
    clean: (t) => t.replace(/\s*\n+\s*/g, ' '),
  },
  {
    // ★★ 这条**也清** —— 我一开始写成"只报告不删"，理由是"删了会让本该被搬走的话消失"。
    //   ★ 那个理由**站不住**：用户要的就是"日志里别出现这些"，
    //     而"内容不丢"应当靠**把它搬进 `FIX_PLAN.md`**，不是靠让它继续躺在日志里。
    //
    //   ⇒ 换成一句**短的、固定的**标记，不泄露原文也不占版面。
    //
    //   ★ 为什么必须有这一条：日志正文常常**不在日志调用那一行** ——
    //     本条就是从 `wake.ts:185` 的数据表里拼出来的（`describeWakeProducerGaps()`）。
    //     ⇒ **只看"像日志调用"的行扫描不到它**，只有运行时拦得住。
    name: '"待用户拍板"这类笔记',
    // ★ 判定与清除**同一份词表**（`NOTE_WORDS`）—— 见它的注释里我踩过的那个坑
    test: new RegExp(NOTE_WORDS),
    // ★★ 只**向前**吞（从短语本身开始到最近的边界），**不许往回看**。
    //
    //   第一版写成 `[^。；\n]*待用户拍板[^。；\n]*` —— 那会从**前一个句号/分号**开始匹配。
    //   而真实文本里用的是**逗号**（`，`）不是分号 ⇒ 于是它**从整行开头吞到结尾**，
    //   把"事实部分"（`当前没有生产者`）一起吃掉了 ❌ —— 是回退验证把它抓出来的。
    clean: (t) =>
      // ★★ 分支**必须分组** —— 第一版写成 `${NOTE_WORDS}[：:]?[^…]*`，
      //   而 `A|B|C[：:]?[^…]*` 在正则里那个"吞尾巴"的部分
      //   **只作用于最后一个分支** ⇒ `待决策` 只清掉 3 个字，
      //   尾巴（`：见 FIX_PLAN.md §56`）**留在日志里** ❌
      //   —— 端到端演示抓到的第二个 bug。
      t.replace(new RegExp(`(?:${NOTE_WORDS})[：:]?[^。；\\n)）]*[。；]?`, 'g'), '（笔记已移出日志）'),
  },
  {
    name: 'TODO 标记',
    test: /\b(?:TODO|FIXME)\b/,
    clean: (t) => t.replace(/\b(?:TODO|FIXME)\b/g, '（待办已移出日志，见 FIX_PLAN.md）'),
  },
  {
    // ★ 单独出现的 `文件:行号` **不删**（它是有用的定位信息）；
    //   报出来是为了让守卫测试能按上下文判断。它若**长在笔记里**，
    //   会随那条笔记一起被上面那条清掉 —— 那是对的（它属于笔记的内容）。
    name: '文件:行号 引用',
    test: /\b[\w.-]+\.(?:ts|mts|cts|js|mjs|vue|json|yml|yaml|md):\d+/,
  },
]

/**
 * 报出这段日志文本里**有哪些不该有的形状**（返回形状名，不是布尔）。
 *
 * ★ 返回名字而不是 `true` —— 与 `redact.ts` 的 `findSensitive` 同一个理由：
 *   **要能知道漏的是哪一类**，否则修的时候只能猜。
 */
export function findLogNoise(text: string): readonly string[] {
  const hits: string[] = []
  for (const shape of SHAPES) {
    if (shape.test.test(text)) hits.push(shape.name)
  }
  return hits
}

/**
 * 把日志文本清成"一条干净的单行"。
 *
 * ★ 清掉的是：Markdown 标记（粗体 / 行内代码 / 标题井号）、换行，
 *   以及 `TODO`/`FIXME`/"待用户拍板"这类**笔记**（换成一句短标记）。
 * ★ `文件:行号` **保留** —— 它本身是有用的定位信息，是否该出现交给守卫测试按上下文判断。
 */
export function cleanLogText(text: string): string {
  let out = text
  for (const shape of SHAPES) {
    if (shape.clean !== undefined) out = shape.clean(out)
  }
  return out
}

/**
 * 一段日志文本**是不是已经干净**（自检 / 测试用）。
 *
 * ★ 只认"机械可清"的那几样 —— 与 {@link cleanLogText} 的范围**必须一致**，
 *   否则会出现"清了但自检说没清"这种自相矛盾。
 */
export function isCleanLogText(text: string): boolean {
  return cleanLogText(text) === text
}
