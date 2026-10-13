/**
 * 端点抽象、加速后端多态与选型校验的测试。
 *
 * 这里有一条**刻意的重点**：五种后端里只有 cpu 在本机能跑，
 * 但另外四种的**参数生成必须正确** —— 那是"换机器就能用"的唯一保证。
 * 所以测试断言的是"生成的镜像标签与设备直通参数对不对"，
 * 而不是"本机能不能真的跑 CUDA"（后者在一个纯 CPU 机器上根本无从验证）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  ACCELERATOR_BACKENDS,
  ENDPOINT_TYPES,
  emptyDeviceProbe,
  planBackend,
  RUN_MODES,
  suggestBackend,
  suggestSizing,
  validateEndpoint,
  type DeviceProbe,
  type InferenceEndpoint,
} from '../src/endpoints.ts'

/** 一台"什么都没有"的机器（本项目的实际环境）。 */
const BARE = emptyDeviceProbe()

/** 一台有 NVIDIA 卡 + DRI 节点的机器。 */
const NVIDIA_BOX: DeviceProbe = { renderNodes: ['/dev/dri/renderD128'], nvidia: true, rocm: false, intel: false, vulkan: true }

/** 一台 AMD 机器但只有老核心（ROCm 不支持，只有 vulkan）。 */
const OLD_AMD_BOX: DeviceProbe = { renderNodes: ['/dev/dri/renderD128'], nvidia: false, rocm: false, intel: false, vulkan: true }

/** 一台 Intel 机器。 */
const INTEL_BOX: DeviceProbe = { renderNodes: ['/dev/dri/renderD128'], nvidia: false, rocm: false, intel: true, vulkan: true }

test('来源与模式：四种来源、四种运行模式都必须支持（一个都不能少）', () => {
  assert.deepEqual([...ENDPOINT_TYPES], ['local', 'remote-selfhost', 'cloud-api', 'host-native'])
  assert.deepEqual([...RUN_MODES], ['resident', 'on-demand', 'remote-api', 'host-native'])
  assert.deepEqual([...ACCELERATOR_BACKENDS], ['cpu', 'cuda', 'rocm', 'vulkan', 'sycl'])
})

test('后端参数：五种后端都产出正确的镜像标签（这是"换机器可用"的唯一保证）', () => {
  const expected: Record<string, string> = {
    cpu: ':server',
    cuda: ':server-cuda',
    rocm: ':server-rocm',
    vulkan: ':server-vulkan',
    sycl: ':server-intel',
  }
  for (const backend of ACCELERATOR_BACKENDS) {
    const plan = planBackend({ backend, arch: 'x64', devices: backend === 'cpu' ? BARE : NVIDIA_BOX })
    assert.equal(plan.imageTag, expected[backend], `${backend} 的镜像标签不对`)
    assert.ok(plan.image.includes('llama.cpp'), `${backend} 的镜像名应当指向 llama.cpp 仓库`)
  }
})

test('后端参数：设备直通参数逐后端正确（cuda 用 --gpus，rocm 要 kfd+dri，vulkan/sycl 走渲染节点）', () => {
  assert.deepEqual(planBackend({ backend: 'cpu', arch: 'x64', devices: BARE }).deviceArgs, [])
  assert.deepEqual(planBackend({ backend: 'cuda', arch: 'x64', devices: NVIDIA_BOX }).deviceArgs, ['--gpus', 'all'])
  assert.deepEqual(planBackend({ backend: 'rocm', arch: 'x64', devices: NVIDIA_BOX }).deviceArgs, ['--device', '/dev/kfd', '--device', '/dev/dri'])
  // 有具体渲染节点时逐个列出（更精确，避免把整目录都暴露进去）
  assert.deepEqual(planBackend({ backend: 'vulkan', arch: 'x64', devices: NVIDIA_BOX }).deviceArgs, ['--device', '/dev/dri/renderD128'])
  assert.deepEqual(planBackend({ backend: 'sycl', arch: 'x64', devices: INTEL_BOX }).deviceArgs, ['--device', '/dev/dri/renderD128'])
  // 没有探测到节点时退化为整目录
  assert.deepEqual(planBackend({ backend: 'vulkan', arch: 'x64', devices: BARE }).deviceArgs, ['--device', '/dev/dri'])
})

test('镜像源可配（国内镜像源）', () => {
  const plan = planBackend({ backend: 'cpu', arch: 'x64', devices: BARE, registryPrefix: 'docker.m.daocloud.io' })
  assert.match(plan.image, /^docker\.m\.daocloud\.io\//)
  assert.match(plan.image, /:server$/)
})

test('手动覆盖优先于探测（探测只是建议，不是唯一路径）', () => {
  const plan = planBackend({
    backend: 'vulkan',
    arch: 'x64',
    devices: NVIDIA_BOX,
    deviceOverride: ['--device', '/dev/dri/renderD129', '--group-add', 'render'],
  })
  assert.deepEqual(plan.deviceArgs, ['--device', '/dev/dri/renderD129', '--group-add', 'render'])
})

test('支持性判定：选 cuda 但没有 NVIDIA 设备 ⇒ 明确不可用并给出原因与提示', () => {
  const cuda = planBackend({ backend: 'cuda', arch: 'x64', devices: BARE })
  assert.equal(cuda.supported, false)
  assert.match(String(cuda.reason), /没有可用的 NVIDIA 设备/)
  assert.match(String(cuda.hint), /NVIDIA Container Toolkit/)
  assert.equal(planBackend({ backend: 'cpu', arch: 'x64', devices: BARE }).supported, true)
})

test('ROCm 的老核心坑要写进提示（R7 430 这类 GCN1 不被支持）', () => {
  const rocm = planBackend({ backend: 'rocm', arch: 'x64', devices: BARE })
  assert.equal(rocm.supported, false)
  assert.match(String(rocm.hint), /GCN 1\/2|不被 ROCm 支持|R7 430/)
  assert.match(String(rocm.hint), /vulkan|cpu/)
})

test('自动探测：优先级 cuda > rocm > sycl > vulkan > cpu，探测不到落回 cpu', () => {
  assert.equal(suggestBackend(NVIDIA_BOX).backend, 'cuda')
  assert.equal(suggestBackend(INTEL_BOX).backend, 'sycl')
  assert.equal(suggestBackend(OLD_AMD_BOX).backend, 'vulkan', 'AMD 老卡探测不到 ROCm ⇒ 建议 vulkan 而不是 rocm')
  const bare = suggestBackend(BARE)
  assert.equal(bare.backend, 'cpu')
  assert.match(bare.reason, /纯 CPU|没有探测到/)
})

test('选型建议：装不下的组合一律不出现（不允许部署装不下的组合）', () => {
  // 2GB 可用内存：7B 的任何量化都装不下
  const small = suggestSizing({ availableMemoryMb: 2048, backend: 'cpu' })
  assert.ok(small.length > 0, '至少 0.5B 要能装下')
  assert.ok(!small.some((item) => item.model.paramsB === 7), '7B 不该出现在 2GB 的建议里')
  assert.ok(small.some((item) => item.model.paramsB === 0.5))

  // 16GB 可用：7B Q4 能进（但留 20% 余量 ⇒ 预算 12.8GB）
  const big = suggestSizing({ availableMemoryMb: 16_384, backend: 'cpu' })
  assert.ok(big.some((item) => item.model.paramsB === 7))

  // 内存不够时给空列表而不是硬塞一个（调用方必须处理）
  assert.deepEqual(suggestSizing({ availableMemoryMb: 100, backend: 'cpu' }), [])
})

test('选型建议：要扣除其它常驻服务的内存，并留 20% 余量', () => {
  const withReserved = suggestSizing({ availableMemoryMb: 4096, backend: 'cpu', reservedMemoryMb: 3600 })
  // (4096-3600)*0.8 = 396MB ⇒ 只有 0.5B Q4（400MB）勉强…其实装不下
  assert.ok(withReserved.every((item) => item.estimatedMemoryMb <= 396.8), '必须扣除常驻内存并留余量')
})

test('选型建议：CPU 上超过 50ms 的组合要**明说会常触发超时降级**', () => {
  const advice = suggestSizing({ availableMemoryMb: 16_384, backend: 'cpu' })
  const slow = advice.find((item) => item.estimatedLatencyMs > 50)
  assert.ok(slow !== undefined)
  assert.match(String(slow.note), /超时降级/)
  assert.match(String(slow.note), /预评分/)
  // 加速后端下延迟折扣生效，不该再挂这条提示
  const fast = suggestSizing({ availableMemoryMb: 16_384, backend: 'vulkan' })
  assert.ok(fast.every((item) => item.note === undefined))
})

test('校验：视觉模型没声明 image ⇒ 保存即拒绝（不等运行期）', () => {
  const endpoint: InferenceEndpoint = {
    id: 'ep1',
    type: 'local',
    mode: 'resident',
    backend: 'cpu',
    baseUrl: 'http://localhost:8080/v1',
    models: [{ id: 'text-only', image: false, contextLength: 32_000 }],
  }
  const issues = validateEndpoint(endpoint, { devices: BARE, roles: { vision: 'text-only' } })
  const error = issues.find((item) => item.field === 'models.image')
  assert.ok(error !== undefined)
  assert.equal(error.severity, 'error')
  assert.match(error.message, /假描述/)

  // 声明了就没问题
  const ok = validateEndpoint(
    { ...endpoint, models: [{ id: 'vl-model', image: true, contextLength: 32_000 }] },
    { devices: BARE, roles: { vision: 'vl-model' } },
  )
  assert.equal(ok.filter((item) => item.field === 'models.image').length, 0)
})

test('校验：嵌入模型没给维度 ⇒ 保存即拒绝（维度不知道就没法建向量表）', () => {
  const endpoint: InferenceEndpoint = {
    id: 'ep2',
    type: 'remote-selfhost',
    mode: 'remote-api',
    backend: 'cpu',
    baseUrl: 'http://10.0.0.5:8080/v1',
    models: [{ id: 'bge-m3', image: false, contextLength: 8_000 }],
  }
  const issues = validateEndpoint(endpoint, { devices: BARE, roles: { embedding: 'bge-m3' } })
  const error = issues.find((item) => item.field === 'models.embeddingDimensions')
  assert.ok(error !== undefined)
  assert.equal(error.severity, 'error')

  const ok = validateEndpoint(
    { ...endpoint, models: [{ id: 'bge-m3', image: false, contextLength: 8_000, embeddingDimensions: 1024 }] },
    { devices: BARE, roles: { embedding: 'bge-m3' } },
  )
  assert.equal(ok.filter((item) => item.field === 'models.embeddingDimensions').length, 0)
})

test('校验：后端选了 cuda 但目标机没有 NVIDIA 设备 ⇒ 保存即报错（不等到启动）', () => {
  const endpoint: InferenceEndpoint = {
    id: 'ep3',
    type: 'local',
    mode: 'on-demand',
    backend: 'cuda',
    baseUrl: 'http://localhost:8080/v1',
    models: [],
  }
  const issues = validateEndpoint(endpoint, { devices: BARE })
  const error = issues.find((item) => item.field === 'backend' && item.severity === 'error')
  assert.ok(error !== undefined, '这是验收项：保存即报错，不等到启动时才发现')
  assert.match(error.message, /NVIDIA/)

  // 有 NVIDIA 设备就通过
  const ok = validateEndpoint(endpoint, { devices: NVIDIA_BOX })
  assert.equal(ok.filter((item) => item.severity === 'error').length, 0)
})

test('校验：模式与来源自相矛盾时给警告（不拦，但要说）', () => {
  const contradictory: InferenceEndpoint = {
    id: 'ep4',
    type: 'local',
    mode: 'remote-api',
    backend: 'cpu',
    baseUrl: 'http://localhost:8080/v1',
    models: [],
  }
  const issues = validateEndpoint(contradictory, { devices: BARE })
  assert.ok(issues.some((item) => item.field === 'mode' && item.severity === 'warning'))

  const nativeMismatch: InferenceEndpoint = { ...contradictory, type: 'cloud-api', mode: 'host-native' }
  assert.ok(validateEndpoint(nativeMismatch, { devices: BARE }).some((item) => item.field === 'mode'))
})

test('校验：baseUrl 为空是硬错误', () => {
  const endpoint: InferenceEndpoint = { id: 'ep5', type: 'local', mode: 'resident', backend: 'cpu', baseUrl: '  ', models: [] }
  assert.ok(validateEndpoint(endpoint, { devices: BARE }).some((item) => item.field === 'baseUrl' && item.severity === 'error'))
})
