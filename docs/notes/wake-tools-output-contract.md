# 工具输出契约：`execute` 只返回规范化 JSON 值

> 这是**不变量**，不是某一时刻的快照。违反时的报错长得像"环境神秘故障"，其实指向很明确。

## 不变量

宿主把 `execute` 的返回值**原样**当作该工具 `output.schema` 所声明的那个值去校验。因此：

- `execute` **只能返回规范化 JSON 值**（如 `{ok, rows}` / `{ok, id, message}`）；
- **不得**返回 `{content, value}` 一类的展示信封；
- 给模型看的展示文本由 `output.render` 产出，与返回值分开。

依据：`packages/dsh-component/src/tools.ts` 顶部三条硬规矩；宿主侧类型注释
（`node_modules/@deepseek-ai/dsh-tools/lib/types/schema.d.ts`）对 `execute` 的说明是
"the canonical value declared by `output.schema`"。

## 现象：违反时的报错原文

```
tool "list_wakes" returned invalid output: missing required property "value.ok";
missing required property "value.rows"; "value.content" is not a declared property;
"value.value" is not a declared property
```

**判据**：报错里出现 `value.content` / `value.value` 这类**未声明的属性**，就是 `execute` 包了信封 ——
宿主把整个信封当成 `value`，于是 `value.ok` 缺失、`value.content` 多余。
不必先怀疑环境或工具本身，先看这两个属性名。

## 为什么单元测试抓不到

`packages/dsh-component/test/wake-tools.test.ts` 里的 `valueOf()` 助手原本会把信封剥一层，
于是"工具包了信封"这种写法在单测里全绿、真机全红。

## 怎么查

1. 读报错里的属性名（见上）。
2. 全仓扫旧写法：`grep "content: text(" packages/dsh-component/src` ⇒ 应为**零命中**。
3. 逐个工具断言"返回值能被它自己的 `output.schema` 接住"。
4. 确认跑的是新构建 —— 见下面「生效条件」。

## 回归测试（已落地）

`packages/dsh-component/test/wake-tools.test.ts` 对五个唤醒工具逐个断言：
`execute(...)` 的返回值里**没有** `content` / `value` 两个键、且必须带 `ok`（schema 必填项）。
`valueOf()` 已改成恒等（返回值本身就是 value）。

`list_wakes` 的 `output.schema` 另补了 `prompt` 字段：不带它，唤醒时就看不出"触发器当初要做什么"，
模型醒来只能干瞪眼。

同类错误在 `port-tools.ts` 也出现过（`list_ports` / `publish_port` / `unpublish_port` 一样返回信封），
已一并改回裸值。

## 生效条件（重要）

**源码改完 ≠ 生效**：运行中的宿主进程加载的是旧模块，必须重建 + 重启进程。
同一台机器上可以同时存在多个宿主进程，各自跑不同构建 ——
所以"修复有没有生效"要在**重启后新起的进程**里验证，既不能拿旧进程的观察当全局结论，
也不能只看源码。

## 复核方式

`list_wakes` 能正常返回列表（而不是 schema 校验错）即为生效。
