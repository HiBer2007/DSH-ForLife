/**
 * 日志分级**分批迁移**的守卫（用户 2026-10-10 的七级制度）。
 *
 * ## 这个文件在钉什么
 *
 * 迁移这件事有两个失败模式，而且都**不会让测试变红**：
 *
 * 1. **改回去了** —— 有人把 `atLevel(log,'fault')(…)` 改回裸 `log(…)`，
 *    于是那条子系统故障在面板上**又变成 `info`**，筛 `fault` 时看不到它
 * 2. **改过头了** —— 把一处**本来就是 `info`** 的改成别的级别（"维护循环已启动"凭什么算 note？）
 *
 * ⇒ 所以守卫要**两边都钉**：该升级的必须在，**本来就对的必须是裸调用**。
 *
 * ## ★ 迁移的判据（写在这里，免得下次有人从头想）
 *
 * **判据是"这句话该归哪一级"，不是"把每一处 `log(` 都改一遍"。**
 * 裸调用本来就归 `info` —— 一句话真是 `info` 时，**它不用动**。
 * 所以判断顺序是：先问"这属于七级里的哪一级"，只有**不是 `info`** 的才需要动。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

/** 读源码并**去掉注释**（注释里引用的写法不许把守卫骗过去）。 */
function code(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n')
}

const SETTLE = code('../src/settle-loop.ts')

test('★★ 接线：`atLevel` 真的 import 了（否则整批改动编译不过 —— 但它也可能被整体回退）', () => {
  assert.match(SETTLE, /import \{ atLevel \} from '\.\/admin\/log\.ts'/, '必须 import 那个桥')
})

test('★★★ 该升级的四处 `fault` 都在（子系统坏了，不是某次操作出错）', () => {
  // 存储分层有问题 / 碎片维护每轮炸 / 长期沉降每轮炸 / 整轮维护炸
  const faults = SETTLE.match(/atLevel\(log, 'fault'\)/g) ?? []
  assert.equal(
    faults.length,
    4,
    `有四处属于 fault（存储分层 / 碎片维护 / 长期沉降 / 整轮维护）。实际 ${String(faults.length)} 处 —— ` +
      '少一处就意味着那条子系统故障在面板上变成了 info，**筛 fault 时看不到它**',
  )
  // ★ 反面：那四条**不许**再是裸调用（改回去要红）
  for (const bare of ['log(`碎片维护异常', 'log(`长期记忆沉降异常', 'log(`维护一轮异常', "log('存储分层有问题"]) {
    assert.ok(!SETTLE.includes(bare), `「${bare}」不许再是裸调用 —— 裸调用会被当成 info`)
  }
})

test('★★ `note` / `warn` / `error` 各就各位（这是七级里最容易被含糊过去的三档）', () => {
  assert.match(SETTLE, /atLevel\(log, 'note'\)\(`维护循环未启用/, '没启用是一条**判断** ⇒ note')
  assert.match(SETTLE, /atLevel\(log, 'note'\)\(`碎片维护跳过/, '"跳过了"是**判断** ⇒ note')
  assert.match(SETTLE, /atLevel\(log, 'warn'\)/, '冷层退回是"出问题但兜住了" ⇒ warn')
  assert.match(SETTLE, /atLevel\(log, 'error'\)\(`长期沉降失败/, '**单条**失败 ⇒ error（与 fault 的分界：一条 vs 一类）')
})

test('★★ 反面：本来就该是 `info` 的**不许**被改（改过头也是错）', () => {
  // 这四句是纯粹的"事实陈述"，`info` 就是对的 —— 给它们升级只会稀释级别本身
  for (const keep of [
    'log(\'存储分层就绪：hot/warm/cold 三层根都可写\')',
    'log(`维护一轮（沉降）：搬了 ',
    'log(`维护循环已启动：每 ',
  ]) {
    assert.ok(
      SETTLE.includes(keep),
      `「${keep}」**应当保持裸调用** —— 它本来就是 info；` +
        '给一句事实陈述升级会稀释级别本身（久了就没人信 fault 那一档）',
    )
  }
})

test('★ 这批迁移**没有碰任何调用方**（没人被迫改签名）', () => {
  // `atLevel` 的意义就是"注入普通函数也照跑"。这里断言本文件仍然把 `log`
  // 当普通函数接（类型没被改成要求 Logger）—— 若哪天改成要求 Logger，
  // 所有只传 `(m) => …` 的调用方与测试会一起编译不过，那正是要避免的。
  assert.match(SETTLE, /const log = options\.log/, '仍然从 options 拿注入的 log')
  assert.ok(
    !/log:\s*Logger\b/.test(SETTLE),
    '★ 不许把注入类型改成 `Logger` —— 那会让只传普通函数的调用方全部编译不过（"分批迁移"就没了）',
  )
})

// ── 第二批：`model-router.ts` ─────────────────────────────────────────────

const ROUTER = code('../../dsh-component/src/model-router.ts')

test('★★★ `debug` 第一次有了生产消费点（此前七级里只有它没有）', () => {
  // `model-router.ts` 的 `👀 agent/xxx` 观察日志是**教科书级的 debug**：
  // 过程细节、只有排障时才有意义、而且代码本来就只打前 5 次防刷屏。
  // 默认存储策略不收 debug（用户指定"除了 debug 都存"）
  // ⇒ 它们在**生产里不再刷屏**，需要时改环境变量就能看到。
  //
  // ⚠️ **这条断言原来写的是"恰好 4 处"。** 那是个**脆断言**：
  //    我后来在同一个文件里加了**两条正当的** debug（判档的"取不到输入就不猜"、
  //    以及"凭什么"那一条），它立刻变红 —— 而**代码是对的**。
  //    ⇒ 与之前 `log-levels.test.ts` / `redact.test.ts` 那次是同一个毛病：
  //      **断言写成了对"精确形状"的检查，于是一次正当重构就把它打红。**
  //    ⇒ 改成**认名字、不数数**：只要求那**四处已知的**观察日志在里面，
  //      并要求"不许再有裸的 `👀`"。新增 debug 不再误伤。
  const knownDebug = [
    '👀 agent/created',
    '👀 agent/pre-step',
    '👀 agent/turn-stopping',
  ]
  for (const phrase of knownDebug) {
    assert.ok(
      ROUTER.includes("atLevel(log, 'debug')") && ROUTER.includes(phrase),
      `★ 「${phrase}」必须是 debug`,
    )
  }
  // 具体到那四处的写法（含"后续只计数"那条）
  assert.ok(
    (ROUTER.match(/atLevel\(log, 'debug'\)/g) ?? []).length >= 4,
    '至少四处观察日志是 debug（**不写成"恰好"** —— 新增正当的 debug 不该让这条红）',
  )
  // 反面：不许再有裸的 👀 调用（裸调用一律 info ⇒ 生产里继续刷屏）
  assert.ok(
    !/^\s*log\('👀/m.test(ROUTER),
    '★ `👀` 那几行不许再是裸调用 —— 裸调用被当成 info，会在生产日志里一直刷',
  )
})

test('★★★ 「尚未实现」不许压成 debug —— 那正是"写了没接而日志一片安静"的形状', () => {
  // 这两条说的是**实情**："你开了 apply，但这个功能还没实现"。
  // 压成 debug ⇒ 默认不存 ⇒ 开了 apply 什么都没发生时，日志里**一个字都没有**。
  // 本仓栽过 18 次"写好了没接上/接错了"，其中最难查的正是"安静地什么都没发生"。
  const warnings = ROUTER.match(/atLevel\(log, 'warn'\)/g) ?? []
  assert.equal(warnings.length, 2, '两条"尚未实现"都该是 warn')
  assert.ok(!/log\('   ↳ apply 模式/.test(ROUTER), '★ 那两条不许再是裸调用')
})

test('★★★ 「只装上 N 个监听器」是 `fault` —— 路由这一子系统实际不工作', () => {
  assert.match(
    ROUTER,
    /atLevel\(log, 'fault'\)\(/,
    '★ 事件名对不上时它会**安静地什么都不做**，而外面看起来一切正常 ⇒ 这是 fault（一个子系统），不是 error（一次操作）',
  )
  // 而"订阅单个事件失败"是**一次操作**没兜住 ⇒ error（与上面那条形成分界）
  assert.match(ROUTER, /atLevel\(log, 'error'\)\('订阅 '/, '单次订阅失败 ⇒ error')
  const errors = ROUTER.match(/atLevel\(log, 'error'\)/g) ?? []
  assert.equal(errors.length, 4, '四个错误处理点都该是 error（订阅 / created / pre-step / turn-stopping）')
})

test('★ 反面：`model-router.ts` 里两句纯事实**保持裸调用**（info 就是对的）', () => {
  assert.ok(
    ROUTER.includes("log('模型路由：模式=' + mode"),
    '「模式=X」是事实 ⇒ 保持裸调用（它恰恰是"路由到底开没开"最该一眼看到的一句）',
  )
  assert.ok(
    ROUTER.includes("log('模型路由：已订阅 '"),
    '「已订阅 N 个事件」是事实 ⇒ 保持裸调用',
  )
})

// ── 第四批：`wake-engine.ts`（循环失败 = **fault**，而猜测只会给 error）──────

const WAKE_ENGINE = code('../src/wake-engine.ts')

test('★★★ 唤醒循环失败必须是 `fault` —— 猜测会把这种"最该看见的"降成 `error`', () => {
  // ## 为什么这一条值得单独钉
  //
  // `guessLevel` 只能猜 `info`/`warn`/`error`（**刻意**不猜 `fault`/`crash` —— 见
  // `log-buffer.ts` 的头：那两级是"影响范围"的判断，正则看不出来）。
  //
  // ⇒ 于是"唤醒 tick 异常"这种文本，猜测会给 **`error`** —— 而它**低估**了：
  //   `error` 说的是"**这一次**操作没兜住"，而这是**唤醒循环每轮都炸** ⇒
  //   **唤醒这一子系统的全部**都不可用（她永远叫不醒），而进程还活着、面板还开着。
  //
  // ★ 这正是 **D6「沉降循环曾完全沉默」的同一个形状** ——
  //   那次是"有话说却不说"，这次是"**说了，但级别让人以为只是偶发**"。
  //
  // ⇒ 要迁移的正是**猜测够不着的那些级别**；"数还剩几处裸调用"指不到它们。
  assert.match(
    WAKE_ENGINE,
    /atLevel\(log, 'fault'\)\(`唤醒 tick 异常/,
    '★ 唤醒循环每次 tick 都炸 ⇒ fault（一个子系统），不是 error（一次操作）',
  )
  assert.ok(
    !/^\s*log\(`唤醒 tick 异常/m.test(WAKE_ENGINE),
    '★ 不许再是裸调用 —— 裸调用会被猜成 error，**低估**了一个"她永远叫不醒"的状态',
  )
})

test('★★ 迁移**不只是升级**：被猜测**高估**的也要降回来', () => {
  // ★★ 我第一版在这里写了一条**永远为真**的断言：
  //   它引用「唤醒引擎已启动」—— 而**那句话在这个文件里根本不存在**（我编的），
  //   而且我写成 `A || !B`，恒真。**那是最坏的一种测试：看着像断言，其实什么都没测。**
  //
  //   ⇒ 现在按**真实存在**的行写（查过 `wake-engine.ts` 只有两条裸调用）：
  assert.match(
    WAKE_ENGINE,
    /atLevel\(log, 'warn'\)\(`预算上报失败（已忽略）/,
    '★ "上报失败（已忽略）"是**被容忍的**小故障 ⇒ warn；猜测会判成 error（**高估**）',
  )
  // 而"派发结果"那条是**事实**，`info` 就是对的 ⇒ 保持裸调用
  assert.ok(
    WAKE_ENGINE.includes('log(`唤醒 ${trigger.title}'),
    '「唤醒 X：已派发/原因」是**事实** ⇒ 保持裸调用（升级它只会稀释级别）',
  )
  // 反面：这两条都不许被"顺手"改掉
  assert.ok(
    !/atLevel\([^)]*\)\(`唤醒 \$\{trigger\.title\}/.test(WAKE_ENGINE),
    '★ 事实那条不许升级 —— "全都升一级"不是迁移，是把级别搞乱',
  )
})

// ── 第五批：其余四个**循环**（同一个形状，一起钉）──────────────────────────

test('★★★ 「tick 异常」这一族**都是 `fault`** —— 一个循环每轮都炸 = 一个子系统没了', () => {
  // 同一个形状出现在四个地方：监视循环 / 系统监视循环 / 唤醒轮询循环 / 端点健康探测循环。
  // 它们的共同点：**循环还在跑、进程还活着、面板还开着**，
  // 而那个循环负责的**整件事**已经不做工了。
  //
  // ⇒ 猜测会判成 `error`（文本里有"异常"）—— 那是**低估**：
  //   `error` = 这一次操作没兜住；这里 = **这一类操作都会出问题**。
  //
  // ★ 这一族与 D6「沉降循环曾完全沉默」是同一个形状的两次出现：
  //   那次是"有话说却不说"；这些是"说了，但级别让人以为只是偶发"。
  const loops: readonly (readonly [string, string])[] = [
    ['../src/wake-runtime.ts', '监视 tick 异常'],
    ['../src/wake-system-monitor.ts', '系统监视 tick 异常'],
    ['../../dsh-component/src/wake-poller.ts', '唤醒轮询 tick 异常'],
    ['../src/endpoint-health.ts', '端点健康探测异常'],
  ]
  for (const [path, phrase] of loops) {
    const src = code(path)
    assert.match(
      src,
      /atLevel\(log, 'fault'\)\(`(?:[^`]*tick 异常|端点健康探测异常)/,
      `★ ${path} 的「${phrase}」必须是 fault —— 循环每轮都炸，是一整个子系统不可用`,
    )
    assert.ok(
      !new RegExp('^\\s*log\\(`' + phrase, 'm').test(src),
      `★ ${path} 那一处不许再是裸调用（裸调用会被猜成 error，**低估**它）`,
    )
    assert.match(src, /import \{ atLevel \}/, `★ ${path} 要真的 import 了那个桥`)
  }
})

test('★★ `endpoint-health.ts` 那处还带一句"循环继续" —— 那正是 fault 的判据', () => {
  // 「（循环继续）」这四个字是**作者自己写的**：这次异常**不会**让循环停下来
  // ⇒ 失败会**一轮一轮地重复**，而每一轮都只是"一条 error"。
  // 那正是"一次 vs 一类"的分界：**它是一类**。
  assert.match(
    code('../src/endpoint-health.ts'),
    /atLevel\(log, 'fault'\)\(`端点健康探测异常（循环继续）/,
    '原文里的「（循环继续）」就是判据本身 —— 升级成 fault 是把作者已经写下的意思落到级别上',
  )
})

// ── 第三批：`wake-bridge-endpoint.ts`（安全相关，**这一批里最要紧的**）──────
//
// ⚠️ 这一行分区注释上一轮被我**顺手删掉了**（改第四批时把锚点替换掉了没补回来）。
//    现在补上 —— 分区注释不是装饰：它让人一眼看出"这批为什么单独成批"。

const WAKE_EP = code('../../dsh-component/src/wake-bridge-endpoint.ts')

test('★★★ 安全拒绝不许是 `info` —— 一次"钥匙不对"显示成普通信息', () => {
  // ## 这条是怎么被发现的
  //
  // 我先扫出"仍然是裸 `log(` 且带『异常/失败』字样"的调用点，然后**跑了一遍 `guessLevel`**
  // 看它们实际会落成什么级别。结果：13 条里 **11 条已经是 `error`**
  // （`log-buffer.ts` 里那个中文关键字 bug 修好之后，猜测就救得回来了）。
  //
  // ⇒ **真正错的只有两条**：「唤醒桥拒绝：密钥不匹配」与「未配置密钥」——
  //   它们**既没有"失败/异常"字样、又确实是安全事件**，于是显示成 `info`。
  //   **"有人在敲门而钥匙不对"和"容器没配密钥"这两种情形，在面板上与普通日志分不出来。**
  //
  // ★ 这个教训值得单独记：**"还剩多少处要迁移"是个会误导人的指标** ——
  //   真正的指标是"**有多少条的级别是错的**"，而后者要靠**跑一遍看结果**才知道，
  //   不能靠数数。
  assert.match(
    WAKE_EP,
    /atLevel\(log, 'warn'\)\('唤醒桥拒绝：密钥不匹配/,
    '★ 密钥不匹配是**安全事件**（可能是配置漂移，也可能是有人在试）—— 必须是 warn',
  )
  assert.match(
    WAKE_EP,
    /atLevel\(log, 'fault'\)\('唤醒桥拒绝：未配置密钥/,
    '★ 没配密钥 ⇒ **整个端点禁用**（谁也唤不醒她，且会一直这样）⇒ 那是 fault（一个子系统），不是"一次请求被拒"',
  )
  // 反面：这两条不许再是裸调用
  assert.ok(
    !/^\s*log\('唤醒桥拒绝/m.test(WAKE_EP),
    '★ 那两条不许再是裸调用 —— 裸调用一律 info，**安全事件会被当成普通信息淹没**',
  )
})
