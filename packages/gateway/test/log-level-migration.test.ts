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
