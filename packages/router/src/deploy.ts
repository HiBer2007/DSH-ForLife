/**
 * 自动部署流水线（§2.13.3）—— 两个目标共用一套步骤，**幂等、可中断、可回滚**。
 *
 * ## 设计要点
 *
 * ① **先把命令算出来，再执行**：`planDeploy()` 是纯函数，产出的每一步都带
 *    将在哪台机器上执行的**完整命令**。dry-run 就是把它们打出来 —— 人能在
 *    "真的动我的服务器"之前看一眼。这是远端部署那条验收（"`--dry-run` 先展示命令序列"）的实现。
 *
 * ② **回滚是"已完成步骤的逆序回滚"**，不是"重来一遍"：只回滚真正做过的步骤。
 *    权重**不回滚**（保留下来，下次可续）—— 这是验收里明写的行为。
 *
 * ③ **远端护栏**：目标主机必须在白名单里；没有显式确认就不执行（除非策略放行）；
 *    回滚**也在远端执行**（否则远端会留一个跑着的容器）。
 *
 * ④ **凭据绝不入日志**：远端命令里如果需要密钥，一律用环境变量名占位，
 *    真实值通过 executor 的 env 注入，`planDeploy` 的产物里只有变量名。
 *
 * @module @forlife/router/deploy
 */
import { planBackend, type AcceleratorBackend, type Architecture, type DeviceProbe } from './endpoints.ts'

/** 部署目标。 */
export type DeployTargetKind = 'local-docker' | 'remote-ssh' | 'external-api'

/** 本机 docker 目标。 */
export interface LocalDockerTarget {
  readonly kind: 'local-docker'
  /** 容器名（用端点 id 派生，保证幂等）。 */
  readonly containerName: string
}

/** 远端 ssh 目标。 */
export interface RemoteSshTarget {
  readonly kind: 'remote-ssh'
  readonly host: string
  readonly user?: string
  readonly port?: number
  readonly containerName: string
  /** 远端模型根目录。 */
  readonly modelRoot: string
}

/** 外部已有服务（只登记不部署）。 */
export interface ExternalApiTarget {
  readonly kind: 'external-api'
  readonly baseUrl: string
}

/** 部署目标。 */
export type DeployTarget = LocalDockerTarget | RemoteSshTarget | ExternalApiTarget

/** 部署规格。 */
export interface DeploySpec {
  readonly endpointId: string
  readonly target: DeployTarget
  readonly model: { readonly id: string; readonly quantization: string; readonly sha256: string; readonly url: string; readonly sizeBytes?: number }
  readonly backend: AcceleratorBackend
  readonly arch: Architecture
  readonly devices: DeviceProbe
  /** 推理服务监听端口（容器内）。 */
  readonly port: number
  /** 模型根目录（本机或远端，取决于目标）。 */
  readonly modelRoot: string
  readonly registryPrefix?: string
  /** 预检结果（内存/磁盘）。 */
  readonly preflight?: PreflightResult
  /** 其它常驻服务占用的内存（选型要扣除）。 */
  readonly reservedMemoryMb?: number
}

/** 预检结果（§2.13.3 第 1 步）。 */
export interface PreflightResult {
  readonly arch: Architecture
  readonly cpuCores: number
  readonly memoryMb: number
  /** 模型根所在磁盘的可用空间（MB）。 */
  readonly diskFreeMb: number
  /** 端口是否已被占用。 */
  readonly portInUse: boolean
  readonly devices: DeviceProbe
}

/** 步骤类型。 */
export type DeployStepKind = 'shell' | 'download' | 'http-check'

/** 一步。 */
export interface DeployStep {
  readonly id: string
  readonly title: string
  readonly kind: DeployStepKind
  /** 将被执行的完整命令（dry-run 就是把它打出来）。 */
  readonly command: readonly string[]
  /** 失败时的回滚命令（可选；权重步骤刻意没有）。 */
  readonly rollback?: readonly string[]
  /** 失败是否致命（非致命只警告继续）。 */
  readonly critical: boolean
  /** 下载步骤的参数。 */
  readonly download?: { readonly url: string; readonly dest: string; readonly sha256: string; readonly sizeBytes?: number }
  /** 健康检查参数。 */
  readonly httpCheck?: { readonly url: string; readonly expectStatus: number; readonly timeoutMs: number }
  /** 给操作者的说明（dry-run 输出里显示）。 */
  readonly note?: string
}

/** 部署计划。 */
export interface DeployPlan {
  readonly spec: DeploySpec
  readonly steps: readonly DeployStep[]
  /** 预检/选型阶段就发现的问题（**致命问题不该走到执行**）。 */
  readonly blockers: readonly string[]
  readonly warnings: readonly string[]
}

/** 生成部署计划（**纯函数**：不碰网络、不碰文件系统、不碰 docker）。 */
export function planDeploy(spec: DeploySpec): DeployPlan {
  const blockers: string[] = []
  const warnings: string[] = []

  const backendPlan = planBackend({
    backend: spec.backend,
    arch: spec.arch,
    devices: spec.devices,
    ...(spec.registryPrefix === undefined ? {} : { registryPrefix: spec.registryPrefix }),
  })
  if (!backendPlan.supported) {
    blockers.push(`${backendPlan.reason ?? '后端不可用'} —— 请在保存前换后端（不要等到启动时才发现）`)
  }

  // 预检：磁盘要装得下权重（留 1.5 倍余量：下载中的 .part 与最终文件会同时存在）
  if (spec.preflight !== undefined && spec.model.sizeBytes !== undefined) {
    const needMb = Math.ceil((spec.model.sizeBytes * 1.5) / 1024 / 1024)
    if (spec.preflight.diskFreeMb < needMb) {
      blockers.push(
        `模型根磁盘可用 ${String(spec.preflight.diskFreeMb)}MB，需要约 ${String(needMb)}MB（含下载中的临时文件）—— 先清理或换模型根`,
      )
    }
  }
  if (spec.preflight?.portInUse === true) {
    blockers.push(`端口 ${String(spec.port)} 已被占用（预检发现）—— 换个端口或先停掉占用它的服务`)
  }
  if (spec.preflight !== undefined && spec.preflight.arch !== spec.arch) {
    // 架构不一致通常意味着"在 A 机器上规划 B 机器的部署"，那是危险的
    blockers.push(`计划里写的是 ${spec.arch}，但预检发现目标是 ${spec.preflight.arch} —— 架构不一致，拒绝继续`)
  }
  if (spec.target.kind === 'remote-ssh' && spec.preflight !== undefined && spec.preflight.cpuCores === 0) {
    warnings.push('远端的预检信息是空的 —— 建议先跑一次远端预检（我们不知道那台机器有多少内存）')
  }
  if (spec.backend === 'cpu') {
    warnings.push('使用 CPU 后端：0.5B Q4 在这个规模下约 40ms，同步评分路径会**经常触发 50ms 超时降级**，请依赖预评分路径（§2.13.4）')
  }

  const steps: DeployStep[] = []
  const container = containerNameOf(spec)
  const modelPath = `${spec.modelRoot}/${spec.model.id}-${spec.model.quantization}.gguf`
  const modelDir = spec.modelRoot

  if (spec.target.kind === 'external-api') {
    // 外部已有服务：只登记 + 探活，**不部署**（§2.13.3 表格第三行）
    steps.push({
      id: 'probe',
      title: '探活外部端点',
      kind: 'http-check',
      command: ['curl', '-sf', '-o', '/dev/null', '-w', '%{http_code}', `${spec.target.baseUrl.replace(/\/$/, '')}/models`],
      critical: true,
      httpCheck: { url: `${spec.target.baseUrl.replace(/\/$/, '')}/models`, expectStatus: 200, timeoutMs: 5_000 },
      note: 'external-api 目标只做注册与探活，不部署任何东西',
    })
    return { spec, steps, blockers, warnings }
  }

  // ① 准备模型目录（幂等）
  steps.push({
    id: 'prepare-dir',
    title: '准备模型根目录',
    kind: 'shell',
    command: wrap(spec, ['mkdir', '-p', modelDir]),
    critical: true,
    note: '幂等：目录已存在也不报错',
  })

  // ② 下载权重（可续传 + SHA 校验）
  steps.push({
    id: 'download-weights',
    title: `下载模型权重 ${spec.model.id} ${spec.model.quantization}`,
    kind: 'download',
    command: wrap(spec, ['curl', '-fL', '-C', '-', '-o', `${modelPath}.part`, spec.model.url]),
    // **刻意没有 rollback**：权重保留下来，下次可续（验收里明写的行为）
    critical: true,
    download: {
      url: spec.model.url,
      dest: modelPath,
      sha256: spec.model.sha256,
      ...(spec.model.sizeBytes === undefined ? {} : { sizeBytes: spec.model.sizeBytes }),
    },
    note: '断点续传 + SHA-256 校验；已下好且校验通过会直接跳过（幂等）',
  })

  // ③ 拉镜像
  steps.push({
    id: 'pull-image',
    title: '拉取运行时镜像',
    kind: 'shell',
    command: wrap(spec, ['docker', 'pull', backendPlan.image]),
    critical: true,
    note: `后端 ${spec.backend} ⇒ 镜像标签 ${backendPlan.imageTag}`,
  })

  // ④ 起容器（幂等：先删同名，再起）
  steps.push({
    id: 'remove-old',
    title: '移除同名容器（幂等）',
    kind: 'shell',
    command: wrap(spec, ['docker', 'rm', '-f', container]),
    critical: false,
    note: '不存在也不报错（`|| true` 语义由执行器处理非零退出）',
  })
  steps.push({
    id: 'run-container',
    title: '启动推理容器',
    kind: 'shell',
    command: wrap(spec, [
      'docker',
      'run',
      '-d',
      '--name',
      container,
      '--restart',
      spec.port > 0 ? 'unless-stopped' : 'no',
      '-p',
      `${String(spec.port)}:8080`,
      '-v',
      `${modelDir}:/models:ro`,
      ...backendPlan.deviceArgs,
      backendPlan.image,
      '-m',
      `/models/${spec.model.id}-${spec.model.quantization}.gguf`,
      '--host',
      '0.0.0.0',
      '--port',
      '8080',
    ]),
    critical: true,
    rollback: wrap(spec, ['docker', 'rm', '-f', container]),
    note: '**回滚会在远端也执行**（否则远端会留一个跑着的容器）',
  })

  // ⑤ 健康检查
  const healthUrl = healthUrlOf(spec)
  steps.push({
    id: 'health-check',
    title: '健康检查（等 /health 就绪）',
    kind: 'http-check',
    command: wrap(spec, ['curl', '-sf', '-o', '/dev/null', '-w', '%{http_code}', healthUrl]),
    critical: true,
    rollback: wrap(spec, ['docker', 'rm', '-f', container]),
    httpCheck: { url: healthUrl, expectStatus: 200, timeoutMs: 120_000 },
    note: '超时就回滚容器；就绪后要**记录实际生效的后端**（有些镜像会静默回落到 CPU）',
  })

  // ⑥ 预热（对应 T16：确保首个真实请求不慢）
  steps.push({
    id: 'warmup',
    title: '预热（典型样本跑几次）',
    kind: 'shell',
    command: wrap(spec, [
      'curl',
      '-sf',
      '-X',
      'POST',
      `${baseUrlOf(spec)}/chat/completions`,
      '-H',
      'content-type: application/json',
      '-d',
      '{"model":"local","messages":[{"role":"user","content":"你好"}],"max_tokens":4}',
    ]),
    critical: false,
    note: '预热失败不算致命（只是首次请求会慢），但会记进审计',
  })

  // ⑦ 注册进目录（由调用方写库；这里给出"要登记什么"）
  steps.push({
    id: 'register',
    title: '注册进端点目录',
    kind: 'shell',
    command: ['forlife-internal', 'register-endpoint', spec.endpointId],
    critical: true,
    note: '写 inference_endpoints 表（含来源、模式、后端、能力位）',
  })

  return { spec, steps, blockers, warnings }
}

/** 容器名。 */
function containerNameOf(spec: DeploySpec): string {
  switch (spec.target.kind) {
    case 'local-docker':
    case 'remote-ssh':
      return spec.target.containerName
    case 'external-api':
      return `external-${spec.endpointId}`
  }
}

/** 端点 baseUrl（本机/远端都以端口拼）。 */
function baseUrlOf(spec: DeploySpec): string {
  if (spec.target.kind === 'external-api') return spec.target.baseUrl.replace(/\/$/, '')
  if (spec.target.kind === 'remote-ssh') {
    const host = spec.target.host
    return `http://${host}:${String(spec.port)}/v1`
  }
  return `http://127.0.0.1:${String(spec.port)}/v1`
}

/** 健康检查地址（llama.cpp 的 /health 不在 /v1 下）。 */
function healthUrlOf(spec: DeploySpec): string {
  if (spec.target.kind === 'external-api') return `${spec.target.baseUrl.replace(/\/$/, '')}/health`
  const base = baseUrlOf(spec).replace(/\/v1$/, '')
  return `${base}/health`
}

/**
 * 把命令包成"在目标机上执行"的形式。
 *
 * 远端就是把命令包一层 ssh；**凭据不进命令**（用环境变量名占位）。
 */
function wrap(spec: DeploySpec, command: readonly string[]): readonly string[] {
  if (spec.target.kind !== 'remote-ssh') return command
  const target = spec.target
  const sshArgs = ['ssh', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new']
  if (target.port !== undefined) sshArgs.push('-p', String(target.port))
  sshArgs.push(target.user === undefined ? target.host : `${target.user}@${target.host}`)
  // 远端命令要作为一个参数传过去（否则本地 shell 会先解释它）
  sshArgs.push(command.map((part) => (part.includes(' ') ? `'${part}'` : part)).join(' '))
  return sshArgs
}

// ── 执行与回滚 ─────────────────────────────────────────────────────────────

/** 一步的执行结果。 */
export interface StepResult {
  readonly id: string
  readonly ok: boolean
  readonly skipped?: boolean
  readonly stdout?: string
  readonly stderr?: string
  readonly error?: string
  readonly durationMs: number
}

/** 执行器（注入：真机用 dockerd/ssh，测试用假的）。 */
export interface DeployExecutor {
  readonly exec: (command: readonly string[]) => Promise<{ ok: boolean; stdout?: string; stderr?: string }>
  readonly download: (input: DeployStep['download'] & object) => Promise<{ ok: boolean; error?: string; skipped?: boolean }>
  readonly checkHttp: (input: NonNullable<DeployStep['httpCheck']>) => Promise<{ ok: boolean; status?: number; error?: string }>
}

/** 部署结果。 */
export interface DeployResult {
  readonly ok: boolean
  readonly steps: readonly StepResult[]
  /** 是否被拦在预检阶段（没执行任何步骤）。 */
  readonly blocked: boolean
  readonly rolledBack: readonly string[]
  readonly rollbackFailures: readonly string[]
  readonly warnings: readonly string[]
  readonly error?: string
}

/** 远端护栏配置。 */
export interface RemoteGuard {
  /** 目标主机白名单（**必须在里面**）。 */
  readonly hostWhitelist: readonly string[]
  /** 是否要求显式确认（策略放行时可关）。 */
  readonly requireConfirmation: boolean
  /** 调用方给出的确认。 */
  readonly confirmed?: boolean
}

/** 检查远端护栏。 */
export function checkRemoteGuard(target: DeployTarget, guard: RemoteGuard): { readonly allowed: boolean; readonly reason?: string } {
  if (target.kind !== 'remote-ssh') return { allowed: true }
  if (!guard.hostWhitelist.includes(target.host)) {
    return {
      allowed: false,
      reason: `远端主机 ${target.host} 不在白名单里（白名单：${guard.hostWhitelist.join('、') || '空'}）—— 这是刻意的一道闸门，防止误把命令发到别的机器上`,
    }
  }
  if (guard.requireConfirmation && guard.confirmed !== true) {
    return { allowed: false, reason: `对 ${target.host} 的远端部署需要显式确认（先看 dry-run 的命令序列，确认无误再执行）` }
  }
  return { allowed: true }
}

/** 执行结果摘要。 */
function summarize(result: { ok: boolean; stdout?: string; stderr?: string }): { stdout?: string; stderr?: string; error?: string } {
  return {
    ...(result.stdout === undefined ? {} : { stdout: result.stdout.slice(0, 500) }),
    ...(result.stderr === undefined ? {} : { stderr: result.stderr.slice(0, 500) }),
    // 非零退出时关键信息在 stderr 里，所以把它也当 error 带上
    ...(result.ok ? {} : { error: (result.stderr ?? result.stdout ?? '命令失败').slice(0, 300) }),
  }
}

/**
 * 跑部署计划。
 *
 * @param plan - 计划（来自 `planDeploy`）。
 * @param options - 执行器、dry-run、远端护栏。
 * @returns 结果（含回滚情况）。
 */
export async function runDeploy(
  plan: DeployPlan,
  options: {
    readonly executor: DeployExecutor
    readonly dryRun?: boolean
    readonly guard?: RemoteGuard
    readonly now?: () => number
  },
): Promise<DeployResult> {
  const now = options.now ?? ((): number => Date.now())
  const warnings = [...plan.warnings]

  if (plan.blockers.length > 0) {
    // 预检就发现问题 ⇒ **一步都不执行**（这比"跑了三步再回滚"好得多）
    return { ok: false, steps: [], blocked: true, rolledBack: [], rollbackFailures: [], warnings, error: plan.blockers.join('；') satisfies string }
  }

  if (options.guard !== undefined) {
    const guard = checkRemoteGuard(plan.spec.target, options.guard)
    if (!guard.allowed) {
      return { ok: false, steps: [], blocked: true, rolledBack: [], rollbackFailures: [], warnings, ...(guard.reason === undefined ? {} : { error: guard.reason }) }
    }
  }

  if (options.dryRun === true) {
    // dry-run：把所有命令当作"已完成"返回，但**什么都不执行**
    return {
      ok: true,
      steps: plan.steps.map((step) => ({ id: step.id, ok: true, skipped: true, stdout: step.command.join(' '), durationMs: 0 })),
      blocked: false,
      rolledBack: [],
      rollbackFailures: [],
      warnings: [...warnings, 'dry-run：没有执行任何命令，以上是将会执行的命令序列'],
    }
  }

  const results: StepResult[] = []
  const completed: DeployStep[] = []

  for (const step of plan.steps) {
    const started = now()
    let result: StepResult
    try {
      if (step.kind === 'download' && step.download !== undefined) {
        const downloaded = await options.executor.download(step.download)
        result = {
          id: step.id,
          ok: downloaded.ok,
          ...(downloaded.skipped === true ? { skipped: true } : {}),
          ...(downloaded.error === undefined ? {} : { error: downloaded.error }),
          durationMs: now() - started,
        }
      } else if (step.kind === 'http-check' && step.httpCheck !== undefined) {
        const checked = await options.executor.checkHttp(step.httpCheck)
        result = {
          id: step.id,
          ok: checked.ok,
          ...(checked.status === undefined ? {} : { stdout: `HTTP ${String(checked.status)}` }),
          ...(checked.error === undefined ? {} : { error: checked.error }),
          durationMs: now() - started,
        }
      } else {
        const executed = await options.executor.exec(step.command)
        result = { id: step.id, ok: executed.ok, ...summarize(executed), durationMs: now() - started }
      }
    } catch (error) {
      result = { id: step.id, ok: false, error: String(error), durationMs: now() - started }
    }

    results.push(result)
    if (result.ok) completed.push(step)

    if (!result.ok) {
      if (!step.critical) {
        warnings.push(`非致命步骤失败（继续）：${step.title} —— ${result.error ?? '未知原因'}`)
        continue
      }
      // 致命失败 ⇒ 逆序回滚**已完成**的步骤（不是重来一遍）
      const { rolledBack, rollbackFailures } = await rollback(completed, options.executor)
      return {
        ok: false,
        steps: results,
        blocked: false,
        rolledBack,
        rollbackFailures,
        warnings,
        error: `步骤「${step.title}」失败：${result.error ?? '未知原因'}`,
      }
    }
  }

  return { ok: true, steps: results, blocked: false, rolledBack: [], rollbackFailures: [], warnings }
}

/** 逆序回滚已完成步骤。 */
async function rollback(
  completed: readonly DeployStep[],
  executor: DeployExecutor,
): Promise<{ readonly rolledBack: readonly string[]; readonly rollbackFailures: readonly string[] }> {
  const rolledBack: string[] = []
  const rollbackFailures: string[] = []
  for (const step of [...completed].reverse()) {
    if (step.rollback === undefined) continue
    try {
      const result = await executor.exec(step.rollback)
      if (result.ok) rolledBack.push(step.id)
      else rollbackFailures.push(`${step.id}：${(result.stderr ?? '回滚命令失败').slice(0, 120)}`)
    } catch (error) {
      rollbackFailures.push(`${step.id}：${String(error).slice(0, 120)}`)
    }
  }
  return { rolledBack, rollbackFailures }
}

/** 容器内模型的预估内存（选型用；独立出来便于面板显示）。 */
export function estimateContainerMemoryMb(spec: DeploySpec): number {
  const base = spec.model.sizeBytes === undefined ? 0 : spec.model.sizeBytes / 1024 / 1024
  // 运行时额外占用（KV 缓存等）按权重的 30% 估
  return Math.round(base * 1.3)
}

