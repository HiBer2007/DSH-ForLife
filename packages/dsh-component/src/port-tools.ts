/**
 * 端口出口工具：`publish_port` / `unpublish_port` / `list_ports`（PLAN 阶段 7）。
 *
 * ## 为什么插件能自己造一个 PortService，而不必调网关的接口
 *
 * 端口出口的整套逻辑（`ports.ts` / `caddy.ts` / `port-service.ts`）**只依赖
 * `node:sqlite`、`node:crypto` 和 fetch** —— 没有 DSH 依赖（这点和压缩引擎不同）。
 * 所以插件可以直接构造自己的实例：两个进程写**同一个库**、配**同一个 Caddy**，
 * 结果是一致的。
 *
 * 反过来（让插件去调网关的 `/port-publish`）要解决"插件怎么拿到管理会话"这个问题，
 * 而那个会话是给**浏览器**用的 —— 硬套只会多出一层鉴权麻烦。
 *
 * ## 模型不能自己决定"批准"
 *
 * `approvedBy` 记的是**批准者**，工具侧一律写 `model`（不伪装成 admin）——
 * 这样审计里能一眼看出"这条是模型自己发的"。
 * PLAN 要求"人工批准（或策略显式放行）"，这里走的是**策略显式放行**那条路：
 * 白名单本身就是策略，而白名单外的一律拒绝（模型无法绕过）。
 *
 * ## 未配置时三个工具都不注册
 *
 * 注册了只会让模型调用一个**注定失败**的工具，而它会把这个失败当成
 * "我操作错了"，于是反复重试 —— 比没有这个工具更糟。
 *
 * @module forlife-memory/port-tools
 */
import type { ContentBlock } from '@deepseek-ai/dsh-llm'

import { createCaddyClient, createPortService, DEFAULT_PORT_WHITELIST } from '@forlife/gateway'

import type { MemoryRuntime } from './runtime.ts'
import type { DefineToolLike } from './tools.ts'

/** 工具名（测试与文档共用一份）。 */
export const PORT_TOOL_NAMES = ['publish_port', 'unpublish_port', 'list_ports'] as const

/** 把文本包成内容块。 */
function text(value: string): ContentBlock[] {
  return [{ type: 'text', text: value }]
}

/** 端口出口工具的可选配置。 */
export interface PortToolOptions {
  readonly caddyAdminUrl?: string | undefined
  readonly publicHost?: string | undefined
  readonly upstreamHost?: string | undefined
  readonly whitelist?: readonly { readonly from: number; readonly to: number }[] | undefined
}

/** 从环境变量读配置。 */
export function portToolOptionsFromEnv(env: Record<string, string | undefined>): PortToolOptions {
  const adminUrl = env['FORLIFE_CADDY_ADMIN']
  const host = env['FORLIFE_PUBLIC_HOST']
  const upstream = env['FORLIFE_UPSTREAM_HOST']
  return {
    ...(adminUrl === undefined || adminUrl === '' ? {} : { caddyAdminUrl: adminUrl }),
    ...(host === undefined || host === '' ? {} : { publicHost: host }),
    ...(upstream === undefined || upstream === '' ? {} : { upstreamHost: upstream }),
  }
}

/**
 * 构造端口出口工具。
 *
 * @param defineTool - 宿主的定义器。
 * @param runtime - 记忆运行时。
 * @param options - 配置；缺 Caddy 或主机名时返回空数组（功能禁用）。
 */
export function buildPortTools(
  defineTool: DefineToolLike,
  runtime: MemoryRuntime,
  options: PortToolOptions = {},
): readonly unknown[] {
  if (options.caddyAdminUrl === undefined || options.publicHost === undefined) return []

  const whitelist = options.whitelist ?? DEFAULT_PORT_WHITELIST
  const service = createPortService({
    db: runtime.db,
    caddy: createCaddyClient({ adminUrl: options.caddyAdminUrl }),
    host: options.publicHost,
    ...(options.upstreamHost === undefined ? {} : { upstreamHost: options.upstreamHost }),
  })

  const listTool = defineTool({
    name: 'list_ports',
    description: '列出当前已经发布出去的端口（哪些内部服务正暴露在公网地址上）。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          rows: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string', required: true },
                url: { type: 'string', required: true },
                targetPort: { type: 'number', required: true },
                expiresAt: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args: never, value: never): ContentBlock[] => {
        const v = value as { rows: readonly { name: string; url: string }[] }
        return text(
          v.rows.length === 0
            ? '当前没有任何已发布的端口。'
            : v.rows.map((r) => `${r.name} → ${r.url}`).join('\n'),
        )
      },
    },
    execute: async (args: never): Promise<unknown> => {
      void args
      runtime.recordToolCall()
      const rows = service.list().map((row) => ({
        name: row.name,
        url: service.urlFor(row),
        targetPort: row.target_port,
        // 空串表示"不过期"（schema 里 string 比 null 好处理，也更容易被模型读懂）
        expiresAt: row.expires_at ?? '',
      }))
      return {
        content: text(
          rows.length === 0
            ? '当前没有任何已发布的端口。'
            : rows.map((r) => `${r.name} → ${r.url}（目标 :${String(r.targetPort)}）`).join('\n'),
        ),
        value: { ok: true, rows },
      }
    },
  })

  const publishTool = defineTool({
    name: 'publish_port',
    description:
      '把工作区里的一个 HTTP 服务发布到公网地址 https://<host>/svc/<name>/，让别人能访问它。' +
      '**端口必须在白名单内**，否则会被拒绝。' +
      '强烈建议给 ttlSeconds：到期会自动回收；不过期的发布一旦忘掉，就是一条没人记得的公开地址。',
    parameters: {
      name: {
        type: 'string',
        required: true,
        description: '对外名字（会拼进 URL）。只能小写字母/数字/连字符，如 my-app。',
      },
      targetPort: { type: 'number', required: true, description: '工作区里那个服务监听的端口。' },
      ttlSeconds: {
        type: 'number',
        description: '多久后自动取消（秒）。建议填；不填表示一直开着。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          url: { type: 'string', required: true },
          message: { type: 'string', required: true },
        },
      },
      render: (_args: never, value: never): ContentBlock[] => {
        const v = value as { ok: boolean; url: string; message: string }
        return text(v.ok ? `已发布：${v.url}` : `发布失败：${v.message}`)
      },
    },
    execute: async (args: never): Promise<unknown> => {
      const input = args as Record<string, unknown>
      runtime.recordToolCall()
      const result = await service.publish({
        name: String(input['name'] ?? ''),
        targetPort: Number(input['targetPort']),
        ttlSeconds: input['ttlSeconds'] === undefined ? null : Number(input['ttlSeconds']),
        // **一律记 model**，不伪装成 admin —— 审计里要能一眼看出这是模型自己发的
        approvedBy: 'model',
      })
      if (!result.ok) {
        return { content: text(`发布失败：${result.reason}`), value: { ok: false, url: '', message: result.reason } }
      }
      const url = service.urlFor(result.row!)
      return { content: text(`已发布：${url}`), value: { ok: true, url, message: '已发布' } }
    },
  })

  const unpublishTool = defineTool({
    name: 'unpublish_port',
    description: '取消一条端口发布。**对外地址会立即 404** —— 如果别人还在用，先打个招呼。',
    parameters: {
      name: { type: 'string', required: true, description: '要取消的那个名字（list_ports 里有）。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          message: { type: 'string', required: true },
        },
      },
      render: (_args: never, value: never): ContentBlock[] => {
        const v = value as { ok: boolean; message: string }
        return text(v.ok ? '已取消发布（对外地址现在 404）。' : `取消失败：${v.message}`)
      },
    },
    execute: async (args: never): Promise<unknown> => {
      const input = args as Record<string, unknown>
      runtime.recordToolCall()
      const name = String(input['name'] ?? '')
      const row = service.list().find((r) => r.name === name)
      if (row === undefined) {
        return {
          content: text(`没有叫「${name}」的发布。用 list_ports 看看有哪些。`),
          value: { ok: false, message: '没有这条发布' },
        }
      }
      const result = await service.unpublish(row.id)
      return {
        content: text(result.ok ? `已取消：${name}` : `取消失败：${result.reason}`),
        value: { ok: result.ok, message: result.reason },
      }
    },
  })

  return [publishTool, unpublishTool, listTool]
}
