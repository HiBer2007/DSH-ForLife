/**
 * 日志脱敏的守卫测试（阶段 10 交付物 4）。
 *
 * ## 最值得守的五条
 *
 * 1. **密钥什么都不留** —— 留头留尾等于**泄露了它的一部分**，
 *    而没人需要靠那部分排障。
 * 2. **QQ 号留头尾**（排障要能对上"是不是同一个号"）——
 *    与密钥的处理**刻意不同**。
 * 3. **URL 里的密钥也要脱敏**（`?key=sk-xxx`）——
 *    只处理 `Authorization` 头是不够的，query 传 key 更常见。
 * 4. **媒体 URL 整条替换**（留一部分等于留访问权）。
 * 5. **顺序**：先 URL 再通用形状 —— 反了的话会"看起来脱敏了、其实链接还能点"。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { readFileSync } from 'node:fs'

import { findSensitive, redact, redactingLogger, redactValue } from '../src/redact.ts'

test('★ 密钥**什么都不留**（留头留尾等于泄露了它的一部分）', () => {
  const out = redact('用 oc_sk_d52d3e8dab4b_hOIdD08o25kgWnvw4HYPUCwM8k-4hkaX 调接口')
  assert.ok(!out.includes('hOIdD08o25kg'), `密钥内容不能出现：${out}`)
  assert.ok(!out.includes('d52d3e8dab4b'), '连中间段也不能留')
  assert.match(out, /oc_sk_\*\*\*/)
  // **保留前缀**（认出是哪家的密钥）—— 那不算泄露
  assert.ok(out.includes('oc_sk'), '前缀要留着（用于认出是哪家）')
})

test('★ QQ 号**留头尾**（排障要能对上"是不是同一个号"）', () => {
  const out = redact('来自 1234567890 的消息')
  assert.ok(!out.includes('1234567890'), '完整号码不能出现')
  assert.match(out, /1234\*\*\*890/, `要留头尾：${out}`)
})

test('★ 两种处理**刻意不同**（密钥不留、QQ 留）', () => {
  const out = redact('sk-abcdefghijklmnop 来自 1234567890')
  assert.match(out, /sk-\*\*\*/)
  assert.match(out, /1234\*\*\*890/)
  // 密钥那段没有任何原文残留
  assert.ok(!out.includes('abcdefghij'))
})

test('★ URL 里的密钥也要脱敏（只处理 Authorization 头是不够的）', () => {
  const out = redact('GET https://api.example.com/v1?key=sk-secretvalue123&model=x')
  assert.ok(!out.includes('secretvalue123'), `URL 里的密钥不能留：${out}`)
  assert.match(out, /key=\*\*\*/)
  // **参数名留着**（排障要看出"这里本来有个 key"）
  assert.ok(out.includes('key='), '参数名要留着')
  assert.ok(out.includes('model=x'), '**非敏感参数不该被动**')
})

test('★ 媒体 URL **整条替换**（留一部分等于留访问权）', () => {
  const out = redact('图片：https://multimedia.qq.com/abc/xyz.jpg?term=2&rkey=deadbeef')
  assert.ok(!out.includes('multimedia.qq.com'), `整条都要去掉：${out}`)
  assert.ok(!out.includes('deadbeef'), 'rkey 更不能留')
  assert.match(out, /\[媒体URL已隐藏\]/)
})

test('★ 认证头：保留头名、去掉值', () => {
  const out = redact('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig')
  assert.ok(!out.includes('eyJhbGciOiJIUzI1NiJ9'), '令牌不能留')
  assert.match(out, /Authorization: \*\*\*/i)
})

test('★ 顺序：先 URL 再通用形状（反了会"看起来脱敏了、其实链接还能点"）', () => {
  // 这个 URL 里有一个 32 位十六进制串（会被通用规则命中）
  const out = redact('https://example.com/img.png?id=0123456789abcdef0123456789abcdef')
  // 整条 URL 应当被"媒体 URL"规则先吃掉，而不是留下一个半脱敏的链接
  assert.ok(!out.includes('example.com'), `链接不该还能点：${out}`)
})

test('★ redactValue：对象逐字段处理', () => {
  const out = redactValue({
    qq: '1234567890',
    token: 'sk-abcdefghijklmnop',
    nested: { key: 'oc_sk_abcdefghij' },
    list: ['1234567890'],
    count: 42,
    ok: true,
  }) as Record<string, unknown>
  assert.equal(out['qq'], '1234***890')
  assert.equal(out['token'], 'sk-***')
  assert.equal((out['nested'] as Record<string, unknown>)['key'], 'oc_sk_***')
  assert.deepEqual(out['list'], ['1234***890'])
  // **非字符串原样保留**（不把数字变成字符串 —— 那会破坏下游）
  assert.equal(out['count'], 42)
  assert.equal(out['ok'], true)
})

test('★ redactingLogger：包一层，**让脱敏不可能被忘掉**', () => {
  const seen: string[] = []
  const log = redactingLogger((m) => seen.push(m))
  log('密钥 sk-abcdefghijklmnop 来了')
  assert.equal(seen.length, 1)
  assert.ok(!seen[0]?.includes('abcdefghij'), '**sink 收到的就已经是脱敏过的**')
})

test('普通文本**不该被动**（脱敏不是"什么都打码"）', () => {
  const text = '任务完成：处理了 3 条消息，耗时 12 毫秒'
  assert.equal(redact(text), text, '没有敏感内容就该原样返回')
})

test('短数字不该被当 QQ 号（可能是序号、耗时、条数）', () => {
  assert.equal(redact('第 1234 条'), '第 1234 条', '4 位数太短，不是 QQ 号')
  assert.equal(redact('耗时 12345 毫秒'), '耗时 12345 毫秒', '5 位数字在正文里太常见')
})

test('★ findSensitive：能报出**漏了哪一类**（不只是布尔）', () => {
  assert.deepEqual(findSensitive('一切正常'), [])
  const hits = findSensitive('Authorization: Bearer x sk-abcdefghijklmnop')
  assert.ok(hits.includes('认证头'), `应当报出认证头：${hits.join(',')}`)
  assert.ok(hits.includes('密钥(sk)'), `应当报出密钥：${hits.join(',')}`)
})

test('★ 自检：脱敏后的文本**不再命中** findSensitive', () => {
  const dirty = 'Authorization: Bearer tok123456 https://multimedia.qq.com/a.jpg?rkey=x sk-abcdefghijklmnop 来自 1234567890'
  const clean = redact(dirty)
  const remaining = findSensitive(clean)
  assert.deepEqual(remaining, [], `脱敏后不该还有敏感内容，剩下：${remaining.join(',')}｜${clean}`)
})

test('★ 全局正则的 lastIndex 不会污染下一次调用（踩过的坑）', () => {
  // 全局正则带 g 时 test() 会推进 lastIndex ——
  // 不重置的话**第二次调用会误判**
  const dirty = 'https://multimedia.qq.com/a.jpg'
  assert.ok(findSensitive(dirty).length > 0, '第一次要命中')
  assert.ok(findSensitive(dirty).length > 0, '**第二次也要命中**（lastIndex 必须重置）')
})

test('★★ 接线守卫：脱敏真的挂在**唯一汇聚点**上（源码级断言）', () => {
  // 这条测的是"**接线有没有被摘掉**" —— 而它是本项目反复出问题的地方
  // （whitelist 参数被丢、onConnectionState 被构造函数丢掉，两次都是单测全绿）。
  //
  // 纯函数测不出"有没有被调用"。所以这里直接读源码断言接线还在。
  //
  // ★ 2026-10-10 改成**形状无关**的断言：原来写死 `logBuffer.push(safe)`，
  //   而那天日志线改造把它换成了 `logBuffer.pushRecord(record)`（`record.text = safe`）
  //   —— **性质一点没变，断言却红了**。写死形状的守卫会在每次正当重构时误报，
  //   久了就变成"红了就改断言"，那等于没有守卫。
  //   ⇒ 改成直接断言**失败模式本身**（未脱敏的原文不许流进任何出口），与写法无关。
  const src = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8')
  assert.match(src, /redact\(message\)/, '**脱敏必须挂在 log 汇聚点上**')
  assert.match(src, /text: safe\b/, '送进缓冲/落盘的那条记录，文本必须是 safe（不是原文）')
  assert.match(src, /options\.log\?\.\(safe\)/, 'stdout 那条出口也要脱敏')
  // 结构化那条入口（`createLogger` 的记录）同样要先脱敏再出口
  assert.match(src, /text: redact\(record\.text\)/, '结构化那条入口也要脱敏')

  // ★★ 真正要禁止的东西：**未经脱敏的 `message` 不许流进任何出口**。
  // 这条与"用哪个方法、分几条出口"无关 —— 以后再加第三条出口也照样被它拦住。
  const leaks = [
    /\blogBuffer\.\w+\(\s*message\s*\)/,
    /\blogStore\.write\(\s*message\s*\)/,
    /options\.log\?\.\(\s*message\s*\)/,
  ]
  for (const pattern of leaks) {
    assert.ok(
      !pattern.test(src),
      `★ 未脱敏的原文流进了出口（命中 ${String(pattern)}）—— ` +
        '日志一旦写下去就收不回来了（会被复制、打包、发给别人看）',
    )
  }
})
