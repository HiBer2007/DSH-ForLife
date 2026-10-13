# 入站事件与 action 覆盖审计

> **本轮只读，未改任何代码。**
> **NapCat 侧来源**：**实测** —— VM `192.168.1.121` 容器 `forlife-qq-1`，
> `/app/napcat/napcat.mjs`（3,112,751 字节，83200 行，**Version 4.18.33**），
> 镜像 tag `mlikiowa/napcat-docker:latest`（未固定版本号）。
> **我们这侧来源**：仓库代码逐行核对，**每个"已处理"都给调用点**。
> 容器可达，**NapCat 侧全部为实测**；我们这侧全部为仓库读码（未跑真机回放，标注见 §5）。

---

## 0. 一句话结论

**"非消息事件"这一整层，我们不是"没处理"，而是"写进了一张没人读的表"。**

`gateway.ts:430 recordNonMessageEvent()` 把撤回 / 群成员变动 / 好友申请 / 群邀请
写成 `effects` 表里 `affects_model=1, reported=0` 的审计行 ——
而 `effects` 表**在生产代码里没有任何读取方**（唯一读者 `reports.ts:138 listUnreportedEffects`
被 `runReportCycle`（`reports.ts:242`）包着，而 `runReportCycle` 全仓**只被测试调用**
（`packages/gateway/test/reports.test.ts:139`），`index.ts:69` 只是 re-export）。

⇒ **好友申请、群邀请、被撤回、被踢、群文件到了 —— 全部"记了，但永远没人看"。**
这比"没处理"更难查：`qq_inbox` 面板上干干净净，`effects` 里躺着行。

**第二个结论更严重**：`timing.ts:196` 的 `empty` 噪音规则
（`text.trim() === '' && mediaKind == null && !isPoke` ⇒ 噪音）
与 `onebot.ts:333-358` 只解析 6 种 segment **叠加**，
导致**「只含未解析 segment 的消息」被整条当噪音吞掉** ——
不是"看到空壳"，是**连空壳都看不到**（`turns.ts:284` 直接 `return { woken:false, reason:'noise' }`）。

---

## 1. NapCat 实测：事件与 action 全清单

### 1.1 `post_type`（`napcat.mjs:64064`，实测）

| post_type | 我们 | 说明 |
| :--- | :--- | :--- |
| `message` | ✅ | 主路径 |
| `message_sent` | ⚠️ | 解析了；但**生产配置 `reportSelfMessage:false` ⇒ NapCat 根本不发**（见 §3.9） |
| `notice` | 🟡 | 4 个 notice_type 归一，其余 10 个直接 `return undefined` |
| `request` | ❌ | 只落 `effects`，无消费者 |
| `meta_event` | ❌ | `lifecycle/connect` 只设标志位；`heartbeat` 全丢 |

### 1.2 `meta_event_type`（实测，`napcat.mjs:64077 / 64127`）

`lifecycle`（sub_type `enable` / `disable` / `connect`）、`heartbeat`（`status.online` / `status.good` / `interval`）

### 1.3 `notice_type` —— **实测 14 个**

| notice_type | sub_type | 行号 |
| :--- | :--- | :--- |
| `notify` | `poke` | 70593 |
| `notify` | `title` | 71767 |
| `notify` | `gray_tip` | 71775 |
| `notify` | `group_name` | 71800 |
| `notify` | `profile_like` | 72141 |
| `notify` | `input_status` | 81046 |
| `group_ban` | `ban` / `lift_ban` | 70641 |
| `group_msg_emoji_like` | — | 71739 |
| `group_card` | — | 71749 |
| `essence` | `add` | 71757 |
| `group_upload` | — | 71793 |
| `group_increase` | `approve` / `invite` | 71881 |
| `group_decrease` | `leave` / `kick` / `kick_me` / `disband` | 72721 |
| `group_admin` | `set` / `unset` | 72741 |
| `friend_add` | — | 72714 |
| `friend_recall` | — | 81066 |
| `group_recall` | — | 81074 |
| `bot_offline` | — | 81082 |
| `online_file_receive` | `cancel` 等 | 73065 |
| `online_file_send` | 多种 | 73069 |

> **实测否证两条常见假设**：
> ① **没有 `notify/honor` 事件** —— 群荣誉只能靠 `get_group_honor_info` 主动查（全仓只有 action 名，无事件类）。
> ② **没有 go-cqhttp 的 `offline_file`** —— 已被 `online_file_receive/send` 取代。

### 1.4 `request_type` —— **实测 2 个**

`friend`（81057）、`group`（72751，sub_type `add` / `invite`）

### 1.5 消息段 `segment` —— **实测 24 种**（枚举 `ze`，`napcat.mjs:72199`）

```
text image music video record file at reply json face mface markdown
node forward xml poke dice rps miniapp contact location onlinefile flashtransfer
```
（枚举名是 `voice`，**字符串值是 `record`**）

**其中真正能入站的 13 种**（`rawToOb11Converters` 键，`napcat.mjs:73903` 起）：

| 元素 | → segment | 入站数据字段 |
| :--- | :--- | :--- |
| `textElement` | `text` | `text` |
| `picElement` | `image` | `summary` `file` `sub_type` `url` `file_size` |
| `fileElement` | `file` / `onlinefile` | 文件名/大小/`file_id`/`url` |
| `faceElement` | `face` | `id` `resultId` `chainCount` |
| `marketFaceElement` | `mface` | `emoji_package_id` `emoji_id` `key` `summary` |
| `replyElement` | `reply` | `id` |
| `videoElement` | `video` | `file` `url` `file_size` |
| `pttElement` | `record` | `file` `url`（**需 packet 后端健康**）`magic` |
| `multiForwardMsgElement` | `forward` | **`id`**（`content` 仅在 `parseMultMsg:true` 时才有） |
| `arkElement` | `json` | `data`（Ark/卡片字节） |
| `markdownElement` | `markdown` / `flashtransfer` | `content` / `fileSetId` |

**其余 11 种（`node` `xml` `poke` `dice` `rps` `miniapp` `contact` `location` `music`）是"发得出去、收不回来"** ——
NapCat 放进 schema（`napcat.mjs:72200-72420` 的 OB11Message* schema）供**出站**构造，入站侧没有对应转换器。

### 1.6 消息事件体字段（`napcat.mjs:73860 initializeMessage`，实测）

`self_id` `user_id` `time` `message_id` `message_seq` `real_id` `real_seq`
`message_type` `sender{user_id,nickname,card[,role]}` `raw_message` `font`
`sub_type`（`friend`/`normal`/`group`）`message[]` `message_format` `post_type`
＋ 群消息额外 `group_id` `group_name`；临时会话额外 `temp_source`
＋ `sender.role` **仅群消息有**（`owner`/`admin`/`member`，`napcat.mjs:73881`）

### 1.7 action —— **实测 181 条 `actionName = re.*` 注册**（注册点 `napcat.mjs:81026-81028`）

> 含 2 个测试桩（`test_auto_register_01/02`）与 `unknown` 兜底 ⇒ **约 178 个真实 action**。
> **一个都不缺地列在下面**（去掉了 `TestAutoRegister*`）。**加粗 = 我们已经接了**。

**OneBot11 标准核心（34）**
`send_private_msg` `send_group_msg` `send_msg` `delete_msg` `get_msg` `get_forward_msg`
`send_like` `set_group_kick` `set_group_ban` `set_group_whole_ban` `set_group_admin`
`set_group_card` `set_group_name` `set_group_leave` `set_group_special_title`
`set_friend_add_request` `set_friend_remark` `set_group_add_request`
`get_login_info` `get_stranger_info` `get_friend_list` `get_group_info` `get_group_list`
`get_group_member_info` `get_group_member_list` `get_group_honor_info`
`get_cookies` `get_csrf_token` `get_credentials` `get_record` `get_image`
`can_send_image` `can_send_record` `get_status` `get_version_info` `set_restart` `clean_cache` `bot_exit`

**go-cqhttp 扩展（32）**
`set_qq_profile` `_get_model_show` `_set_model_show` `get_online_clients` `delete_friend`
`mark_msg_as_read` `send_group_forward_msg` `send_private_forward_msg` `get_group_msg_history`
`ocr_image` `.ocr_image` `get_group_system_msg` `get_essence_msg_list` `get_group_at_all_remain`
`set_group_portrait` `set_essence_msg` `delete_essence_msg` `_send_group_notice` `_get_group_notice`
`upload_group_file` `delete_group_file` `create_group_file_folder` `delete_group_folder`
`get_group_file_system_info` `get_group_root_files` `get_group_files_by_folder` `get_group_file_url`
`upload_private_file` `download_file` `check_url_safely` `.get_word_slices` `.handle_quick_operation`

**NapCat 扩展（78）**
`get_private_file_url` `click_inline_keyboard_button` `get_unidirectional_friend_list`
`set_group_remark` `set_group_member_invite_policy` `set_group_member_permissions`
`set_group_new_member_history_visibility` `get_rkey` `get_rkey_server`
`set_online_status` `set_diy_online_status` `ArkSharePeer` `ArkShareGroup`
`send_group_ark_share` `send_ark_share` `get_robot_uin_range` `get_friends_with_category`
`set_qq_avatar` `get_file` `forward_friend_single_msg` `forward_group_single_msg`
`translate_en2zh` `fetch_ptt_text` `set_msg_emoji_like` `send_forward_msg`
`mark_private_msg_as_read` `mark_group_msg_as_read` `get_friend_msg_history`
`create_collection` `get_collection_list` `set_self_longnick` `get_recent_contact`
`_mark_all_as_read` `get_profile_like` `fetch_custom_face` `fetch_custom_face_detail`
`add_custom_face` `delete_custom_face` `set_custom_face_desc` `fetch_emoji_like` `get_emoji_likes`
`set_input_status` `get_group_info_ex` `get_group_share_link` `get_group_detail_info`
`get_group_ignore_add_request` `_del_group_notice` `friend_poke` `group_poke`
`nc_get_packet_status` `nc_get_user_status` `nc_get_rkey` `get_group_shut_list`
`move_group_file` `trans_group_file` `rename_group_file` `get_guild_list` `get_guild_service_profile`
`get_group_ignored_notifies` `set_group_sign` `send_group_sign` `send_packet` `get_mini_app_ark`
`get_ai_record` `get_ai_characters` `send_group_ai_record` `get_clientkey` `send_poke`
`get_share_link` `clean_stream_temp_file` `upload_file_stream` `test_download_stream`
`download_file_stream` `download_file_record_stream` `download_file_image_stream`

**群相册 / 群待办（16）**
`del_group_album_media` `set_group_album_media_like` `cancel_group_album_media_like`
`do_group_album_comment` `get_group_album_media_list` `upload_image_to_qun_album`
`upload_images_to_qun_album` `upload_video_to_qun_album` `get_qun_album_list`
`set_group_todo` `complete_group_todo` `cancel_group_todo` `set_group_kick_members`
`set_group_robot_add_option` `set_group_add_option` `set_group_search`

**可疑好友（2）** `get_doubt_friends_add_request` `set_doubt_friends_add_request`

**闪传 / 在线文件 / QQ空间（16）**
`create_flash_task` `send_flash_msg` `download_fileset` `get_fileset_info`
`get_flash_file_list` `get_flash_file_url` `get_fileset_id`
`send_online_file` `send_online_folder` `get_online_file_msg` `receive_online_file`
`refuse_online_file` `cancel_online_file` `get_group_signed_list`
`send_qzone_msg` `delete_qzone_msg`

### 1.8 ★ 我们这侧**只调用了 8 个 action**（全仓 `callAction('<name>'` 实测）

| action | 调用点 | 生产者（谁入队） |
| :--- | :--- | :--- |
| `send_group_msg` | `onebot.ts:431` `:474` | outbox `text`/`mention_all` |
| `send_private_msg` | `onebot.ts:437` | outbox `text` |
| `set_msg_emoji_like` | `onebot.ts:446` | `qq_reply.ts:211`（`qq_react` 工具） |
| `set_input_status` | `onebot.ts:461` | `qq-tools.ts:256`（`qq_typing`） |
| `get_login_info` | `onebot.ts:483` | 探活 |
| `get_group_at_all_remain` | `onebot.ts:505` | `gateway.ts:280` @全体 闸门 |
| `_send_group_notice` | `onebot.ts:526` | `mention-tools.ts:135`（`qq_group_notice`） |
| `delete_msg` | `onebot.ts:544` | ★ **没有任何入队点**（见 §6） |

> ⚠️ **`research/napcat-capability-gaps.md:11` 的"我们已经用上的"清单是失真的。**
> 它写着已用 `send_msg` `get_msg` `mark_msg_as_read` `upload_group_file` `upload_private_file`
> `set_online_status` `friend_poke` `group_poke` `send_poke` `get_status` `get_forward_msg` ——
> **这些字符串在 `packages/**` 里出现 0 次**（已逐个 grep 验证）。
> 该文档说的是"计划里要用"，但读起来像"已经在用"，请勿作为现状依据。

---

## 2. ★ 对照表（按影响排序，四类判定）

| # | 事件 / action | NapCat 支持? | 我们处理? | 类别 | 影响（丢了什么） | 建议 |
| :-- | :--- | :--- | :--- | :--- | :--- | :--- |
| 1 | segment `forward`（合并转发） | ✅ 实测 `:73443` | ❌ `onebot.ts:333-358` 无分支 | **❌ 完全没处理** | ★★★ **整条被噪音规则吞掉**（`timing.ts:196` + `turns.ts:284`）—— 连空壳都没有 | `get_forward_msg(forward.id)` 展开成 node 列表 |
| 2 | segment `json`（Ark/分享卡片/小程序/音乐） | ✅ 实测 `arkElement→json` | ❌ 无分支 | **❌ 完全没处理** | ★★★ 卡片-only 消息被当噪音整条吞；"她分享的歌/文章"永远看不见 | 解析 `data.data`，至少落摘要 |
| 3 | segment `face` / `mface`（QQ表情 / **商城大表情**） | ✅ 实测 | ❌ 无分支 | **❌ 完全没处理** | ★★★ 大表情 = 内容，且**被 noise 吞**；表情也不进表情库（入站无入库路径） | `mface.summary` 入文本；顺带做表情入库 |
| 4 | segment `markdown` / `flashtransfer` / `onlinefile` | ✅ 实测 | ❌ 无分支 | **❌ 完全没处理** | ★★★ 在线文件/闪传消息**被 noise 整条吞** | 至少保命：给占位符，别让它变成空串 |
| 5 | segment `image` | ✅ 实测 `url` 字段 | 🟡 `onebot.ts:343` 只置 `mediaKind` + `[图片]` | **🟡 部分处理** | ★★★ **图片内容对模型不可见**：`url` 存进了 `qq_inbox.payload` 但**全仓零下载/零视觉调用**（`VisionBridge` 只被自己的测试引用） | 接 `VisionBridge`（已写好但零调用）+ `get_image`/`download_file` |
| 6 | `request` `friend` / `group` | ✅ 实测 2 种 | ❌ `onebot.ts:286` 归一 → `gateway.ts:430` 落 `effects` | **❌ 完全没处理** | ★★★ **有人要加它，它永远不知道**；且没有 `set_*_add_request` ⇒ **即使知道了也无法回应** | ① `effects` 接通消费者（见 #14）② 加审批类 action |
| 7 | `notice` `friend_recall` / `group_recall` | ✅ 实测 | 🟡 `onebot.ts:236` 归一 → 只落 `effects` | **🟡 部分处理（实际=❌）** | ★★★ 记忆里留着已被撤回的内容，模型基于不存在的话行动 | 接到 `message_recalled` 唤醒条件 |
| 8 | `notice` `group_increase` / `group_decrease`(`kick_me`/`disband`) | ✅ 实测 | 🟡 `onebot.ts:273` → 只落 `effects` | **🟡 部分处理（实际=❌）** | ★★★ **被踢/群解散不知道**；`scheduler.ts:71` 给 `bot_offline` 排了 90 优先级，但没人触发它 | 同上 |
| 9 | `message_sent`（自己发的回声） | ✅ 实测，但**配置关闭** | 🟡 代码在（`onebot.ts:228`），**生产永不触发** | **🟡 部分处理** | ★★ `onebot-11_3112546448.json` 里 `reportSelfMessage: false` ⇒ **NapCat 根本不发**；`self_message_sent` 条件永不触发 | 打开 `reportSelfMessage` 或删掉死代码 |
| 10 | `meta_event` `heartbeat` | ✅ 实测（30s 一次） | ❌ `onebot.ts:299-304` 丢弃 | **❌ 完全没处理** | ★★ **丢掉了 `status.online`/`good`** ⇒ 无法发现"WS 连着但 QQ 已掉线"的**假活**（`research/napcat_issues.json:531` 记录的 35 小时静默离线，正是这个形态） | 用 heartbeat 做存活判据 + 系统状态 |
| 11 | segment `record`（语音） | ✅ 实测（`url` 需 packet 后端） | 🟡 `onebot.ts:349` 只 `[语音]` | **🟡 部分处理** | ★★ 语音内容不可见；**`fetch_ptt_text`（语音转文字）就在 NapCat 里，我们没用** | 先接 `fetch_ptt_text`，最便宜 |
| 12 | segment `reply`（引用） | ✅ 实测 | 🟡 `onebot.ts:355` 只加 `[引用]`，**`data.id` 被丢** | **🟡 部分处理** | ★★ **`reply_to_me` 唤醒条件（`wake.ts:42`）永远无法触发** —— 15 个条件里 7 个没有生产者 | 抽出 `replyToId`，判"是不是回我" |
| 13 | segment `file` / `video` | ✅ 实测 | 🟡 `onebot.ts:346/352` 只 `[文件]`/`[视频]` | **🟡 部分处理** | ★★ `file_id`/`name`/`size`/`url` 全不用 ⇒ 收到文件但**打不开也读不到** | `get_file` / `download_file` |
| 14 | ★ **`effects` 的消费者** | — | ❌ `runReportCycle` 只被测试调用 | **❌ 完全没处理** | ★★★ **#6/#7/#8 全部因此失效**；顺带 `compaction`/`admin_action`/`wake_rule` 等所有影响报告也都没投递 | 在网关主循环里跑 `runReportCycle`（**一行接线，收益最大**） |
| 15 | `sender.role` / `group_name` | ✅ 实测 `:73881` | ❌ `onebot.ts:367` 只取 `card`/`nickname` | **❌ 完全没处理** | ★ 不知道谁是群主/管理；`qq_sessions.title` 恒为 NULL | 顺手取，零成本 |
| 16 | `notice` `group_upload`（群文件到了） | ✅ 实测 `:71793` | ❌ `onebot.ts:283` 直接 return | **❌ 完全没处理** | ★★ 文件到了不知道；`file_received` 条件只认消息里的 file 段 | 归一 + 唤醒条件 |
| 17 | `notice` `group_msg_emoji_like`（有人给我消息点表情） | ✅ 实测 `:71739` | ❌ 同上 | **❌ 完全没处理** | ★ 社交反馈丢失 | 低优先 |
| 18 | `notice` `notify/input_status`（对方正在输入） | ✅ 实测 `:81046` | ❌ 同上 | **❌ 完全没处理** | ★★ **`peer_input_status` 条件（`wake.ts:43`）永不触发**；而 `qq-tools.ts:99` 的 `qq_reply` 描述**明确告诉模型"取回结果里会带 `typing: true`"** —— 这句话永远兑现不了 | 归一 + 写进 `pending_messages` |
| 19 | `notice` `group_ban`（禁言/解禁） | ✅ 实测 `:70641` | ❌ 同上 | **❌ 完全没处理** | ★★ **自己被禁言不知道**，会一直尝试发言然后失败 | 接系统状态 |
| 20 | `notice` `group_admin`（自己成为/失去管理） | ✅ 实测 `:72741` | ❌ 同上 | **❌ 完全没处理** | ★ 能力边界变化无感知（能否 @全体/禁言） | 低优先 |
| 21 | `notice` `group_card` / `notify/group_name` / `notify/title` | ✅ 实测 | ❌ 同上 | **❌ 完全没处理** | ★ 群名片/群名/头衔变更不进记忆 | 低优先 |
| 22 | `notice` `essence`（精华消息） | ✅ 实测 `:71757` | ❌ 同上 | **❌ 完全没处理** | ★ 群内"这条重要"的信号丢失 | 低优先 |
| 23 | `notice` `friend_add` | ✅ 实测 `:72714` | ❌ 同上 | **❌ 完全没处理** | ★ 新好友关系变化无感知 | 低优先 |
| 24 | `notice` `notify/profile_like` / `gray_tip` | ✅ 实测 | ❌ 同上 | **❌ 完全没处理** | ★ `gray_tip` 还是**伪造灰条攻击面**（NapCat 专门注释了"如果是伪造的灰条，这就是攻击者"） | 安全相关，建议看一眼 |
| 25 | `notice` `online_file_receive` / `online_file_send` | ✅ 实测 `:73065` | ❌ 同上 | **❌ 完全没处理** | ★ 在线文件收发全丢 | 低优先 |
| 26 | `notice` `bot_offline` | ✅ 实测 `:81082` | ❌ 事件不用；**但连接层兜底** ✅ | **➖ 不需要（已有等效路径）** | 已由 `runtime.ts:211 onConnectionState` → `wake.systemSource.observeConnection` 覆盖 —— **但只能发现 WS 断，发现不了"WS 通、QQ 掉"**（见 #10） | 与 #10 合并处理 |
| 27 | `meta_event` `lifecycle` | ✅ 实测 | 🟡 `onebot.ts:300` 只用 `connect` 设标志位 | **🟡 部分处理** | `enable`/`disable` 被丢（进程级启停） | 低优先 |
| 28 | `at` segment | ✅ | ✅ `onebot.ts:338` → `turns.ts:499-504` | ✅ 已处理 | — | — |
| 29 | `text` segment | ✅ | ✅ `onebot.ts:336` | ✅ 已处理 | — | — |
| 30 | `notice` `notify/poke` | ✅ | ✅ `onebot.ts:250` 合成 message → `turns.ts:499` | ✅ 已处理 | — | — |
| 31 | `_send_group_notice` | ✅ | ✅ `onebot.ts:526` ← `mention-tools.ts:135` | ✅ 已处理 | — | — |
| 32 | `set_msg_emoji_like` | ✅ | ✅ `onebot.ts:446` ← `qq-tools.ts:211` | ✅ 已处理 | — | — |
| 33 | `set_input_status` | ✅ | ✅ `onebot.ts:461` ← `qq-tools.ts:256`（群聊如实返败） | ✅ 已处理 | — | — |
| 34 | `get_login_info` / `get_group_at_all_remain` | ✅ | ✅ `onebot.ts:483` / `:505` | ✅ 已处理 | — | — |
| 35 | `delete_msg` | ✅ | 🟡 `onebot.ts:544` 有实现，**但 `kind:'delete'` 全仓无入队点** | **🟡 部分处理（=死代码）** | ★★ **它永远无法撤回任何消息**；`qq_reply` 也没有撤回工具 | 加 `qq_recall` 工具或删掉 |
| 36 | `get_forward_msg` `get_msg` `get_image` `get_record` `get_file` `download_file` `ocr_image` `fetch_ptt_text` `fetch_custom_face` | ✅ | ❌ 未实现 | **❌ 完全没处理** | ★★★ 入站媒体/转发/语音的**全部取回能力**都在这一行里 | 优先级见 §4 |
| 37 | `get_group_member_info/list` `get_group_info/list` `get_stranger_info` `get_friends_with_category` | ✅ | ❌ 未实现 | **❌ 完全没处理** | ★ 语境只有裸 ID，没有群名/称谓/人数 | 中优先 |
| 38 | `send_poke` / `friend_poke` / `group_poke` | ✅ | ❌ 未实现 | **➖/❌** | 只能被动收拍一拍，不能主动拍回去 | 低优先 |
| 39 | `mark_msg_as_read` 系列 | ✅ | ❌ 未实现 | **➖ 不需要（当前）** | 我们自己有 `processed` 标记，红点没清 | 可选 |
| 40 | `upload_group_file` / `upload_private_file` / `send_forward_msg` 系列 | ✅ | ❌ 未实现 | **❌ 完全没处理** | ★★ **出站发不出文件、发不出合并转发** | 见 §6 |
| 41 | `set_online_status` / `set_diy_online_status` / `set_self_longnick` / `set_qq_avatar` | ✅ | ❌ 未实现 | **➖ 不需要（当前）** | 自我表达类，暂无场景 | 可选 |
| 42 | `get_status` / `get_version_info` / `get_online_clients` | ✅ | ❌ 未实现 | **➖ 不需要**（`get_online_clients` 其实有用：检测"主人手动登录"） | — | — |
| 43 | `send_packet` / `get_cookies` / `get_csrf_token` / `get_credentials` / `get_rkey` / `get_clientkey` / `.handle_quick_operation` | ✅ | ❌ **刻意不实现** | **➖ 不需要** | `onebot.ts:19-22` 明确声明"根本不建方法"——**审计确认这条红线被守住了** ✅ | 保持 |
| 44 | 群相册 / 群待办 / 闪传 / QQ空间 / 频道 / 可疑好友 / 群签到 等 60+ 扩展 | ✅ | ❌ 未实现 | **➖ 不需要** | 与我们场景无关 | 不做 |
| 45 | `segment` `node` `xml` `poke` `dice` `rps` `miniapp` `contact` `location` `music` | 发得出，**收不回** | ❌ 无分支 | **➖ 不需要** | 入站侧不会出现（除 `xml` 可能经 gray_tip） | 不做 |

---

## 3. ★★ "静默丢失"清单（每条写明丢的到底是什么）

### 3.1 【最严重】只含未解析 segment 的消息 → 被当噪音**整条吞掉**

**机理**（三处代码叠加，每一处单独看都合理）：

1. `onebot.ts:333-358` 只处理 `text` `at` `image` `file` `record` `video` `reply`
   ⇒ 其余 18 种 segment **既不进 `text`，也不设 `mediaKind`**
2. `onebot.ts:368` `text: text.trim()` ⇒ 变成 `''`
3. `timing.ts:196-199` `empty` 规则：`text.trim()==='' && mediaKind==null && !isPoke` ⇒ **噪音**
4. `turns.ts:280-289` 整批噪音 ⇒ `return { woken:false, reason:'noise' }`，
   还调 `markProcessed` ⇒ **面板显示"已处理"**

**具体丢的东西**：

| 她发的 | 我们看到 |
| :--- | :--- |
| 一条**合并转发**（别人转给她的聊天记录） | **什么都没有**（不是空壳，是 0 条） |
| 一条**分享卡片**（歌 / 文章 / 小程序 / 邀请） | **什么都没有** |
| 一个**商城大表情** `mface` | **什么都没有** |
| 一条**在线文件** `onlinefile` / 闪传 | **什么都没有** |
| 一条**纯 QQ 表情** `face` | **什么都没有** |

> **与背景缺陷 #1、#2 同形但更隐蔽**：那两次至少"附件分片没渲染 / 转发是个空壳"，
> 这次是**连一条记录都不产生** —— `qq_inbox` 里没有任何行，事后完全无法察觉。

**最小修复**：`onebot.ts` 在 for 循环末尾加 `else { text += '[未解析:'+type+']' }`
（**一行**，立刻把"静默"变成"可见"），再逐个补真解析。

### 3.2 `image` / `record` / `video` / `file` 的真实内容

- **丢的是**：图片/语音/视频/文件的**实际内容**。
- NapCat **实测给了** `image.data.url`（HTTP CDN 直链）、`image.data.file`、`file_size`；
  `record.data.url`（需 packet 后端健康）；`file` 的 `file_id`/`file_name`/`file_size`。
- 这些字段**确实存进了 `qq_inbox.payload`**（`gateway.ts:398` `JSON.stringify(message.raw)`），
  **没有任何代码去读它**：`turns.ts:130` 只把 `message.text` 拼进提示词。
- `VisionBridge`（`dsh-component/src/vision-bridge.ts`）**写好了、能缓存、能复核**，
  但**全仓只被它自己的测试引用**（`packages/dsh-component/test/vision-bridge.test.ts:21`）
  ⇒ **又一次"写好了零调用"**。
- 具体后果：**"她发的健康截图"对模型而言就是三个字 `[图片]`**。

### 3.3 `reply` 段的 `id`（引用关系）

- **丢的是**：这条消息在回谁。
- `onebot.ts:355-357` 只 `text += '[引用]'`，`data['id']` **读完就扔**。
- 后果链：`wake.ts:42` 定义了条件 `reply_to_me`，`scheduler.ts` 给了它优先级，
  面板上能配它的概率 —— **但没有任何代码产生这个条件**
  （`turns.ts:495 defaultConditionOf` 是唯一生产者，它不产出 `reply_to_me`）。
- **15 个唤醒条件里 7 个没有生产者**：`reply_to_me` `peer_input_status` `peer_status_change`
  `message_recalled` `bot_offline`（事件路径）`external_request` `self_message_sent`。
  ⇒ **面板上改这些规则的开关/概率，什么都不会发生，而且不报错。**

### 3.4 `sender.role` / `group_name`

- **丢的是**：说话人在群里的身份（群主/管理/成员）与群名。
- NapCat 实测在群消息里给了 `sender.role`（`napcat.mjs:73881`）与 `group_name`（`:73880`）。
- 我们只取 `sender.card` / `sender.nickname`（`onebot.ts:367`）。
- 后果：`qq_sessions.title` 恒为 `NULL`；模型无法区分"群主发话"与"路人发话"。

### 3.5 `message_sent` —— 代码在，但**生产配置把它关了**

```json
// /app/napcat/config/onebot11_3112546448.json（实测）
{ "name": "forlife-gateway", "reportSelfMessage": false, ... }
```

- **丢的是**：主人用手机登这个号发的消息。
- `onebot.ts:228` 完整支持 `message_sent`、`gateway.ts:419 recordSelfMessage` 也写了，
  但 **NapCat 压根不发这个事件** ⇒ 整条路径是死代码，
  `wake.ts:50 self_message_sent` 条件永不触发。
- 且即便发了：`recordSelfMessage` 只写 `effects`（又是 §3.6 的黑洞）。

### 3.6 【结构性】`effects` 表：**只写不读**

- **丢的是**：**所有非消息事件**（好友申请、群邀请、撤回、群成员变动）+ 所有
  `compaction` / `admin_action` / `wake_rule` / `status_cleared` 影响报告。
- 证据：`gateway.ts:430-438` 写入 → 唯一读取方 `store/src/effects.ts:84 listUnreportedEffects`
  → 唯一调用者 `gateway/src/reports.ts:138 collectReportable`
  → 唯一调用者 `reports.ts:246 runReportCycle`
  → **调用者只有 `packages/gateway/test/reports.test.ts:139`**。
- `packages/gateway/src/index.ts:62,66,69` 只是 re-export（**不是调用**）。
- 面板侧也没有：全仓 `SELECT ... FROM effects` 只出现在测试里；
  `packages/dsh-component/src/api.ts` 没有 effects 端点。
- ⇒ **好友申请今天进来，明天进来，永远躺在 `effects` 里没人看。**

### 3.7 `heartbeat` 的 `status.online` / `status.good`

- **丢的是**：**QQ 侧**的在线状态。
- `onebot.ts:299-304`：`meta_event` 只在 `lifecycle/connect` 时设 `state.connected`，其余 `return undefined`。
- NapCat 每 30 秒发一次 heartbeat（`heartInterval: 30000`，实测），带 `status:{online,good}`。
- 后果：**"反向 WS 连着、QQ 已静默离线"这种假活，我们 100% 检测不到。**
  `research/napcat_issues.json:531` 记录的正是这个形态（35 小时收不到任何事件、WS 一直 ESTABLISHED）。
- `notice_type: bot_offline` 也**没解析**（`onebot.ts:283`），本该是第二道保险。

### 3.8 `heartbeat` 之外的 `meta_event` 与 `lifecycle enable/disable`

`onebot.ts:300` 只认 `connect`，`enable`/`disable` 丢弃 —— 丢的是进程级启停信号（影响小）。

### 3.9 出站方向的静默丢失（见 §6，此处只列）

`kind:'image'` / `kind:'file'` / `kind:'delete'` **全仓零入队点** ⇒
**我们发不出图片、发不出文件、撤回不了消息**（详情见 §6）。

---

## 4. 建议的补做顺序（影响 × 成本）

| 序 | 做什么 | 成本 | 为什么排这里 |
| :-- | :--- | :--- | :--- |
| **P0-1** | `onebot.ts:333` for 循环加 `else { text += '[未解析:'+type+']' }` | **1 行** | 把"整条静默消失"变成"看得见的占位符" —— **收益/成本比最高的一行** |
| **P0-2** | 接通 `runReportCycle`（网关主循环里跑一次，≈ `reports.ts:242` 的现成函数） | **数行** | 一次性救活 #6/#7/#8 与所有影响报告；且它**本来就是铁律 1 的实现** |
| **P0-3** | 解析 `forward` 段：取 `data.id` → 调 `get_forward_msg`（新 action，`onebot.ts callAction` 现成） | 小 | 背景缺陷 #2 的正解；不接就永远是"零" |
| **P0-4** | 解析 `reply` 段 `data.id`，产出 `reply_to_me` 条件 | 小 | 15 个条件里最该活的 1 个；"回我"是最强信号 |
| **P1-1** | `image` 段：下载 `data.url` → 接 `VisionBridge`（**已写好**，只需实例化 + 注入描述器） | 中 | 图片内容从"三个字"变成真描述 |
| **P1-2** | `record` 段：接 `fetch_ptt_text`（NapCat 自带语音转文字） | **小** | 比视觉便宜得多，直接拿文本 |
| **P1-3** | `notice` 补 `input_status` / `group_ban` / `group_upload` / `group_msg_emoji_like` | 小 | 每个都是"归一化 + 一条 wake 条件"的机械工作 |
| **P1-4** | `heartbeat.status.online/good` 做存活判据；`bot_offline` 事件做第二道保险 | 小 | 治"假活"，这是"模型以为一切正常"的根源 |
| **P2-1** | `mface` / `json` / `xml` / `markdown` / `onlinefile` 至少给占位符（P0-1 已覆盖大半），再逐个真解析 | 中 | `mface.summary` / Ark `data` 都是可读文本 |
| **P2-2** | `file` 段：`file_id` → `get_file`；`sender.role` / `group_name` 顺手入库 | 小 | 语境与可用性 |
| **P2-3** | `kind:'delete'` 加 `qq_recall` 工具（或删掉死代码 `onebot.ts:544`） | 小 | 消除"实现了但零调用"的存量 |
| **P3** | `message_sent`：决定是开 `reportSelfMessage` 还是删死代码 | 小 | 歧义要消除，不能两不靠 |
| **P3** | 群相册/群待办/闪传/空间/频道等 60+ 扩展 | — | **不做**（明确无关） |

---

## 5. 存疑 / 未实测的部分

| # | 存疑项 | 为什么判不了 |
| :-- | :--- | :--- |
| a | 生产流量里**实际出现过**哪些 segment 类型 | 需要读 `.runtime` 下的 sqlite 或 `qq_inbox`，**本轮遵守"不碰 .runtime"约束**，没查 |
| b | `qq_inbox.payload` 里 `image.data.url` 是否**真的非空** | NapCat 的 `picElement` 走 `getImageUrl(e)`（`napcat.mjs:73128`），理论上给 CDN 直链；但 `disableGetUrl`/`enableLocalFile2Url:false`（实测配置）下的确切返回值**未跑真机验证** |
| c | `record.data.url` 是否可得 | 源码里依赖 `PacketApi.packetStatus` 健康（`napcat.mjs:73409`），而 packet 后端故障是 NapCat 已知静默失败面 ⇒ **很可能拿到空串**（这正是 `fetch_ptt_text` 更划算的理由） |
| d | `message_id` 精度 | 群消息 `message_id = e.id`，出站 `delete_msg`/`set_msg_emoji_like` 用 `Number(messageId)`（`onebot.ts:446,544`）。**是否超过 2^53 未验证** |
| e | `runReportCycle` 是否真未被调用 | 基于全仓 grep（排除 `node_modules`/`dist`）。若存在**运行时动态 require 或 DSH 插件侧调用**，grep 看不到 ⇒ **标为高度可信但非 100%** |
| f | NapCat 精确版本号 | 镜像 tag 是 `:latest`（未固定）。源文件里有字符串 `"4.18.33"`，**推定**为该版本 |
| g | `notify/gray_tip` 的入站表现形式 | `ze` 枚举里**没有** `gray_tip`，转换器表里也没有 `grayTipElement` ⇒ 灰条可能根本不作为 segment 上报，或退化成别的元素。**未实测** |
| h | 群消息 `sender.level` / `sender.title` | 我在 NapCat 源里**没找到**设置它们的地方（只找到 `sender.role`）⇒ 推定 NapCat **不提供**，但未逐行穷尽 |
| i | `notice_type: group_ban` 的 `sub_type` 是否为 `ban`/`lift_ban` | 源码里 `c = a > 0 ? "ban" : "lift_ban"`（`:71880` 附近）是**局部变量**，赋值给事件字段的那一步没读到 ⇒ **存疑** |

---

## 6. 其它"不是事件但同类"的静默丢失

### 6.1 出站：**发不出图片/文件，也撤回不了**

`OutboundSegment`（`transport.ts:91-97`）支持 6 种，`onebot.ts:408 toOneBotSegments` 也全映射了。
但**队列侧 `kind` 的入队点**实测只有这些：

| outbox kind | 入队点 | 状态 |
| :--- | :--- | :--- |
| `text` | `qq-tools.ts:163`、`admin/api.ts:452`、`runtime.ts:94` | ✅ |
| `sticker` | `sticker-service.ts:334` | ✅ |
| `reaction` | `qq-tools.ts:211` | ✅ |
| `input_status` | `qq-tools.ts:256` | ✅ |
| `notice` | `mention-tools.ts:135` | ✅ |
| `mention_all` | `mention-tools.ts:92`、`gateway.ts:316` | ✅ |
| **`image`** | **无** | ❌ **发不出图片**（`qq_reply` 参数只有 `text`/`reply_to`/`at`） |
| **`file`** | **无** | ❌ **发不出文件** |
| **`delete`** | **无** | ❌ **`deleteMessage`（`onebot.ts:543`）是死代码** |

⇒ 模型**只能发文字、@、引用、表情包**。想给它发张图/发个文件/撤回一句话，**能力上就不存在**。
这与"入站看不到图"是**同一个能力缺口的两个方向**。

### 6.2 面板显示方向

| 位置 | 丢的是什么 |
| :--- | :--- |
| `ConversationsView.vue:103-110 textPreview` | `mediaKind` 只映射 `image`/`file`；**`record` / `video` 落到 `'（无文本）'`** —— 语音/视频消息在面板上看起来像空消息 |
| 面板入站列表 | 只读 `qq_inbox`，**`effects` 表没有任何入口** ⇒ 好友申请在面板上也看不见 |
| `qq_sessions.title` | 恒为 `NULL`（`group_name` 入库时未取），会话列表只能显示裸 ID |
| `admin/queries-media.ts` | `inboundStats` 只统计 `images`/`files` 两类（`media_kind` 有 4 种取值） |

### 6.3 "文档承诺 ≠ 代码事实"这一类

| 承诺在哪 | 承诺内容 | 事实 |
| :--- | :--- | :--- |
| `research/napcat-capability-gaps.md:11` | 已用 21 个 action | **其中 11 个字符串在 `packages/**` 出现 0 次** |
| `qq-tools.ts:99` | "取回结果里带 `typing: true` 说明对方还在打字" | `read_pending` 的输出 schema（`qq-tools.ts:322-343`）**没有 `typing` 字段**，`pending_messages` 表也没有该列 ⇒ **永远看不到** |
| `qq-tools.ts:96` | "发送前必须先调用 `read_pending`" | 硬性顺序**没有代码强制**（`qq_reply` 不检查），只是提示词约束 |
| `wake.ts:143` | 8 个"不分会话类型"的唤醒条件，面板可见可配 | **7 个没有生产者**（§3.3）⇒ 配了也不会发生 |

> 这一类的共同点：**都"不报错"**。开关点得下去、工具跑得通、面板有数据 —— 只是那件事永远不会发生。

---

## 附：本报告的证据命令（可复现）

```bash
# NapCat 事件枚举（写在类字段赋值上，最不容易漏）
grep -nE '(post_type|notice_type|request_type|meta_event_type|sub_type) = "'  /app/napcat/napcat.mjs
# post_type 枚举
grep -n 'var qu = '                                                /app/napcat/napcat.mjs   # 64064
# segment 枚举（ze）
grep -n 'var Gs = '                                                /app/napcat/napcat.mjs   # 72199
# 入站转换器键（决定"哪些 segment 真能收到"）
awk '/rawToOb11Converters = {/,/^  };/'                            /app/napcat/napcat.mjs
# action 注册点（谁被真正注册）
sed -n '81026,81028p'                                              /app/napcat/napcat.mjs
# 生产上报配置（致命：reportSelfMessage / parseMultMsg / messagePostFormat）
cat /app/napcat/config/onebot11_3112546448.json
```

**我们这侧**：
```bash
grep -rn "callAction(<[^>]*>)?(\s*'" packages/            # 只 8 个 action
grep -rn "kind: '(delete|image|file)'" packages/          # 零入队点
grep -rn "runReportCycle|listUnreportedEffects" packages/  # 只有测试
grep -rn "\[\u56fe\u7247\]|\[\u6587\u4ef6\]" packages/     # segment 渲染只有 onebot.ts 一处
```

---

## 附二：2026-10-09 后续状态（**本报告是只读快照，这一节记"后来又改了什么"**）

### A. 唤醒条件：**7 个没有生产者 ⇒ 4 个**（§3.3 的账）

| 条件 | 本报告时 | 现在 | 怎么修的 |
| :--- | :--- | :--- | :--- |
| `reply_to_me` | ❌ 永不触发 | ✅ **有生产者** | `turns.ts defaultConditionOf` 用 `replyToMessageId` 反查 `qq_outbox.platform_msg_id`（判据"这条在回我发过的消息"）；真源 `turns.ts` + 守卫 `gateway/test/wake-condition-producers-wiring.test.ts` |
| `external_request` | ❌ 面板上是死开关 | ✅ **矩阵真的被消费** | `wake-external-source.ts` 的 `fire()` 先过 `decideWake(external_request)`：不放行就 `ok:false` 并说清是"唤醒矩阵拦下" |
| `bot_offline`（事件路径） | ❌ 无生产者 | ✅ **判据 + 状态机 + 已装配** | 新模块 `wake-liveness.ts`（心跳断 / `online=false` / `bot_offline` 通知 ⇒ 过 `bot_offline` 矩阵 ⇒ `systemSource.observe('qq.silent')`）；`wake-runtime.ts` 装配，`gateway/src/runtime.ts` 的 `onConnectionState` 喂 WS 状态（**否则真断线会被 `qq.disconnected` 与 `qq.silent` 各报一次**） |
| `peer_input_status` | ❌ | ❌ **仍缺事件源** | 等 `onebot.ts` 解析 `notice_type: notify / sub_type: input_status`（P1-3）—— `qq-tools.ts:99` 的 `typing: true` 也一起才能兑现 |
| `peer_status_change` | ❌ | ❌ **仍缺事件源** | NapCat **没有**这个事件，只能按人轮询 `nc_get_user_status`（默认关，见 §5 存疑项） |
| `message_recalled` | ❌ | ❌ **缺接线** | 事件已归一（`InboundEvent{type:message_recalled}`），但消费者在 `gateway.ts` 的事件路径上（现在只写 `effects`） |
| `self_message_sent` | ❌ | ❌ **缺接线** | 需要 NapCat `reportSelfMessage: true`（生产配置是 false）+ `gateway.ts` 把 `isSelf` 消息送进条件判定 |

**配套（防这类缺陷复发）**：
 1. `wake.ts` 新增**生产者登记表** `WAKE_CONDITION_PRODUCERS`（`by: null` 必须写 `waitingOn`）
    + `describeWakeProducerGaps()`；
 2. `wake-runtime.ts` 启用时把缺口**打进启动日志** —— "配了不会发生"从"事后审计才发现"
    变成"启动第一眼能看到"；
 3. 守卫 `gateway/test/wake-condition-producers-wiring.test.ts` 逐条核对
    "声称的生产者文件里真的有产出它的那一行"（**去注释、语句位置**）。

### B. §5 存疑项 d（`message_id` 精度）：**已核验，当前无损，但没有结构性保证**

- **实测（只读）**：`.runtime/dsh/forlife/db/forlife.sqlite` 的 `qq_outbox.platform_msg_id`
  **12 个真实值**（NapCat `send_*_msg` 回的 `message_id`，经 `String()` 落库）：
  最长 **10 位**、最大 **1,956,236,413**、**超 2^53 的 0 个**。样例：
  `1289906253` `147359434` `1956236413` `741913733` `800280412`。
- **反面证据取不到**：QQ 自己的消息库（`.runtime/qq-backup/**/nt_db/nt_msg.db`）是**加密**的
  （`file is not a database`）⇒ 群消息 id 的真实分布**无法在本机验证**；本机 `qq_inbox` 是 0 行
  （真实流量在 VM 上）。
- **上游证据**：NapCat commit `870a6060`（2026-09-29，实测于 4.18.28）说明 `reply` 段的
  `data.id` **等于被引用消息自身事件里的 `message_id`**，且"群聊与带真实序号的私聊行为不变"
  ⇒ §3.3 的修法（拿 `reply.data.id` 去比 `platform_msg_id`）**语义正确**；
  同时说明**私聊引用在旧版会整段消失**（#1508）—— 我们部署的 4.18.33 已含该修复。
- **结论**：`Number(messageId)`（`onebot.ts` 的 `delete_msg` / `set_msg_emoji_like`）
  **今天不会丢精度**（观测值差 6 个数量级），但**失败形态是静默的**：
  一旦 NapCat 某个动作开始回更大的 id（或字符串 id），`Number()` 会悄悄取整，
  撤回/表情回应会打到**错的（或不存在的）消息**上，而调用方只看得到 `retcode != 0`。
  ⇒ 建议（**`onebot.ts` 不归本轮**）：在 `callAction` 之前断言
  `Number.isSafeInteger(Number(id))`，不安全就**报错而不是截断**，并考虑直传字符串形态
  （OneBot v11 的 `message_id` 允许 string；NapCat schema 是否接受需 P1 侧核对）。

### C. §6.2 面板：**已修一半**

- ✅ 消息类型映射补全：`ConversationsView` 的预览以前只映射 `image`/`file`
  （`record`/`video` 显示成「（无文本）」）；现在走 `admin-ui/src/utils/message-labels.ts`
  （4 个 `media_kind` + 24 个 segment 名 ⇒ 中文，`MediaView` 的类型列一并修）。
- ❌ **`effects` 仍然没有面板入口**：`runReportCycle` 那条管线现在**已接通**
  （`gateway.ts supervise()` 走 `collectReportable` → `listUnreportedEffects`，定时器在跑），
  所以**模型侧看得到**；但面板侧 `effects` 只在「存储」页显示**行数**
  （`admin/queries-storage.ts` 的 `WATCHED` 表），没有"未投递影响报告"的入口 ——
  加它要动 `packages/gateway/src/admin/{api,queries-*}.ts`（并行改动中）。
- ❌ `qq_sessions.title` 仍恒为 NULL、`queries-media.ts` 的 `inboundStats` 仍只统计 `images`/`files`
  （`media_kind` 有 4 种取值）。

### D. 仍然成立的结论

- `kind: 'delete'` / `kind: 'image'` / `kind: 'file'` **仍然零入队点**（重新 grep 过）⇒
  出站发不出图片/文件、也撤回不了（§6.1）。
- `notice_type` 里除 `recall` / `poke` / `group_increase` / `group_decrease` 之外**仍未解析**
  （`input_status` / `group_upload` / `group_ban` / `friend_add` / `essence` / `gray_tip` …）——
  §3.7 的 `heartbeat` 丢弃**也仍然成立**（`onebot.ts` 的 `meta_event` 分支只认 `lifecycle/connect`）。
