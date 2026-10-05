/**
 * 模型供应子系统（EXECUTION_PLAN §2.13）—— 统一抽象、加速后端多态、选型与校验。
 *
 * ## 为什么要有"统一抽象"
 *
 * 上层（评分器 / 视觉桥接 / 子代理 / 压缩 / 嵌入）只依赖 `InferenceEndpoint`，
 * **不关心模型在哪、用什么硬件跑**。所以"换机器/换部署环境"不该影响上层任何一行代码 ——
 * 这是"可移植"这个硬约束在模型层的落点。
 *
 * ## 关于加速后端的一个诚实说明
 *
 * 本项目实际环境是 **纯 CPU**：GPU（AMD R7 430）挂在 PVE 上不直通任何 VM，
 * 且 R7 430 是 GCN 1 代 Oland 核心，**ROCm 不支持** ⇒ 对推理等于不可用。
 * 所以 cuda/rocm/vulkan/sycl 这四种后端的代码**在本机是"能生成正确参数但无从实测"**的
 * （验收里那条"`--dry-run` 对五种后端都能产出正确的镜像标签与设备直通参数"正是为此设计：
 * 可验证的是**参数生成的正确性**，而不是"本机真的能跑 CUDA"）。
 * 多后端能力是为"换机器/换部署环境"服务的，**不在本机假装可用**。
 *
 * @module @forlife/router/endpoints
 */

/** 端点来源（§2.13.2）。 */
export type EndpointType = 'local' | 'remote-selfhost' | 'cloud-api' | 'host-native'

/** 运行模式（一个都不能少，且可在运行时切换）。 */
export type RunMode = 'resident' | 'on-demand' | 'remote-api' | 'host-native'

/** 加速后端。 */
export type AcceleratorBackend = 'cpu' | 'cuda' | 'rocm' | 'vulkan' | 'sycl'

/** 全部来源。 */
export const ENDPOINT_TYPES: readonly EndpointType[] = ['local', 'remote-selfhost', 'cloud-api', 'host-native']

/** 全部运行模式。 */
export const RUN_MODES: readonly RunMode[] = ['resident', 'on-demand', 'remote-api', 'host-native']

/** 全部加速后端。 */
export const ACCELERATOR_BACKENDS: readonly AcceleratorBackend[] = ['cpu', 'cuda', 'rocm', 'vulkan', 'sycl']

/** 模型能力位。 */
export interface ModelCapability {
  readonly id: string
  /** 是否支持图片输入（**选为"视觉"的模型必须声明它**）。 */
  readonly image: boolean
  /** 上下文长度。 */
  readonly contextLength: number
  /** 推理强度合法集合（不含则视为"不支持推理强度"）。 */
  readonly reasoningEfforts?: readonly ('low' | 'medium' | 'high')[]
  /** 嵌入维度（**嵌入模型必须给**）。 */
  readonly embeddingDimensions?: number
}

/** 统一端点抽象（§2.13.2 末）。 */
export interface InferenceEndpoint {
  readonly id: string
  readonly type: EndpointType
  readonly mode: RunMode
  readonly backend: AcceleratorBackend
  readonly baseUrl: string
  /** 密钥的**引用**（不是密钥本身：凭据绝不入日志、不入库明文）。 */
  readonly apiKeyRef?: string
  readonly models: readonly ModelCapability[]
  readonly health?: EndpointHealth
  readonly limits?: EndpointLimits
}

/** 端点健康。 */
export interface EndpointHealth {
  readonly ok: boolean
  readonly checkedAt: string
  readonly latencyMs?: number
  readonly note?: string
  /** 实际生效的后端（**有些镜像会静默回落到 CPU**，所以要单独记）。 */
  readonly effectiveBackend?: AcceleratorBackend
}

/** 端点限额。 */
export interface EndpointLimits {
  readonly timeoutMs?: number
  readonly maxConcurrency?: number
  /** 成本提示（云模型用）。 */
  readonly costPerMillionTokens?: number
}

// ── 加速后端多态 ───────────────────────────────────────────────────────────

/** 主机架构。 */
export type Architecture = 'x64' | 'arm64'

/** 后端参数生成输入。 */
export interface BackendPlanInput {
  readonly backend: AcceleratorBackend
  readonly arch: Architecture
  /** 探测到的设备：`/dev/dri` 是否存在、是否有 NVIDIA 设备、是否有 ROCm 设备、是否有 Intel 设备。 */
  readonly devices: DeviceProbe
  /** 镜像源前缀（国内镜像源可配）。 */
  readonly registryPrefix?: string
  /** 手动覆盖的设备参数（探测只是建议，不是唯一路径）。 */
  readonly deviceOverride?: readonly string[]
}

/** 设备探测结果（启动时探测出来的信号）。 */
export interface DeviceProbe {
  /** `/dev/dri` 下的渲染节点（如 `['/dev/dri/renderD128']`）。 */
  readonly renderNodes: readonly string[]
  /** 是否有可用的 NVIDIA 设备（nvidia-smi 成功且有卡）。 */
  readonly nvidia: boolean
  /** 是否有可用的 ROCm 设备（rocm-smi/clinfo 成功；**GCN1 老核心不算**）。 */
  readonly rocm: boolean
  /** 是否有 Intel 设备（vainfo/clinfo 显示 Intel）。 */
  readonly intel: boolean
  /** vulkan 是否可用（vulkaninfo 成功）。 */
  readonly vulkan: boolean
}

/** 探测不到任何东西时的空结果。 */
export function emptyDeviceProbe(): DeviceProbe {
  return { renderNodes: [], nvidia: false, rocm: false, intel: false, vulkan: false }
}

/** 后端参数生成结果。 */
export interface BackendPlan {
  readonly backend: AcceleratorBackend
  /** 镜像标签（如 `:server-cuda`）。 */
  readonly imageTag: string
  /** 完整镜像名（含可配的镜像源前缀）。 */
  readonly image: string
  /** 设备直通参数（`--device` / `--gpus` 等）。 */
  readonly deviceArgs: readonly string[]
  /** 这个组合在当前探测结果下是否**真的**可用。 */
  readonly supported: boolean
  /** 不可用的原因（`supported=false` 时必有）。 */
  readonly reason?: string
  /** 给用户的提示（例如"本机无 NVIDIA 设备，选了也只会回落"）。 */
  readonly hint?: string
}

/** 各后端的镜像标签（llama.cpp 服务端变体）。 */
const IMAGE_TAGS: Readonly<Record<AcceleratorBackend, string>> = {
  cpu: ':server',
  cuda: ':server-cuda',
  rocm: ':server-rocm',
  vulkan: ':server-vulkan',
  sycl: ':server-intel',
}

/** 默认镜像仓库。 */
const DEFAULT_REPO = 'ghcr.io/ggml-org/llama.cpp'

/**
 * 按后端生成镜像与设备直通参数（§2.13.2 的"加速后端"表）。
 *
 * @param input - 后端、架构、探测结果与可选的镜像源/手动覆盖。
 * @returns 生成结果（含是否真的可用）。
 */
export function planBackend(input: BackendPlanInput): BackendPlan {
  const tag = IMAGE_TAGS[input.backend]
  const repo = (input.registryPrefix ?? '').replace(/\/$/, '')
  const image = `${repo === '' ? DEFAULT_REPO : `${repo}/${DEFAULT_REPO.split('/').slice(1).join('/')}`}${tag}`

  const override = input.deviceOverride
  const deviceArgs =
    override !== undefined && override.length > 0
      ? [...override]
      : defaultDeviceArgs(input.backend, input.devices)

  const { supported, reason, hint } = assessSupport(input.backend, input.devices)
  return {
    backend: input.backend,
    imageTag: tag,
    image,
    deviceArgs,
    supported,
    ...(reason === undefined ? {} : { reason }),
    ...(hint === undefined ? {} : { hint }),
  }
}

/** 各后端的默认设备直通参数。 */
function defaultDeviceArgs(backend: AcceleratorBackend, devices: DeviceProbe): readonly string[] {
  switch (backend) {
    case 'cpu':
      return []
    case 'cuda':
      // `--gpus all` 要求 NVIDIA Container Toolkit；用 all 而不是指定 id 更省心
      return ['--gpus', 'all']
    case 'rocm':
      // ROCm 需要 KFD（计算）与 DRI（显示/渲染）两组设备
      return ['--device', '/dev/kfd', '--device', '/dev/dri']
    case 'vulkan':
    case 'sycl':
      // 都是走 DRI 渲染节点；有具体节点时列出，没有则给整目录（让运行时自己找）
      return devices.renderNodes.length > 0
        ? devices.renderNodes.flatMap((node) => ['--device', node])
        : ['--device', '/dev/dri']
  }
}

/** 判定某后端在当前设备上是否真的可用。 */
function assessSupport(
  backend: AcceleratorBackend,
  devices: DeviceProbe,
): { readonly supported: boolean; readonly reason?: string; readonly hint?: string } {
  switch (backend) {
    case 'cpu':
      return { supported: true }
    case 'cuda':
      return devices.nvidia
        ? { supported: true }
        : {
            supported: false,
            reason: '目标机没有可用的 NVIDIA 设备（nvidia-smi 未探测到）',
            hint: 'cuda 后端需要 NVIDIA 设备 + NVIDIA Container Toolkit。选它会启动失败或静默回落到 CPU。',
          }
    case 'rocm':
      if (!devices.rocm) {
        return {
          supported: false,
          reason: '目标机没有 ROCm 支持的设备（rocm-smi/clinfo 未探测到）',
          hint:
            '注意：AMD 老核心（GCN 1/2 代，如 R7 430 这类 Oland）**不被 ROCm 支持**，' +
            '即使机器上有 AMD 显卡也不能选 rocm。这类机器建议用 vulkan 或 cpu。',
        }
      }
      return { supported: true }
    case 'vulkan':
      if (!devices.vulkan) {
        return {
          supported: false,
          reason: '目标机没有可用的 Vulkan 运行时（vulkaninfo 未通过）',
          hint: 'vulkan 是跨厂商的通用加速（AMD/Intel/NVIDIA 都吃），但需要装 vulkan 驱动 + ICD。',
        }
      }
      return { supported: true }
    case 'sycl':
      if (!devices.intel) {
        return {
          supported: false,
          reason: '目标机没有可用的 Intel 设备（vainfo/clinfo 未探测到）',
          hint: 'sycl（oneAPI）需要 Intel 核显/独显；非 Intel 平台请用 cpu 或 vulkan。',
        }
      }
      return { supported: true }
  }
}

/**
 * 从各种探测信号推断"建议用哪个后端"（§2.13.2 自动探测）。
 *
 * 优先级：cuda > rocm > sycl > vulkan > cpu。
 * **探测不到就落回 cpu** —— 宁可慢也不要"以为有加速、结果启动失败"。
 *
 * @param devices - 探测结果。
 * @returns 建议后端与理由。
 */
export function suggestBackend(devices: DeviceProbe): { readonly backend: AcceleratorBackend; readonly reason: string } {
  if (devices.nvidia) return { backend: 'cuda', reason: '探测到 NVIDIA 设备，cuda 是吞吐最高的选择' }
  if (devices.rocm) return { backend: 'rocm', reason: '探测到 ROCm 支持的设备' }
  if (devices.intel) return { backend: 'sycl', reason: '探测到 Intel 设备（oneAPI）' }
  if (devices.vulkan) return { backend: 'vulkan', reason: '探测到可用的 Vulkan 运行时，跨厂商通用加速' }
  return { backend: 'cpu', reason: '没有探测到可用加速器 ⇒ 落回 CPU（本项目实际环境就是纯 CPU）' }
}

// ── 选型建议（§2.13.3 第 2 步） ────────────────────────────────────────────

/** 量化档。 */
export type Quantization = 'Q4' | 'Q5' | 'Q8' | 'F16'

/** 候选模型规模。 */
export interface CandidateModel {
  readonly id: string
  /** 参数量（十亿）。 */
  readonly paramsB: number
  readonly quantization: Quantization
  /** 该组合的预估内存（MB）。 */
  readonly estimatedMemoryMb: number
  /** CPU 上的预估单次评分延迟（毫秒）。 */
  readonly estimatedLatencyMs: number
}

/** 候选表（0.5B/1.5B/7B × Q4/Q5/Q8）。 */
export function candidateModels(): readonly CandidateModel[] {
  return [
    { id: 'Qwen2.5-0.5B-Instruct', paramsB: 0.5, quantization: 'Q4', estimatedMemoryMb: 400, estimatedLatencyMs: 40 },
    { id: 'Qwen2.5-0.5B-Instruct', paramsB: 0.5, quantization: 'Q5', estimatedMemoryMb: 480, estimatedLatencyMs: 48 },
    { id: 'Qwen2.5-0.5B-Instruct', paramsB: 0.5, quantization: 'Q8', estimatedMemoryMb: 620, estimatedLatencyMs: 62 },
    { id: 'Qwen2.5-1.5B-Instruct', paramsB: 1.5, quantization: 'Q4', estimatedMemoryMb: 1100, estimatedLatencyMs: 110 },
    { id: 'Qwen2.5-1.5B-Instruct', paramsB: 1.5, quantization: 'Q5', estimatedMemoryMb: 1300, estimatedLatencyMs: 130 },
    { id: 'Qwen2.5-1.5B-Instruct', paramsB: 1.5, quantization: 'Q8', estimatedMemoryMb: 1900, estimatedLatencyMs: 190 },
    { id: 'Qwen2.5-7B-Instruct', paramsB: 7, quantization: 'Q4', estimatedMemoryMb: 4800, estimatedLatencyMs: 520 },
    { id: 'Qwen2.5-7B-Instruct', paramsB: 7, quantization: 'Q5', estimatedMemoryMb: 5600, estimatedLatencyMs: 600 },
    { id: 'Qwen2.5-7B-Instruct', paramsB: 7, quantization: 'Q8', estimatedMemoryMb: 8200, estimatedLatencyMs: 900 },
  ]
}

/** 选型建议一项。 */
export interface SizingAdvice {
  readonly model: CandidateModel
  readonly backend: AcceleratorBackend
  /** 预估内存占用（MB）。 */
  readonly estimatedMemoryMb: number
  /** 预估延迟（毫秒；CPU 与加速后端不同）。 */
  readonly estimatedLatencyMs: number
  readonly note?: string
}

/**
 * 按可用内存给出选型建议（**不允许部署装不下的组合**）。
 *
 * @param options - 可用内存、后端、是否常驻。
 * @returns 可部署的建议列表（按"推荐度"排序：够用且最快）。
 */
export function suggestSizing(options: {
  readonly availableMemoryMb: number
  readonly backend: AcceleratorBackend
  /** 其它常驻服务（如主模型）已占用的内存。 */
  readonly reservedMemoryMb?: number
}): readonly SizingAdvice[] {
  const reserved = options.reservedMemoryMb ?? 0
  // 留 20% 余量：把内存吃满会让宿主机开始换页，实际延迟反而更差
  const budget = Math.max(0, (options.availableMemoryMb - reserved) * 0.8)
  // 加速后端通常带宽更高、延迟更低；这里给一个保守的经验折扣
  const speedFactor = options.backend === 'cpu' ? 1 : 0.35

  return candidateModels()
    .filter((model) => model.estimatedMemoryMb <= budget)
    .map((model) => ({
      model,
      backend: options.backend,
      estimatedMemoryMb: model.estimatedMemoryMb,
      estimatedLatencyMs: Math.round(model.estimatedLatencyMs * speedFactor),
      ...(options.backend === 'cpu' && model.estimatedLatencyMs > 50
        ? { note: 'CPU 上预估超过 50ms ⇒ 同步路径会经常触发超时降级；请依赖预评分路径（§2.13.4）' }
        : {}),
    }))
    .sort((a, b) => a.model.estimatedLatencyMs - b.model.estimatedLatencyMs)
}

// ── 校验（§2.13.5 第 5 条） ────────────────────────────────────────────────

/** 校验结果。 */
export interface ValidationIssue {
  readonly field: string
  readonly message: string
  readonly severity: 'error' | 'warning'
}

/**
 * 保存端点前的校验（**不等到启动时才发现**）。
 *
 * @param endpoint - 端点定义。
 * @param context - 探测结果与角色分配。
 * @returns 问题列表（空 = 通过）。
 */
export function validateEndpoint(
  endpoint: InferenceEndpoint,
  context: { readonly devices: DeviceProbe; readonly roles?: Readonly<Record<string, string>> },
): readonly ValidationIssue[] {
  const issues: ValidationIssue[] = []

  if (endpoint.baseUrl.trim() === '') {
    issues.push({ field: 'baseUrl', message: 'baseUrl 不能为空', severity: 'error' })
  }

  // 视觉角色：必须声明 image 能力，否则运行期会拿假描述
  const visionRoleModel = Object.entries(context.roles ?? {}).find(([role]) => role === 'vision')?.[1]
  if (visionRoleModel !== undefined && endpoint.models.some((model) => model.id === visionRoleModel)) {
    const model = endpoint.models.find((item) => item.id === visionRoleModel)
    if (model?.image !== true) {
      issues.push({
        field: 'models.image',
        message: `模型 ${visionRoleModel} 被选为视觉角色，但没有声明 image 能力 —— 保存即拒绝（否则运行期会拿假描述）`,
        severity: 'error',
      })
    }
  }

  // 嵌入角色：必须给维度
  const embeddingRoleModel = Object.entries(context.roles ?? {}).find(([role]) => role === 'embedding')?.[1]
  if (embeddingRoleModel !== undefined && endpoint.models.some((model) => model.id === embeddingRoleModel)) {
    const model = endpoint.models.find((item) => item.id === embeddingRoleModel)
    if (model?.embeddingDimensions === undefined) {
      issues.push({
        field: 'models.embeddingDimensions',
        message: `模型 ${embeddingRoleModel} 被选为嵌入角色，但没有给维度 —— 保存即拒绝（维度不知道就没法建向量表）`,
        severity: 'error',
      })
    }
  }

  // 后端支持性：选了 cuda 但目标机没有 NVIDIA 设备 ⇒ 保存即报错
  const plan = planBackend({ backend: endpoint.backend, arch: 'x64', devices: context.devices })
  if (!plan.supported) {
    issues.push({
      field: 'backend',
      message: `${plan.reason ?? '后端不可用'}（后端 ${endpoint.backend}）`,
      severity: 'error',
    })
    if (plan.hint !== undefined) issues.push({ field: 'backend.hint', message: plan.hint, severity: 'warning' })
  }

  // 模式与来源的一致性：remote-api 模式配 local 来源是自相矛盾的
  if (endpoint.mode === 'remote-api' && endpoint.type === 'local') {
    issues.push({
      field: 'mode',
      message: '模式是 remote-api 但来源是 local —— 一个本地容器不该是"不本地部署、直接调远端"',
      severity: 'warning',
    })
  }
  if (endpoint.mode === 'host-native' && endpoint.type !== 'host-native') {
    issues.push({
      field: 'mode',
      message: '模式是 host-native（只读引用宿主配置）但来源不是 host-native',
      severity: 'warning',
    })
  }

  return issues
}
// ── 真实探测（宿主信号） ────────────────────────────────────────────────────

/** 探测用的环境端口（注入：测试不碰真机器）。 */
export interface ProbePort {
  readonly platform: string
  /** 路径是否存在（`/dev/dri` 这类渲染节点）。 */
  readonly exists: (path: string) => boolean
  /** 列出目录（找 `/dev/dri/renderD*`）。 */
  readonly listDir: (path: string) => readonly string[]
  /** 跑一个探测命令（nvidia-smi / rocm-smi / vulkaninfo / clinfo）。 */
  readonly run: (command: string, args: readonly string[]) => { readonly ok: boolean; readonly stdout: string }
}

/**
 * 探测宿主的加速能力（§2.13.2 自动探测）。
 *
 * **保守**：探测不到就返回空结果（= 建议 cpu），绝不猜。
 * 每次调用都会真的跑那几个命令，所以调用方要**缓存结果**
 * （nvidia-smi 之类要几十到几百毫秒，不该在每轮对话里跑）。
 *
 * @param port - 环境端口。
 * @returns 探测结果。
 */
export function probeDevices(port: ProbePort): DeviceProbe {
  // 渲染节点只在类 Unix 上有；Windows 下没有 /dev/dri
  const renderNodes: string[] = []
  if (port.platform !== 'win32' && port.exists('/dev/dri')) {
    for (const name of port.listDir('/dev/dri')) {
      if (name.startsWith('renderD')) renderNodes.push(`/dev/dri/${name}`)
    }
    if (renderNodes.length === 0) renderNodes.push('/dev/dri')
  }

  // NVIDIA：nvidia-smi -L 列出卡；有输出才算有设备
  const nvidia = safeProbe(port, 'nvidia-smi', ['-L'], /GPU \d+/)
  // ROCm：rocm-smi 能跑通且列出卡。注意 GCN1 老核心（R7 430 这类）**不被 ROCm 支持**，
  // 但 rocm-smi 有时仍能跑 —— 所以这里只看"有没有设备"，是否受支持由用户/文档判断
  const rocm = safeProbe(port, 'rocm-smi', ['--showproductname'], /Card series|GPU\[/)
  // Intel：clinfo 里出现 Intel
  const intel = safeProbe(port, 'clinfo', [], /Intel/i)
  // Vulkan：vulkaninfo 能跑通（跨厂商，最省心的通用加速）
  const vulkan = safeProbe(port, 'vulkaninfo', ['--summary'], /GPU id|deviceName/i)

  return { renderNodes, nvidia, rocm, intel, vulkan }
}

/** 跑一个探测命令并匹配输出（失败/超时/没输出都算"没探测到"）。 */
function safeProbe(port: ProbePort, command: string, args: readonly string[], pattern: RegExp): boolean {
  try {
    const result = port.run(command, args)
    return result.ok && pattern.test(result.stdout)
  } catch {
    return false
  }
}
