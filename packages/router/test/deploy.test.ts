/**
 * 部署流水线与可续传下载的测试。
 *
 * 这一批的重点是**护栏真的会拦住**以及**失败真的会回滚**：
 *  - 预检发现问题 ⇒ 一步都不执行（比"跑了三步再回滚"好得多）；
 *  - 远端主机不在白名单 / 没确认 ⇒ 拒绝执行；
 *  - 致命失败 ⇒ 逆序回滚已完成的步骤，且**权重不回滚**（保留可续）；
 *  - 下载：幂等跳过、断点续传、SHA 失败能重下。
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { after, before, test } from 'node:test'

import {
  checkRemoteGuard,
  planDeploy,
  runDeploy,
  type DeployExecutor,
  type DeploySpec,
  type DeployStep,
  type LocalDockerTarget,
  type RemoteSshTarget,
} from '../src/deploy.ts'
import { fileSha256, resumableDownload, sameSha256 } from '../src/download.ts'
import { emptyDeviceProbe } from '../src/endpoints.ts'

const dir = mkdtempSync(join(tmpdir(), 'forlife-deploy-'))

after(async () => {
  for (let i = 0; i < 6; i++) {
    try {
      rmSync(dir, { recursive: true, force: true })
      return
    } catch {
      await delay(40)
    }
  }
})

/** 一台"什么都没有"的机器（本项目实际环境）。 */
const BARE = emptyDeviceProbe()

/** 基本规格。 */
function makeSpec(overrides: Partial<DeploySpec> = {}): DeploySpec {
  const target: LocalDockerTarget = { kind: 'local-docker', containerName: 'forlife-scorer' }
  return {
    endpointId: 'ep-scorer',
    target,
    model: { id: 'Qwen2.5-0.5B-Instruct', quantization: 'Q4', sha256: 'a'.repeat(64), url: 'https://example.test/model.gguf', sizeBytes: 400 * 1024 * 1024 },
    backend: 'cpu',
    arch: 'x64',
    devices: BARE,
    port: 8080,
    modelRoot: '/models',
    preflight: { arch: 'x64', cpuCores: 4, memoryMb: 8192, diskFreeMb: 50_000, portInUse: false, devices: BARE },
    ...overrides,
  }
}

/** 记录所有命令的假执行器。 */
function fakeExecutor(
  options: { failOn?: (command: readonly string[]) => boolean; failHttp?: (url: string) => boolean; failDownload?: () => boolean } = {},
): DeployExecutor & { readonly commands: string[][] } {
  const commands: string[][] = []
  return {
    commands,
    async exec(command) {
      commands.push([...command])
      if (options.failOn?.(command) === true) return { ok: false, stderr: '模拟失败' }
      return { ok: true, stdout: 'ok' }
    },
    async download() {
      if (options.failDownload?.() === true) return { ok: false, error: '模拟下载失败' }
      return { ok: true }
    },
    async checkHttp(input) {
      // 注意：健康检查走的是 checkHttp 而不是 exec ——
      // 我第一版假执行器只覆盖了 exec，于是"让健康检查失败"根本没生效（测试假绿）
      if (options.failHttp?.(input.url) === true) return { ok: false, status: 503, error: '模拟健康检查失败' }
      return { ok: true, status: 200 }
    },
  }
}

test('计划：本机 docker 目标产出完整步骤序列（准备目录 → 下载 → 拉镜像 → 起容器 → 健康 → 预热 → 注册）', () => {
  const plan = planDeploy(makeSpec())
  assert.deepEqual(plan.blockers, [])
  const ids = plan.steps.map((step) => step.id)
  assert.deepEqual(ids, ['prepare-dir', 'download-weights', 'pull-image', 'remove-old', 'run-container', 'health-check', 'warmup', 'register'])
})

test('计划：权重步骤**刻意没有回滚**（权重要保留，下次可续）', () => {
  const plan = planDeploy(makeSpec())
  const download = plan.steps.find((step) => step.id === 'download-weights')
  assert.equal(download?.rollback, undefined, '权重不该被回滚删掉 —— 那是验收里明写的行为')
  assert.match(String(download?.note), /续传/)
  // 而容器步骤必须能在远端/本机都回滚
  const runContainer = plan.steps.find((step) => step.id === 'run-container')
  assert.ok(runContainer?.rollback !== undefined)
  assert.match(String(runContainer?.note), /远端也执行/)
})

test('计划：装不下的组合被拦在预检（磁盘不够 ⇒ 一步都不执行）', () => {
  const plan = planDeploy(makeSpec({ preflight: { arch: 'x64', cpuCores: 4, memoryMb: 8192, diskFreeMb: 100, portInUse: false, devices: BARE } }))
  assert.ok(plan.blockers.some((item) => item.includes('磁盘可用')))
  assert.match(plan.blockers[0] ?? '', /临时文件/, '要说清为什么要 1.5 倍空间')
})

test('计划：端口被占用、架构不一致都要拦', () => {
  const port = planDeploy(makeSpec({ preflight: { arch: 'x64', cpuCores: 4, memoryMb: 8192, diskFreeMb: 50_000, portInUse: true, devices: BARE } }))
  assert.ok(port.blockers.some((item) => item.includes('端口')))

  const arch = planDeploy(makeSpec({ arch: 'arm64' }))
  assert.ok(arch.blockers.some((item) => item.includes('架构不一致')), '在 A 机器上规划 B 机器的部署是危险的')
})

test('计划：后端不可用（选 cuda 但没 NVIDIA）也是阻塞项，且提示要换后端', () => {
  const plan = planDeploy(makeSpec({ backend: 'cuda' }))
  assert.ok(plan.blockers.some((item) => item.includes('NVIDIA')))
  assert.match(plan.blockers[0] ?? '', /换后端/)
})

test('计划：CPU 后端要提示"会经常触发超时降级"（诚实说明，不粉饰）', () => {
  const plan = planDeploy(makeSpec())
  assert.ok(plan.warnings.some((item) => item.includes('超时降级')))
  assert.ok(plan.warnings.some((item) => item.includes('预评分')))
})

test('计划：远端目标的每个命令都包了 ssh（凭据不进命令）', () => {
  const target: RemoteSshTarget = { kind: 'remote-ssh', host: 'gpu-box.local', user: 'forlife', port: 2222, containerName: 'forlife-scorer', modelRoot: '/srv/models' }
  const plan = planDeploy(makeSpec({ target }))
  const pull = plan.steps.find((step) => step.id === 'pull-image')
  assert.equal(pull?.command[0], 'ssh')
  assert.ok(pull?.command.includes('forlife@gpu-box.local'))
  assert.match(pull?.command.join(' ') ?? '', /docker pull/)
  // 端口要带上
  assert.ok(pull?.command.includes('-p'))
})

test('远端护栏：不在白名单 ⇒ 拒绝（这是防止误发命令到别的机器）', () => {
  const target: RemoteSshTarget = { kind: 'remote-ssh', host: 'evil.example', containerName: 'c', modelRoot: '/m' }
  const verdict = checkRemoteGuard(target, { hostWhitelist: ['gpu-box.local'], requireConfirmation: true, confirmed: true })
  assert.equal(verdict.allowed, false)
  assert.match(String(verdict.reason), /不在白名单/)
})

test('远端护栏：没显式确认 ⇒ 拒绝，并提示先看 dry-run', () => {
  const target: RemoteSshTarget = { kind: 'remote-ssh', host: 'gpu-box.local', containerName: 'c', modelRoot: '/m' }
  const noConfirm = checkRemoteGuard(target, { hostWhitelist: ['gpu-box.local'], requireConfirmation: true })
  assert.equal(noConfirm.allowed, false)
  assert.match(String(noConfirm.reason), /dry-run/)
  assert.equal(checkRemoteGuard(target, { hostWhitelist: ['gpu-box.local'], requireConfirmation: true, confirmed: true }).allowed, true)
  // 策略放行（不要求确认）时直接通过
  assert.equal(checkRemoteGuard(target, { hostWhitelist: ['gpu-box.local'], requireConfirmation: false }).allowed, true)
  // 本机目标不受远端护栏约束
  assert.equal(checkRemoteGuard({ kind: 'local-docker', containerName: 'c' }, { hostWhitelist: [], requireConfirmation: true }).allowed, true)
})

test('dry-run：**什么都不执行**，但把将执行的命令序列给出来（验收项）', async () => {
  const executor = fakeExecutor()
  const result = await runDeploy(planDeploy(makeSpec()), { executor, dryRun: true })
  assert.equal(result.ok, true)
  assert.equal(executor.commands.length, 0, 'dry-run 绝不能真的执行命令')
  assert.ok(result.steps.every((step) => step.skipped === true))
  const printed = result.steps.map((step) => step.stdout).join('\n')
  assert.match(printed, /docker pull/)
  assert.match(printed, /docker run/)
  assert.ok(result.warnings.some((item) => item.includes('dry-run')))
})

test('执行：成功路径把所有步骤跑完', async () => {
  const executor = fakeExecutor()
  const result = await runDeploy(planDeploy(makeSpec()), { executor })
  assert.equal(result.ok, true)
  assert.equal(result.steps.length, 8)
  assert.ok(executor.commands.some((command) => command.includes('pull')))
  assert.ok(executor.commands.some((command) => command.includes('run')))
})

test('回滚：致命失败 ⇒ 逆序回滚**已完成**的步骤（不是重来一遍）', async () => {
  // 让健康检查失败（那是 critical 且带 rollback 的步骤）
  const executor = fakeExecutor({ failHttp: (url) => url.includes('/health') })
  const result = await runDeploy(planDeploy(makeSpec()), { executor })

  assert.equal(result.ok, false)
  assert.match(String(result.error), /健康检查/)
  // 起容器成功了 ⇒ 它的 rollback 应当被跑（docker rm -f）
  assert.ok(result.rolledBack.includes('run-container'), `应当回滚 run-container，实际回滚了 ${result.rolledBack.join(',')}`)
  assert.ok(executor.commands.some((command) => command.join(' ').includes('rm -f')), '回滚命令要真的执行')
  // 权重步骤没有 rollback ⇒ 不该出现在回滚列表里（也不该被删）
  assert.ok(!result.rolledBack.includes('download-weights'))
  assert.deepEqual(result.rollbackFailures, [])
})

test('回滚：非致命步骤失败**不回滚**，只记警告继续（预热失败不该拆掉整个部署）', async () => {
  const executor = fakeExecutor({ failOn: (command) => command.join(' ').includes('chat/completions') })
  const result = await runDeploy(planDeploy(makeSpec()), { executor })
  assert.equal(result.ok, true, '预热失败不该让部署失败')
  assert.ok(result.warnings.some((item) => item.includes('非致命步骤失败')))
  assert.deepEqual(result.rolledBack, [])
})

test('回滚失败要如实报告（不能假装回滚干净了）', async () => {
  const executor: DeployExecutor = {
    async exec(command) {
      if (command.join(' ').includes('rm -f')) return { ok: false, stderr: '容器删不掉：permission denied' }
      return { ok: true }
    },
    async download() {
      return { ok: true }
    },
    async checkHttp() {
      return { ok: false, status: 503, error: '健康检查失败' }
    },
  }
  const result = await runDeploy(planDeploy(makeSpec()), { executor })
  assert.equal(result.ok, false)
  assert.ok(result.rollbackFailures.length > 0, '回滚失败必须暴露出来')
  assert.match(result.rollbackFailures[0] ?? '', /permission denied/)
})

test('阻塞项：预检有问题时 runDeploy 一步都不执行', async () => {
  const executor = fakeExecutor()
  const plan = planDeploy(makeSpec({ preflight: { arch: 'x64', cpuCores: 4, memoryMb: 8192, diskFreeMb: 1, portInUse: false, devices: BARE } }))
  const result = await runDeploy(plan, { executor })
  assert.equal(result.blocked, true)
  assert.equal(executor.commands.length, 0)
  assert.match(String(result.error), /磁盘/)
})

test('external-api 目标：只探活，不部署任何东西', () => {
  const plan = planDeploy(makeSpec({ target: { kind: 'external-api', baseUrl: 'http://10.0.0.9:8080/v1' } }))
  assert.equal(plan.steps.length, 1)
  assert.equal(plan.steps[0]?.id, 'probe')
  assert.equal(plan.steps[0]?.kind, 'http-check')
  assert.match(String(plan.steps[0]?.note), /只做注册与探活/)
})

// ── 下载 ───────────────────────────────────────────────────────────────────

/** 造一个能模拟"服务端支持 Range"的假 fetch。 */
function fakeFetch(content: Buffer, options: { ignoreRange?: boolean; corruptFirst?: boolean } = {}): typeof fetch {
  let calls = 0
  return (async (_url: string | URL | Request, init?: RequestInit) => {
    calls += 1
    const headers = (init?.headers ?? {}) as Record<string, string>
    const rangeHeader = headers['range']
    let start = 0
    if (rangeHeader !== undefined && options.ignoreRange !== true) {
      const match = /bytes=(\d+)-/.exec(rangeHeader)
      start = match === null ? 0 : Number(match[1])
    } else if (rangeHeader !== undefined && options.ignoreRange === true) {
      start = 0
    }
    const slice = content.subarray(start)
    // 第一次给坏数据（模拟下载损坏），用来验"SHA 失败能重下"
    const body = options.corruptFirst === true && calls === 1 ? Buffer.from('CORRUPTED') : slice
    return new Response(body, {
      status: rangeHeader !== undefined && options.ignoreRange !== true && start > 0 ? 206 : 200,
      headers: { 'content-length': String(body.length) },
    })
  }) as unknown as typeof fetch
}

test('下载：正常下载 + SHA 校验通过 + 原子改名', async () => {
  const content = Buffer.from('x'.repeat(10_000))
  const sha = createHash('sha256').update(content).digest('hex')
  const dest = join(dir, 'model-a.gguf')
  const result = await resumableDownload({ url: 'http://x/m.gguf', dest, sha256: sha, fetchImpl: fakeFetch(content) })
  assert.equal(result.ok, true)
  assert.equal(result.skipped, false)
  assert.equal(readFileSync(dest).length, 10_000)
  assert.equal(existsSync(`${dest}.part`), false, '校验通过后 .part 必须消失（原子改名）')
})

test('下载：幂等 —— 已下好且校验通过就直接跳过（重跑部署不该重下几个 GB）', async () => {
  const content = Buffer.from('y'.repeat(5_000))
  const sha = createHash('sha256').update(content).digest('hex')
  const dest = join(dir, 'model-b.gguf')
  writeFileSync(dest, content)
  let fetched = 0
  const counting: typeof fetch = (async () => {
    fetched += 1
    return new Response('不该被调用')
  }) as unknown as typeof fetch
  const result = await resumableDownload({ url: 'http://x/m.gguf', dest, sha256: sha, fetchImpl: counting })
  assert.equal(result.ok, true)
  assert.equal(result.skipped, true)
  assert.equal(fetched, 0, '幂等跳过时不该发请求')
})

test('下载：断点续传 —— 已有 .part 时带 Range 从断点继续', async () => {
  const content = Buffer.from('z'.repeat(8_000))
  const sha = createHash('sha256').update(content).digest('hex')
  const dest = join(dir, 'model-c.gguf')
  const part = `${dest}.part`
  // 模拟"上次下了 3000 字节就断了"
  writeFileSync(part, content.subarray(0, 3_000))

  const ranges: string[] = []
  const base = fakeFetch(content)
  const tracking: typeof fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>
    if (headers['range'] !== undefined) ranges.push(headers['range'])
    return await base(url as never, init)
  }) as unknown as typeof fetch

  const result = await resumableDownload({ url: 'http://x/m.gguf', dest, sha256: sha, fetchImpl: tracking })
  assert.equal(result.ok, true)
  assert.equal(result.resumed, true)
  assert.deepEqual(ranges, ['bytes=3000-'], '必须从断点继续，而不是从头下')
  assert.equal(readFileSync(dest).length, 8_000, '拼起来必须完整')
})

test('下载：服务端不支持 Range（回 200）⇒ 从头下，避免两段拼成坏文件', async () => {
  const content = Buffer.from('w'.repeat(6_000))
  const sha = createHash('sha256').update(content).digest('hex')
  const dest = join(dir, 'model-d.gguf')
  writeFileSync(`${dest}.part`, content.subarray(0, 1_000))
  const result = await resumableDownload({ url: 'http://x/m.gguf', dest, sha256: sha, fetchImpl: fakeFetch(content, { ignoreRange: true }) })
  assert.equal(result.ok, true)
  assert.equal(readFileSync(dest).length, 6_000)
})

test('下载：SHA 校验失败 ⇒ 删掉坏文件并重下（验收项：校验失败能重下）', async () => {
  const content = Buffer.from('v'.repeat(4_000))
  const sha = createHash('sha256').update(content).digest('hex')
  const dest = join(dir, 'model-e.gguf')
  const result = await resumableDownload({ url: 'http://x/m.gguf', dest, sha256: sha, fetchImpl: fakeFetch(content, { corruptFirst: true }), maxAttempts: 2 })
  assert.equal(result.ok, true, '重下之后应当成功')
  assert.ok(result.attempts >= 2, '应当至少下了两次')
  assert.equal(readFileSync(dest).length, 4_000)
})

test('下载：一直校验不过 ⇒ 如实失败（不留下"看起来下好了"的文件）', async () => {
  const dest = join(dir, 'model-f.gguf')
  const result = await resumableDownload({
    url: 'http://x/m.gguf',
    dest,
    sha256: 'b'.repeat(64),
    fetchImpl: fakeFetch(Buffer.from('wrong content')),
    maxAttempts: 1,
  })
  assert.equal(result.ok, false)
  assert.match(String(result.error), /SHA-256 不匹配/)
  assert.equal(existsSync(dest), false, '校验不过就绝不能留目标文件（否则上层会以为权重已就绪）')
})

test('SHA 比较：大小写不敏感、容忍 sha256: 前缀', () => {
  assert.equal(sameSha256('ABCDEF', 'abcdef'), true)
  assert.equal(sameSha256('sha256:abc', 'ABC'), true)
  assert.equal(sameSha256('abc', 'abd'), false)
})

test('fileSha256 与 crypto 结果一致（别自己实现哈希）', async () => {
  const path = join(dir, 'hash-check.bin')
  writeFileSync(path, 'hello world')
  const expected = createHash('sha256').update('hello world').digest('hex')
  assert.equal(await fileSha256(path), expected)
})

test('计划里的下载步骤：命令与参数一致（dry-run 看到的 curl 就是真会跑的语义）', () => {
  const plan = planDeploy(makeSpec())
  const step = plan.steps.find((item) => item.id === 'download-weights') as DeployStep
  assert.ok(step.command.join(' ').includes('-C -'), 'curl 要带 -C -（续传）')
  assert.equal(step.download?.sha256, 'a'.repeat(64))
  assert.equal(step.download?.dest, '/models/Qwen2.5-0.5B-Instruct-Q4.gguf')
})

