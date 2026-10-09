/**
 * 视觉桥接（**已搬到 `@forlife/gateway`**，这里只做再导出）。
 *
 * ## 为什么搬走
 *
 * 它原来在这里，但**全仓只被自己的测试引用**（"写好了零调用"的标本，
 * 见 `research/inbound-event-action-audit.md` §3.2）：图片描述真正该发生的时机是
 * "**入站事件刚到、还没交给模型**"，而那一步在**网关进程**里；
 * 而依赖方向是 dsh-component → gateway ⇒ 网关**不可能**反向 import 这里。
 *
 * ⇒ 搬进 `@forlife/gateway` 之后，生产与开发两条装配路径都能实例化它；
 * 这个文件保留同名再导出，**既有导入与测试一行都不用改**。
 *
 * @module forlife-memory/vision-bridge
 */
export {
  describeSourceMark,
  placeholderText,
  VisionBridge,
  type VisionBridgeHost,
  type VisionBridgeOptions,
  type VisionBridgeResult,
  type VisionDescriber,
} from '@forlife/gateway'
