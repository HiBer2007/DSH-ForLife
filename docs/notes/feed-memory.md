# 手动喂食记忆资料（feed）—— 实现说明与交付报告

> 需求原话（2026-10-07，用户）：
> 「需要支持手动向AI喂食记忆资料，稍后我将喂食一些资料进入。」
> 澄清时补了四条入口与一条**关键纠正**：
> 「**两者都要，导入时用参数选（`--as knowledge` / `--as experience`）**」
> 「**并且全部需要走真实的沉降路径**」
> 「做完整版（分块、去重、增量更新、来源追踪、删除/重导）」
> 「**这些功能更多应该由模型自己决定，而强行删除本身依附于长期记忆/中期记忆的管理
> 而不需要再有召回的代码。尤其是分块和去重这本就是属于记忆系统的一部分**」

一句话：**四条入口（文件扫描 / 命令行文本 / HTTP / 后台页面）+ 一个模型工具，全部调用同一个
`feedMemory()`；它只做最朴素的段落切分，写入走既有的长期/中期记忆路径，查重复用既有检索，
删除指向既有的记忆管理。**

---

## 1. 四条入口怎么用（可直接复制）

### 1.1 入口 ①：文件 / 目录扫描（CLI）

```powershell
# 一个文件（来源默认 = 相对当前目录的路径，正斜杠）
node scripts/feed-memory.ts docs\notes\env-troubleshooting.md

# 一个目录（**递归**，只认 .md / .txt；跳过 node_modules/.git/.runtime/dist）
node scripts/feed-memory.ts docs

# 记成经历（中期记忆）而不是知识（长期记忆）
node scripts/feed-memory.ts docs --as experience

# 只看会发生什么，一个字都不写
node scripts/feed-memory.ts docs --dry-run --verbose

# 指定数据库（默认 FORLIFE_DB → DSH_HOME 推导 → 仓库内 .runtime/dsh/…）
node scripts/feed-memory.ts docs --db .runtime\dsh\forlife\db\forlife.sqlite
```

输出（真实输出，2026-10-07 扫 `docs/notes`）：

```
库：D:\DSH-ForLife\.runtime\cli-verify.sqlite
✓ docs/notes/dsh-headless-task-contract.md → 新增 17 / 1102 token（来源 docs/notes/dsh-headless-task-contract.md）
✓ docs/notes/dsh-provider-config.md → 新增 14 / 935 token（来源 docs/notes/dsh-provider-config.md）
✓ docs/notes/env-troubleshooting.md → 新增 16 / 976 token（来源 docs/notes/env-troubleshooting.md）
✓ docs/notes/wake-tools-output-contract.md → 新增 20 / 判重跳过 1 / 845 token（来源 docs/notes/wake-tools-output-contract.md）
完成。要删除：后台「记忆条目」页按来源（feed:…）过滤后归档，或用既有的 POST /api/admin/memory-archive —— 归档不是真删，可恢复。
```

同一条命令**再跑一遍**是幂等的（同源重导 = 更新/未改动，不会喂大库）：

```
✓ docs/notes/dsh-headless-task-contract.md → 新增 0 / 未改动 17 / 1102 token（来源 docs/notes/dsh-headless-task-contract.md）
```

退出码：全成功 `0`；有失败项 `1`（路径不存在、目录里没有资料、某批被拒……）。

### 1.2 入口 ②：命令行直接传文本

```powershell
node scripts/feed-memory.ts --text "WAL 模式下多个进程可以共享同一个库文件。" --as knowledge --source cli/note-1
node scripts/feed-memory.ts --text "今天把喂食入口接上了。" --as experience
node scripts/feed-memory.ts --text "……" --dry-run          # 预演
```

### 1.3 入口 ③：HTTP

**面板侧**（DSH Web UI 的插件接口；Host/Origin 栅栏由宿主提供，不经 Caddy 暴露）：

```bash
curl -X POST http://127.0.0.1:<DSH端口>/api/forlife/feed \
  -H 'content-type: application/json' \
  -d '{"items":[{"content":"第一段…"},{"content":"第二段…"}],"as":"knowledge","source":"api/note-1"}'
```

**后台侧**（gateway 主后台，要管理口令会话；与其它写接口同一条 CSRF 纵深防御）：

```bash
# 1) 登录拿 cookie
curl -c cookies.txt -X POST http://127.0.0.1:8081/api/admin/login \
  -H 'content-type: application/json' -d '{"password":"<管理口令>"}'

# 2) 喂食（dryRun=true 只算不写）
curl -b cookies.txt -X POST http://127.0.0.1:8081/api/admin/feed \
  -H 'content-type: application/json' \
  -d '{"items":[{"content":"第一段…"}],"as":"experience","source":"api/exp-1","dryRun":false}'
```

响应（两个入口同形）：

```json
{
  "ok": true,
  "result": {
    "ok": true, "as": "knowledge", "source": "api/note-1", "scope": "feed:api/note-1",
    "dryRun": false, "chunkCount": 1, "inserted": 1, "updated": 0, "unchanged": 0,
    "duplicates": 0, "archived": 0, "tokens": 31,
    "details": [{ "index": 0, "id": "feed_3f9a1c2b04_0", "action": "inserted",
                  "reason": "新增到长期记忆（FTS + 沉降自动生效）", "tokenCount": 31 }],
    "hint": "删除不用专门的接口：到后台「记忆条目」页按来源（feed:…）过滤后归档，或用既有的 POST /api/admin/memory-archive（restore=true 可恢复）。归档不是真删 —— 记忆是不可再生数据，且它引用过的中期条目不会断链。"
  }
}
```

错误一律 `400 { "error": "…" }`（未登录 `401`）——**不是 500**：抛异常会变成"服务器内部错误"，
用户看不出是自己传错了还是系统坏了。

**为什么 HTTP 有两条**：两个入口分别挂在两个进程上（DSH Web UI 面板接口 / gateway 主后台），
各有各的鉴权；而 DSH 官方 Web UI **按设计不经 Caddy 暴露**（`deploy/Caddyfile` 第 9–10 条、
`tests/portability.test.ts` 也在守这条）⇒ 后台页面够不着 `/api/forlife/*`。
两条路径调的是**同一个函数、同一张表**，不是两条管道（守卫见 `tests/feed-entries-wiring.test.ts`）。

### 1.4 入口 ④：管理后台页面

打开 `http://<host>/admin/#/feed`（侧栏「记忆 → 喂食记忆」）：

- 粘贴资料 → 选「知识（长期）」或「经历（中期）」→ 填来源（可空）→ **先「预览（不写入）」**再「喂食」；
- 结果面板给出 新增 / 更新 / 判重跳过 / 归档 四个数字与**逐段明细**（含判重撞上了哪一条、相似度多少）；
- 页面明确写出：删除要去「记忆条目」页按 `feed:…` 过滤后归档；
- 页面实时显示字节数（接口请求体上限 64 KB，更大的资料请走 CLI）。

### 1.5 额外的第五条：模型工具 `feed_memory`

模型可以自己决定"这段东西记成知识还是经历"：

```json
{ "as": "knowledge", "content": "……", "summary": "可选", "source": "可选", "entities": ["可选"] }
```

批量：`{"as":"experience","items":[{"content":"…"},{"content":"…"}]}`。
注册走 `index.ts` 的 `registerOne()`（**不是**直接 `tools.register`），否则生产日志里的工具数会说谎。

---

## 2. 核心函数与复用的既有代码

```ts
// packages/gateway/src/feed.ts
export function feedMemory(db: DatabaseSync, options: FeedOptions): FeedResult

interface FeedOptions {
  items: readonly FeedItem[]          // { content, summary?, entities? }
  as: 'knowledge' | 'experience'
  source?: string                     // 不填 ⇒ 按内容派生（见 §4）
  dryRun?: boolean
}
```

| 需求 | 复用了什么（**没有另写一套**） |
| :--- | :--- |
| 知识写入（长期记忆） | `store.insertLongEntry` —— 同事务写 FTS（`segmentForFts` 中文切分）；自动获得 HDD 沉降（`settleLongEntries`）、归档/恢复、面板编辑 |
| 经历写入（中期记忆） | `store.appendMidEntry` —— 同事务递增渲染修订号（进 L3 窗口）；自动获得压缩、碎片化与淘汰 |
| 同源重导（更新） | `admin/memory-write.updateLongMemory`（内部就是同 id 再写一次） |
| 重导变短（删多出的段落） | `admin/memory-write.archiveLongMemory`（**归档不是真删**，可 `restoreLongMemory` 恢复） |
| 去重候选 | `store.searchLongFts` / `store.searchMidFts` |
| 去重的近似判据 | `memory-core.textSimilarity`（**与 recall 重复查询同一份实现**；本轮把它从 `dsh-component/runtime.ts` 下沉到 memory-core，`runtime.ts` 仍以 `querySimilarity` 转出，老测试与调用点未改） |
| 来源查询 | `store.listLongEntriesByScope`（新增的**只读**仓储函数，SQL 仍只住在 `repository.ts`） |
| 阈值 | `defaultFor('feed.*')`（5 个新 design 参数，见 `plan-baseline.json` / EXECUTION_PLAN §2.19） |

数据模型（**没有新表、没有新字段、没有新迁移**）：

- 来源记在**既有列** `source_scope` 上：`feed:<来源>`（QQ 侧是 `group:…`/`private:…`，两个命名空间不重叠）；
- 条目 id 由「来源 + 段落序号」稳定派生：`feed_<sha1(来源) 前 10 位>_<段号>`；
  规模：长期条目按此 id 落库 ⇒ 重导落在同一行上（**不是**内容指纹索引）；
- 中期条目同源同段内容变了 ⇒ 以 `<基础 id>_<内容短哈希>` 追加**新版本**（中期记忆只追加，没有 update 原语）。

---

## 3. 为什么**没有**实现分块 / 去重 / 删除的"平行机制"

用户的原话就是设计依据，逐条落到代码：

| 用户原话 | 代码里的落点 |
| :--- | :--- |
| 「尤其是分块和去重这本就是属于记忆系统的一部分」 | `splitIntoFeedChunks()` 只按**空行 / 标题行**断开（人写 Markdown 的自然段落）；**没有**定长滑窗、没有按 token 预算切、没有重叠窗口。哪条记忆该碎、碎片留多长由 PLAN §5.3 那套（`fragment.maxHintTokens`、碎片区占比）负责；过长段落作为一整条进中期记忆，超出预算的部分由既有压缩流程处理 |
| 同上（去重） | 候选来自既有 FTS 检索，判据是与 recall **同一份** `textSimilarity()`；**没有** sha256 内容指纹表、**没有**第二张索引 —— 那张表里的"重复"跟检索看到的东西没有任何关系 |
| 「强行删除本身依附于长期记忆/中期记忆的管理」 | **没有**删除接口、**没有**删除参数。删除 = 面板「记忆条目」按 `feed:…` 过滤后归档，或 `POST /api/admin/memory-archive`；重导变短时多出的段落交给 `archiveLongMemory` |
| 「而不需要再有召回的代码」 | 喂食链路里**没有**任何新的 recall 代码：检索仍只经 `searchLongFts`/`searchMidFts`，喂进来的条目和聊天记忆在 recall 里完全同权 |
| 「更多应该由模型自己决定」 | `feed_memory` 工具（知识/经历由模型选），注册进工具表并计入生产日志 |

守卫（红了就说明有人开始造平行机制）：

- `tests/feed-entries-wiring.test.ts`
  ① 四条入口都必须调 `feedMemory`；② 四条入口里**不许**出现 `insertLongEntry(`/`appendMidEntry(`/
  `searchLongFts(`/`searchMidFts(`；③ 两条 HTTP 路径就是 `/api/forlife/feed` 与 `/api/admin/feed`；
  ④ 入口里不许出现新删除接口，核心必须指向既有的 `memory-archive`；⑤ 核心必须从基线读参数
  （`feed.ts` 里**不许出现写死的 `0.9`**）。
- `packages/gateway/test/feed.test.ts` 的源码守卫：`feed.ts` 里不许出现 `create table` / `delete from` /
  `drop index` / `sha256`（**先去掉注释再扫** —— 模块头里那句"没有 sha256 索引表"是在说"不要这么干"）。

---

## 4. 已知边界与取舍（写在明处，不假装没有）

1. **查重的探针是正文前缀**（`feed.probeChars` = 24 码元）。FTS 短语是**相邻 token 序列**的精确匹配
   （索引与查询两侧都过 unicode61 分词，**标点不参与** —— `50%`/`50 %`/`50%` 都能命中），
   但**多一个词或少一个词**（例如第 6 个字后插了一个"的"）整条短语就匹配不上。
   代价：**改动落在前缀之内**会判不出重复 —— 与 recall 侧同一取舍：**宁漏不误杀**
   （误杀会让用户以为"喂进去了"，其实一个字都没多）。
   该边界有专门用例：`喂知识：抓不到的边界要诚实（改动落在查重前缀之内 ⇒ 判不出重复）`。
2. **同源重导按"段落序号"对齐**：在文档**头部插入**一段会让后面所有段落整体错位重写。
   做真正的 diff 对齐需要给每段算内容指纹并维护映射表 —— 那正是本设计刻意不引入的第二套索引。
3. **中期记忆只追加**：既有系统里没有 update 原语（改一条会动 `window_offset` 与渲染修订号，
   进而破坏 PLAN §10.2 的缓存契约）。所以"同一段内容变了"= 追加新版本，老条目留在库里由既有
   压缩/碎片维护决定去留；同一份改动重复喂则判为"已喂过"。
4. **已沉降（HDD）的条目不被重导拉回热层**：冷热是既有沉降策略的决定；要取回正文请走既有的恢复路径。
   结果里会如实说明"这一段已沉降、没动它"。
5. **单次上限 200 段**（`feed.maxItemsPerCall`）。**同源分批会破坏段落序号对齐**，所以超限时的出路只有
   "拆成不同来源的批次"或"调高该基线参数"——错误信息里就是这么写的。
6. **两条 HTTP 入口的请求体上限不同**：后台侧沿用既有的 64 KB（`MAX_BYTES` 是全后台共用的一道闸，
   不为喂食单独放宽）；面板侧由宿主处理。大资料请走 CLI（无请求体限制，且能递归扫目录）。
7. 缺省来源按**内容**派生（`knowledge:3f9a1c2b` 这种形状），而不是一个常量：
   若缺省来源是常量，"没填来源地喂 A"之后再"没填来源地喂 B"会被当成同一份文档的第 0 段**更新**掉 ——
   那是静默的数据丢失。想让人名可读、想按文件重导，就显式给 `source`。

---

## 5. 测试与 typecheck 的实际输出（以 `pnpm typecheck` + `node --test` 为准）

**改动前（基线，工作区当时的状态）**

| 检查 | 结果 |
| :--- | :--- |
| `pnpm typecheck` | exit 0 |
| `store` | tests 187 / pass 187 / fail 0 |
| `dsh-component` | tests 368 / pass 363 / **fail 5** |
| `gateway` | tests 447 / pass 447 / fail 0 |
| `contracts` | tests 18 / pass 18 / fail 0 |
| `memory-core` | tests 100 / pass 100 / fail 0 |
| `router` | tests 143 / pass 143 / fail 0 |
| 全量 `packages/**/test/*.test.ts` + `tests/*.test.ts` | tests 1282 / pass 1275 / **fail 7** |

**改动后**

| 检查 | 结果 |
| :--- | :--- |
| `pnpm typecheck` | exit 0 |
| `packages/admin-ui` 的 `vue-tsc --noEmit` | exit 0 |
| `store` | tests 195 / pass 195 / fail 0 |
| `dsh-component` | tests 375 / pass 370 / **fail 5**（与基线同一批，见下） |
| `gateway` | tests 474 / pass 474 / fail 0 |
| `contracts` | tests 18 / pass 18 / fail 0 |
| `memory-core` | tests 105 / pass 105 / fail 0 |
| `router` | tests 143 / pass 143 / fail 0 |
| 全量 | tests 1343 / pass 1336 / **fail 7**（与基线同一批） |

**那 7 个失败是既有问题，与本次改动无关**（基线跑出来就是这 7 个）：

- 5 × `packages/dsh-component/test/panel-render.test.ts`：全量/包内一起跑时红，**单独跑该文件 5/5 全绿**
  ⇒ 进程内互相干扰的既有问题（file/order-dependent），不是断言本身错。
- 1 × `tests/portability.test.ts`「profile 配置里没有宿主绝对路径」：`profiles/forlife/cordis.patch.yml:69`
  的 `baseURL: https://…` 被正则 `[A-Za-z]:[\\/]` 匹配到（`s://`）——**误报**。
- 1 × `tests/portability.test.ts`「compose 与 Caddyfile 不含被禁配置」：`deploy/docker-compose.yml:208`
  有 `profiles: [scorer]`。

三处都早于本次改动（改动前的 `git status` 就是这样），本次**未触碰**它们 ——
避免与工作区里其它在途改动冲突。

新增测试文件：`packages/gateway/test/feed.test.ts`（20）、`packages/gateway/test/admin-feed-route.test.ts`（7）、
`packages/dsh-component/test/feed-tools-wiring.test.ts`（7）、`packages/store/test/repository-scope.test.ts`（2）、
`packages/store/test/fts-query.test.ts`（6，见 §8）、`packages/memory-core/test/similarity.test.ts`（5）、
`tests/feed-cli.test.ts`（8）、`tests/feed-entries-wiring.test.ts`（6）。

---

## 6. 回退验证（注入缺陷 ⇒ 必须变红；还原 ⇒ 变绿）

注入器只放在 `.runtime/`（不进仓库源码），每次注入后跑相关用例，随后按备份还原并比对文件哈希。

| # | 注入的缺陷 | 红掉的用例数 | 红掉的用例（节选） | 还原后 |
| :-- | :--- | :--- | :--- | :--- |
| 1 | 知识写入改成裸 SQL 直插 `long_memory_entries`（绕开 `insertLongEntry` ⇒ FTS 不同步 = 旁路管道） | tests 26 / pass 23 / **fail 3** | 喂知识：…且能被中文 FTS 检索到；喂知识：与别的来源…被跳过；★★ 四条入口都不直接碰写入原语 | tests 26 / pass 26 / fail 0（哈希一致） |
| 2 | 长期条目 id 与内容挂钩（同源重导变成"又插一份"） | tests 26 / pass 22 / **fail 4** | 同源重导**更新**已有条目…；同一个 source 就是同一份东西…；已沉降到冷层的条目… | tests 26 / pass 26 / fail 0（哈希一致） |
| 3 | 查重阈值写死成 `1.1`（不再读基线 `feed.dedupeSimilarity`） | tests 26 / pass 23 / **fail 3** | 喂知识：与别的来源…被跳过；喂经历：与既有中期记忆…被跳过；★ 核心从**基线**读参数 | tests 26 / pass 26 / fail 0（哈希一致） |
| 4 | `dry-run` 被忽略（预演也真写库）—— 同时跑**四个入口**的用例 | tests 48 / pass 45 / **fail 3** | ★ dryRun：一个字都不写（后台接口）；dry-run：一段都不落库（核心）；★ --dry-run：一个字都不写（CLI） | tests 48 / pass 48 / fail 0（哈希一致） |
| 5 | `ftsQuery` 的拉丁分支不清标点（回退成"文件名模样的查询直接抛语法错"，见 §8） | tests 6 / pass 3 / **fail 3** | ftsQuery：拉丁查询里的标点被清成空格…；ftsQuery：空/纯标点…；★ 检索回归：文件名/代码片段模样的查询不再抛 | tests 6 / pass 6 / fail 0（哈希一致） |

注入 4 的意义：**同一个核心缺陷会让三条不同入口的用例一起红** —— 这正是"四条入口共用同一个核心"的
反向证据（如果各写一套，改核心不会影响其它入口）。

---

## 7. 没做的部分与原因

| 没做 | 原因 |
| :--- | :--- |
| 后台页面的**文件上传**控件 | 后端需要 multipart 解析与另一套体积上限；大文件本来就有更好的入口（CLI 能递归扫目录、能按来源重导）。后台页面只做"粘贴一段"，并在界面上写明上限 |
| "按来源列出已喂条目"的专用查询接口 | 既有「记忆条目」页已能按来源搜索（`sourceScope` 在列表与搜索里），再开一个查询就是第二套读路径。删除/恢复因此也继续走既有的编辑/归档接口 |
| DSH Web UI 内嵌面板（`packages/dsh-component/client`，React）里的喂食界面 | 用户点名的「管理后台」是 `packages/admin-ui`（Vue，gateway 提供）；面板侧只提供接口（`POST /api/forlife/feed`），不在两套前端里各做一遍 |
| 向量语义去重 | 仓库没有向量库（PLAN §6.4 未落地，`store` 只依赖 `contracts`）。词面近似的边界在 `memory-core/src/similarity.ts` 与本文 §4 写清楚了 |
| 分块器 / 内容指纹索引 / 删除接口 | 用户的明确纠正（见 §3）：那三样属于记忆系统本身 |
| 新增数据库迁移 | 来源记在既有的 `source_scope` 列上，`feed.*` 参数进了保真度基线 —— 没有新表、没有新字段、没有新索引 |
| 训练/微调式的"喂食" | 本需求是"把资料交给它的记忆"，走的是写入 + 沉降路径；不影响模型权重 |

---

## 8. 顺带修掉的既有缺陷（不在本次需求内，是用真实文档扫出来的）

**现象**：用 CLI 扫 `docs/notes/` 时**每个文件都失败**：

```
✗ docs/notes/dsh-headless-task-contract.md：fts5: syntax error near "`"
✗ docs/notes/dsh-provider-config.md：fts5: syntax error near "."
✗ docs/notes/feed-memory.md：fts5: syntax error near "-"
```

**根因**（`packages/store/src/repository.ts` 的 `ftsQuery`）：不含 CJK 时，它把切分后的原文
**原样**交给 `MATCH`；而 FTS5 的裸词只允许字母/数字/下划线，其余字符被当成**查询操作符**：

```
MATCH 'feed-memory.md'          → fts5: syntax error near "."
MATCH '`feed.dedupeSimilarity`' → fts5: syntax error near "`"
MATCH '---'                     → fts5: syntax error near "-"
```

**影响面不止喂食**：recall 侧也一样 —— 模型拿一个文件名、路径或代码片段当查询时，
得到的不是"无命中"而是**整条检索抛错**。喂食只是让它变得必现（查重探针拿正文片段去查，
而 Markdown 里满是反引号、点号、连字符）。

**修法**：非 CJK 分支先清掉裸词之外的字符（成串的标点/符号 → 一个空格），
清完为空则给 `""`（合法、匹配不到、不抛）。这与 unicode61 **本来就在标点处切词**的口径一致
⇒ 语义不变、只是不再炸。顺带把 `CJK.test()` 换成不带 `g` 的 `HAS_CJK`：
带 `g` 的正则 `test()` 是**有状态**的（`lastIndex` 跨调用累积），当前顺序只是"巧合式正确"。

**新守卫**：`packages/store/test/fts-query.test.ts`（6 条），其中
`★ 检索回归：文件名/代码片段模样的查询不再抛，且按裸词命中` 就是红的起点。
