/**
 * 日志缓冲的**七级 + 模块 + 筛选**测试（用户 2026-10-10 指定）。
 *
 * ## 这里最要紧的一条
 *
 * **★ 猜测级别绝不猜 `fault` / `crash`。**
 *
 * 那两级的定义是「**一个子系统**坏了」与「**整个进程**要没了」—— 那是**影响范围**
 * 的判断，**正则看不出来**。而猜错的代价不对称：
 * 把一条普通的 `error` 猜成 `crash` 会让面板出现**最高等级的假警报**，
 * 假警报会训练人忽略这一级，于是**真的 crash 也没人看**。
 *
 * 其余几条：真级别/真模块要走通、旧调用点仍然能跑（猜的）、
 * 面板筛选（等级/模块/文本/条数）与"从最新往回取"。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { LEGACY_LOG_MODULE, LogBuffer, guessLevel } from '../src/admin/log-buffer.ts'
import { LOG_LEVELS } from '../src/admin/log-levels.ts'

test('★★★ 猜测**绝不**猜出 fault / crash —— 只在 info / warn / error 三级里选', () => {
  const samples = [
    'error 失败 异常 ✖ failed',
    'warn 警告 ⚠ 重试 降级',
    '普通一句话',
    // 下面这些文本里**出现了**那两级的关键字，但猜测**不许**把它们判成 fault/crash
    '子系统 fault 了',
    '进程 crash 了 崩溃',
    'FAULT CRASH 全大写',
  ]
  for (const text of samples) {
    const level = guessLevel(text)
    assert.ok(
      ['info', 'warn', 'error'].includes(level),
      `猜出来的级别必须是 info/warn/error 之一（实际 ${level}，输入「${text}」）—— ` +
        'fault/crash 是"影响范围"的判断，正则看不出来；猜错会造成最高等级的假警报',
    )
  }
  // 而且猜测**绝不**返回 debug / note（那是"作者知道"的信息，也猜不出来）
  assert.ok(!['debug', 'note', 'fault', 'crash'].includes(guessLevel('随便什么')))
})

test('★★ 旧调用点仍能跑：`push(text)` 猜级别、模块记 gateway', () => {
  const buffer = new LogBuffer(50)
  buffer.push('出错了 失败')
  buffer.push('一切正常')
  const lines = buffer.tail(10)
  assert.equal(lines.length, 2)
  assert.equal(lines[0]?.level, 'error', '旧调用点的级别是**猜**的（这是"不改完 127 处也能跑"的代价）')
  assert.equal(lines[0]?.module, LEGACY_LOG_MODULE)
  assert.equal(lines[1]?.level, 'info')
})

test('★★★ 中文关键字**必须**能被猜出来（这里原本是个一直存在的 bug）', () => {
  // 原写法 `/\b(error|失败|异常|✖|failed)\b/i`：`\b` 是"单词字符与非单词字符"的边界，
  // 而 `\w` 只含 `[A-Za-z0-9_]` —— **汉字不是 `\w`** ⇒ 中文那几个关键字
  // **从来没生效过**，面板上中文的"失败/警告"一直显示成 info。
  //
  // ★ 这条测试的意义不只是"修好了"：它证明**当时没有任何测试用过中文关键字**。
  //   语言不该让一条断言静默失效。
  const cases: readonly [string, 'error' | 'warn'][] = [
    ['出错了 失败', 'error'],
    ['抛了 异常', 'error'],
    ['✖ 这一步没过', 'error'],
    ['⚠ 降级处理', 'warn'],
    ['警告：配额快满了', 'warn'],
    ['重试第 2 次', 'warn'],
    // 英文那条路也不能因为改动而退化
    ['failed to connect', 'error'],
    ['warn: retrying', 'warn'],
  ]
  for (const [text, want] of cases) {
    assert.equal(guessLevel(text), want, `「${text}」该判成 ${want}`)
  }
  // ★ 假阳性也要挡住：`errorCode` 这种标识符里的 error 不该让一整行升级
  assert.equal(guessLevel('errorCode=0 一切正常'), 'info', '带边界的那条要挡住标识符里的 error')
})

test('★★ 新入口 `pushRecord`：级别与模块都是**真的**（含 fault / crash）', () => {
  const buffer = new LogBuffer(50)
  buffer.pushRecord({ level: 'fault', module: 'onebot', text: 'QQ 链路掉了', at: '2026-10-10T00:00:00.000Z' })
  buffer.pushRecord({ level: 'crash', module: 'boot', text: '未捕获异常', at: '2026-10-10T00:00:01.000Z' })
  const lines = buffer.tail(10)
  assert.deepEqual(
    lines.map((l) => `${l.level}/${l.module}`),
    ['fault/onebot', 'crash/boot'],
    '★ 这两级**只能**由结构化入口给出 —— 这正是 guesses 不许碰它们的原因',
  )
  // 序号仍然单调递增（前端增量拉取靠它）
  assert.deepEqual(lines.map((l) => l.seq), [1, 2])
})

test('★★ 面板筛选：等级 / 模块 / 文本 / 条数（且从**最新**往回取）', () => {
  const buffer = new LogBuffer(50)
  const push = (level: Parameters<typeof buffer.pushRecord>[0]['level'], module: string, text: string): void => {
    buffer.pushRecord({ level, module, text, at: '2026-10-10T00:00:00.000Z' })
  }
  push('info', 'boot', '启动了')
  push('note', 'wake-liveness', '预算不够，没唤醒')
  push('fault', 'onebot', 'QQ 链路掉了')
  push('info', 'boot', '又一条启动信息')

  assert.deepEqual(buffer.query({ modules: ['boot'] }).map((l) => l.text), ['启动了', '又一条启动信息'])
  assert.deepEqual(buffer.query({ levels: ['fault'] }).map((l) => l.text), ['QQ 链路掉了'])
  assert.deepEqual(buffer.query({ levels: ['info', 'note'] }).map((l) => l.level), ['info', 'note', 'info'])
  assert.deepEqual(buffer.query({ contains: '唤醒' }).map((l) => l.module), ['wake-liveness'])
  assert.equal(buffer.query({ limit: 2 }).length, 2)
  assert.deepEqual(
    buffer.query({ limit: 2 }).map((l) => l.text),
    ['QQ 链路掉了', '又一条启动信息'],
    '★ limit 取**最新**那几条（面板要看"最近发生了什么"）',
  )
  // 空筛选 = 全给
  assert.equal(buffer.query().length, 4)
})

test('★ 模块清单（面板下拉用，免得手打拼错）', () => {
  const buffer = new LogBuffer(50)
  buffer.pushRecord({ level: 'info', module: 'onebot', text: 'a', at: 'x' })
  buffer.pushRecord({ level: 'info', module: 'boot', text: 'b', at: 'x' })
  buffer.pushRecord({ level: 'info', module: 'onebot', text: 'c', at: 'x' })
  buffer.push('旧调用点') // ⇒ module = gateway
  assert.deepEqual(buffer.modules(), ['boot', 'gateway', 'onebot'], '去重且排序')
})

test('★ 七级都能进缓冲（`LogLevel` 与 `LOG_LEVELS` 是同一份）', () => {
  const buffer = new LogBuffer(50)
  for (const level of LOG_LEVELS) {
    buffer.pushRecord({ level, module: 'm', text: `${level} 的话`, at: 'x' })
  }
  assert.deepEqual(
    buffer.query().map((l) => l.level),
    [...LOG_LEVELS],
    '七级一个都不许被缓冲吞掉（面板要能按每一级筛）',
  )
})

test('★★ 接线守卫：`/logs` 接口真的把筛选参数接上了（源码级、去注释）', async () => {
  const { readFileSync } = await import('node:fs')
  const raw = readFileSync(new URL('../src/admin/api.ts', import.meta.url), 'utf8')
  // 去注释：注释里引用的写法不许把守卫骗过去
  const src = raw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n')

  assert.match(src, /searchParams\.get\('levels'\)/, '等级筛选参数要读')
  assert.match(src, /searchParams\.get\('modules'\)/, '模块筛选参数要读')
  assert.match(src, /buffer\.query\(/, '有筛选时要走 `query()`（不是 `tail`/`since`）')
  assert.match(src, /filtered: true/, '★ 要明确告诉前端"这一批不是增量的"')
  assert.match(src, /modules: known/, '模块清单要一起回（面板下拉用）')
  // ★ 筛选与 since 不能并用：有筛选的那一支**不许**出现 since
  const filteredBranch = src.slice(src.indexOf('if (filtered)'), src.indexOf('if (filtered)') + 400)
  assert.ok(
    !filteredBranch.includes('since'),
    '★ 有筛选时不许再用 `since` —— 两者并用会让每个轮询周期得到不同的集合，前端增量追加会错位',
  )
})
