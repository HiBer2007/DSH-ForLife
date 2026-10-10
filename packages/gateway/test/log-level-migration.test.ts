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
  const debugs = ROUTER.match(/atLevel\(log, 'debug'\)/g) ?? []
  assert.equal(
    debugs.length,
    4,
    `四处观察日志该是 debug（created / pre-step 两条 / turn-stopping）。实际 ${String(debugs.length)} 处`,
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
