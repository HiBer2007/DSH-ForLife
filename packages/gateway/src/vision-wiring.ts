/**
 * ★ P1-1 的**装配点**：按环境变量决定"要不要有视觉能力"，并把桥接真的造出来。
 *
 * ## 为什么单独一个文件（而不是让两个装配处各写一遍）
 *
 * 网关有**两条装配路径**：
 *  - 生产：`packages/gateway/src/runtime.ts`（独立容器，`server.ts` 拉起）；
 *  - 开发：`packages/dsh-component/src/gateway-plugin.ts`（挂在 DSH 进程里）。
 *
 * 两条都要"同样的环境变量 ⇒ 同样的行为"。各写一遍的结果一定是**漂移**
 * （本项目已经栽过：同一条链在两个地方装配，行为不一样）。
 *
 * ## 没配视觉模型时**不是"少个功能"，而是"看得见的占位符"**
 *
 * `visionConfigFromEnv()` 返回 undefined ⇒ 这里返回 `vision: undefined`，
 * 于是 `media-resolve` 会给每张图拼上
 * `[图片未能描述：没有可用的视觉模型（…）；附件 sha256:…]`。
 * 模型因此能说"我有张图看不清"，而不是以为对方发了个空白 —— 这是刻意的。
 *
 * @module @forlife/gateway/vision-wiring
 */
import type { DatabaseSync } from 'node:sqlite'

import { defaultFor } from '@forlife/contracts'

import type { ImageVisionPort } from './media-resolve.ts'
import { visionConfigFromEnv } from './sticker-vision.ts'
import { VisionBridge } from './vision-bridge.ts'
import { createAttachmentReader, createHttpVisionDescriber } from './vision-describer.ts'

/** 装配结果。 */
export interface VisionWiring {
  /** 造好的桥接（**没配视觉模型时为 undefined**）。 */
  readonly vision?: ImageVisionPort
  /** 人话说明（进启动日志：让"为什么图片看不出来"第一眼可见）。 */
  readonly note: string
}

/**
 * 按环境变量造一个视觉桥接。
 *
 * 环境变量沿用**表情视觉那一套**（`sticker-vision.ts` 的 `visionConfigFromEnv`）：
 * `FORLIFE_VISION_MODEL` / `FORLIFE_VISION_BASE_URL` / `FORLIFE_VISION_KEY`（或
 * `FORLIFE_OPENCODE_GO_KEY`）/ `FORLIFE_VISION_SESSION`。
 *
 * @param input - 数据库、附件目录、可选环境与日志。
 * @returns 桥接与说明。
 */
export function createVisionFromEnv(input: {
  readonly db: DatabaseSync
  readonly storageRoot: string
  readonly env?: NodeJS.ProcessEnv
  readonly log?: (message: string) => void
}): VisionWiring {
  const env = input.env ?? process.env
  const config = visionConfigFromEnv(env)
  if (config === undefined) {
    return {
      note:
        '视觉桥接**未启用**（没配 FORLIFE_VISION_MODEL / 视觉 key）⇒ 图片会以' +
        '「未能描述：没有可用的视觉模型」的占位符交给模型（看得见，不是空白）',
    }
  }
  const describer = createHttpVisionDescriber({
    endpoint: {
      model: config.model,
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      ...(config.sessionId === undefined ? {} : { sessionId: config.sessionId }),
    },
    read: createAttachmentReader(input.storageRoot),
    ...(input.log === undefined ? {} : { log: input.log }),
  })
  const bridge = new VisionBridge(
    { db: input.db },
    {
      describer,
      provider: 'http',
      model: config.model,
      // 用户要求"OCR 是提示不是结论"：重要字段要复核（基线可关）
      verifyImportantFields: defaultFor<boolean>('qq.image.verifyImportantFields'),
      ...(input.log === undefined ? {} : { log: input.log }),
    },
  )
  return {
    vision: { describe: (attachmentId) => bridge.describeImage(attachmentId) },
    note: `视觉桥接已启用（模型 ${config.model}，附件目录 ${input.storageRoot}）`,
  }
}
