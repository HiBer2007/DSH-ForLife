# 本机环境与工具故障判读（Windows + pwsh + DSH harness）

> 讲"看到什么现象该判成什么故障、怎么修"。不是现状快照 —— 现状看提交记录与运行中的进程。

## 一、沙箱 / 工具故障

### `pwsh` 任何命令都在启动阶段失败

```
Error: SetNamedSecurityInfoW failed (Win32 5): grantWrite(D:\DSH-ForLife)
```

- **根因**：沙箱在**启动阶段**要给工作区补一条写权限 ACL，而当前账户对该目录没有
  WRITE_DAC / 所有权 ⇒ `ERROR_ACCESS_DENIED`。命令根本没执行。
  **不是目录只读、也不是文件后端坏了** —— `read` / `write` / `edit` 同时都正常，这正是判据。
- **提权绕不过去**：`danger-full-access` 在 headless 下没有审批通道，返回
  `sandbox escalation ... requires approval, but no approval channel is available`，直接 **fail closed**。
- **修复（人工，需在能跑 pwsh 的环境里执行）**：
  1. `whoami` + `icacls D:\DSH-ForLife`：确认当前账户是不是 Owner、有没有 `(F)` / `(M)`；
  2. `icacls D:\DSH-ForLife /grant "%USERNAME%":(OI)(CI)F`；被拒先
     `takeown /f D:\DSH-ForLife /r /d y` 再授权；
  3. 工作区在 OneDrive / 受管盘上时，挪到普通本地 NTFS 目录；
  4. 都不行 → 以管理员身份运行 DSH。

### `glob` 30s 超时

- **根因**：工作区太大（`.runtime/go`、`research/*/node_modules` 等 vendored 树）。
- **判读**：**窄路径可用、全树超时**。所以"glob 全废"通常是误判 —— 用窄模式，或用 `read` / `grep` 代替。

### "修复没生效"怎么判

同一台机器上可能有多个宿主进程，各自加载不同构建。判断顺序是：
**先看那个进程有没有重启，再看源码** —— 源码快照不能证明运行态。
一个旧进程里的失败观察，不能推翻另一个新进程里的成功观察。

### 并发轮次的干扰

多个唤醒轮次可能同时执行、同时改同一份文件（编辑会报 `file changed since it was read`）。此时：

- 不要据任何一次源码快照下"已修 / 未修"的结论；
- 不要在并发状态下编辑同一文件（会互相覆盖）；
- 记流水式的共享文件（同一份文档被多轮追加）必然冲突 —— 结论应写进**单一归属**的文档，而不是逐次追加。

## 二、编辑与读取的坑（Windows + pwsh + Node）

1. **`.mjs` 里写 TS 类型标注** ⇒ SyntaxError（已重复踩到）。
2. **CRLF 陷阱**：文件是 CRLF 时，按 `\n` 拼的多行 `replace` 会**静默不匹配** ——
   连"回退验证"都会被骗出**假绿**。
3. **ASCII 双引号 / 反引号**写在 `"…"` 或 `` `…` `` 里会破坏整条命令行。
4. **回退验证要外科式**：把条件改成 `if (false)`，**不要删行** ——
   删多了会变成"编译失败"而不是"测试变红"，验证就失去意义。
5. **`splice` 改对象字面量后必须回读那一段**：漏删重复键会 TS1117，改坏文件会静默丢字段。
6. **`$pid` 是 pwsh 的只读自动变量**，不能赋值。
7. **`node` 的 `fetch` 拿不到 DSH 的 cookie**，`Invoke-WebRequest` 可以。
8. **读日志要用 .NET UTF-8**（PowerShell 默认读会乱码）：

   ```powershell
   $fs=[System.IO.File]::Open('D:\DSH-ForLife\.runtime\admin.log','Open','Read','ReadWrite')
   $sr=New-Object System.IO.StreamReader($fs,[System.Text.Encoding]::UTF8); $t=$sr.ReadToEnd(); $sr.Close(); $fs.Close()
   ```
