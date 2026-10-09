# 从 DeepSeek 网页端导出聊天记录（脱敏方法）

> **这份文档可以提交** —— 它只讲**怎么拉**，不含任何凭据。
> **含凭据的脚本在 `.runtime/fetch-deepseek-chat.ps1`**（`.runtime/` 已 gitignore，永不入库）。

## 为什么要走接口而不是"网页另存为"

网页端是 React 应用，聊天记录**不在 HTML 里**，而是一次 XHR 拉回来的 JSON。
所以只能照它的请求复刻一份 —— 抄 cookie + token，打同一个接口。

**⇒ 代价**：cookie 与 token 都是**会话级**的，**几小时到几天就失效**。
失效后要重新从浏览器里抄（见下面「怎么重新抄凭据」）。

## 接口

```
GET https://chat.deepseek.com/api/v0/chat/history_messages
      ?chat_session_id=<会话 id>
      &cache_version=0
      &cache_reset_at=0
```

### ★★ `cache_version` 的语义（**踩过的坑，务必看**）

它是**增量游标**，不是"版本号"：

| 传什么 | 拿回什么 |
| :--- | :--- |
| **`0`** | ★ **全量**（要的就是这个） |
| **会话当前的 `version`** | ★ **0 条**（"你已经有这一版了"） |
| 一个过期的 version | 那个版本**之后**的增量（不是全部） |

**证据**：响应里有 `"cache_control": "MERGE"` —— 明说了是增量合并。

**⚠️ 这个接口失败的方式是「安静地返回空数组 + HTTP 200」** ——
不是 401、不是 404，就是 `chat_messages: []`，文件 410 字节。
**⇒ 判成功的标准是「消息条数」，不是「HTTP 200」。**

### 请求头（值都是会过期的，这里只列名字）

| 头 | 说明 |
| :--- | :--- |
| `authorization` | `Bearer <token>` —— 从浏览器开发者工具里抄 |
| `x-device-id` | 设备标识（同一份即可） |
| `x-client-bundle-id` | `com.deepseek.chat` |
| `x-client-platform` | `web` |
| `x-client-version` | 形如 `2.5.0` |
| `x-client-locale` | `zh_CN` |
| `x-client-timezone-offset` | `28800`（+8 区，秒） |
| `Referer` | `https://chat.deepseek.com/a/chat/s/<会话 id>` |
| `Sec-Fetch-*` | `empty` / `cors` / `same-origin` |
| `User-Agent` | 普通 Firefox/Chrome UA |

**Cookie**（域名都填 `chat.deepseek.com`）：`HWWAFSESTIME`、`HWWAFSESID`、`ds_session_id`。

### 响应形状

```
{
  "code": 0,
  "data": {
    "biz_data": {
      "chat_session": { "id", "title", "version", "current_message_id", … },
      "chat_messages": [ … ],          ← ★ 要的就是这个
      "cache_control": "MERGE"
    }
  }
}
```

**`chat_session.version` 是关键**：它就是那个"第几版"，
**下次要增量时可以拿它当 `cache_version`**（但**要全量就传 0**）。

## 怎么重新抄凭据

1. 浏览器登进 `chat.deepseek.com`，打开目标会话
2. F12 → 网络 → 筛 `history_messages`
3. 刷新页面，点开那条请求
4. **请求头**里抄 `authorization`；**Cookies** 标签里抄那三个
5. 地址栏里的 `/a/chat/s/<这一段>` 就是 `chat_session_id`
6. 填进 `.runtime/fetch-deepseek-chat.ps1` 顶部的凭据块

## 现有会话

| 别名 | 会话 id | 标题 |
| :--- | :--- | :--- |
| `seg1-newer` | `d9280446-d5e0-48ec-8a86-382df1c9b6a2` | 呆肥鱼守护小猫 |
| `seg2-older` | `41070dea-5aa3-45fa-a813-71497153b695` | 可以聊聊 |

**会话 id 不是凭据**（它出现在 URL 里），可以写在这儿。

## 拉完之后

```powershell
pwsh -NoProfile -File .runtime\fetch-deepseek-chat.ps1
```

输出到 `.runtime/chat-import/<别名>.json`。
**每次都先备份旧的**（脚本不动旧的，备份是手工做的）。

**⇒ 拿到 JSON 后接切段 + 投喂**，见 `docs/notes/feed-memory.md`。

## 纪律（**血的教训**）

1. **凭据只落在 `.runtime/`**（已 gitignore）。**绝不写进任何 tracked 文件** ——
   包括提交信息、文档、注释。
2. **提交前查一眼**：`git log --all -S 'HWWAFSESID'` 应该是空的。
3. **判拉取成功看「消息条数」**，不看 HTTP 状态码（这接口会安静地返回空）。
