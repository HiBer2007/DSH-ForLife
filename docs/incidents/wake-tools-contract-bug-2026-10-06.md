# 唤醒工具与宿主的输出契约（不变量 + 校验方法）

> 这份不是某一时刻的快照 —— 快照会过期（见文末）。它写的是**不变量**和**怎么查**。

## 不变量

`execute` **只能返回规范化 JSON 值**，不能返回 `{ content, value }` 信封。
展示文本归 `output.render`（同 `packages/dsh-component/src/tools.ts` 顶部的三条硬规矩）。

违反时的报错长得像"环境神秘故障"，其实指向很明确：

```
tool "list_wakes" returned invalid output: missing required property "value.ok";
missing required property "value.rows"; "value.content" is not a declared property;
"value.value" is not a declared property
```

—— 出现 `value.content` / `value.value` 这两个"未声明的属性"，就是 execute 包了信封。
宿主把 `execute` 的返回**原样**拿去跟该工具自己的 `output.schema` 比，所以信封必挂。

## 为什么单元测试抓不到

`packages/dsh-component/test/wake-tools.test.ts` 用 `valueOf()` 助手断言，
信封被助手剥掉了，于是测试全绿、真机全红。

**建议补的回归测试**（一句话）：
对每个工具断言 `execute(样例参数)` 的返回值能被**它自己的 `output.schema`** 接住。
写上去之后，任何信封都会立刻变红。

## 查的时候注意（重要）

2026-10-06 深夜**有多个唤醒轮次在并发执行**，同一份 `wake-tools.ts` 会被同时编辑 ——
我实测同一文件先后两次 `read` 到的内容不同（一次 `list_wakes` 还是信封、几分钟后已改成裸值）。
因此：

- 不要根据任何一次源码快照下"已修/未修"的结论；
- 不要在这种并发状态下编辑同一个文件（编辑会撞 `file changed since it was read`，且可能互相覆盖）；
- 以**重启后真机调一次**为准：`list_wakes` 能出列表就是好的。

## 重启后

1. 逐个调 `schedule_wake` / `list_wakes` / `cancel_wake` / `wake_now`（只读的那两个先试）；
2. `list_wakes` 拿到那条**不带 prompt、约每 2 分钟触发**的空唤醒触发器 id → `cancel_wake` 掉它
   （它是这轮刷屏的源头）；
3. 补上上面那条契约测试。
