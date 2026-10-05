# NapCat 能力缺口盘点：还有哪些动作/事件没用上

> 来源：本机落盘的 NapCat 官方文档（`research/ncdocs/onebot__api.md` 全 170 行动作表 + `research/ncdocs2/onebot__event.md` 全 485 行事件表）
> 对照物：本项目计划里**已经用上**的动作与事件
> 分级：⭐⭐⭐ 应该马上加 / ⭐⭐ 值得加 / ⭐ 可选 / ⚠️ 需审批 / 🚫 安全红线（永不给模型）

---

## 0. 我们已经用上的（基线）

**动作**：`send_private_msg` `send_group_msg` `send_msg` `set_msg_emoji_like` `set_input_status` `get_login_info` `get_msg` `delete_msg` `mark_msg_as_read` `mark_group_msg_as_read` `mark_private_msg_as_read` `upload_group_file` `upload_private_file` `get_group_at_all_remain` `set_online_status` `set_diy_online_status` `set_self_longnick` `friend_poke` `group_poke` `send_poke` `get_status`（+ 计划中的 `get_friend_list` `get_group_member_list`）

**事件**：`message.private` `message.group` `notice.notify/input_status` `notice.notify/poke` `notice.group_msg_emoji_like` `meta_event.lifecycle` `meta_event.heartbeat`

---

## 1. ⭐⭐⭐ 高价值缺口（建议直接进计划）

| 能力 | 类型 | 为什么重要 | 建议落点 |
| :--- | :--- | :--- | :--- |
| **`bot_offline` 事件** | 事件 | **机器人离线通知**（带 `tag` 与 `message`）—— 这正是"QQ 掉线 → 系统故障状态 + 唤醒模型"的**真实事件源**。此前在 DSH 侧查证"没有 QQ 网络状态事件"是对的，但 **OneBot 层有** | 新的 `system_event` 子类；触发 §2.17.6 的 `system` 状态；唤醒模型 |
| **`friend_recall` / `group_recall` 撤回事件** | 事件 | 被撤回的消息如果已进**记忆**或**待读池**，模型会基于已不存在的内容行动 ⇒ **记忆一致性**问题。这正好是"任何影响模型的事都要告知模型"的实例 | 新增 `recall` 处理：标记消息失效 + 通知模型（必要时修正记忆） |
| **`nc_get_user_status`** | 动作 | **好友状态变更缺事件源的正解**：可以主动查询指定用户状态 ⇒ 把 `peer_status_change` 的探测从"轮询整个好友列表"变成"**轮询指定用户**"，精准且省 | `peer_status_change` 条件；`L4 特别关心`的探测实现 |
| **`get_forward_msg`** | 动作 | 合并转发里含多条消息 ⇒ 不解析就**整段丢失**（内容为 `[CQ:forward]`）。这是**必须支持**的解析能力，不是可选功能 | 消息解析管线必做项 |
| **`ocr_image` / `.ocr_image`** | 动作 | 框架侧 OCR ⇒ **视觉桥接的第一级**：纯文字截图先用 OCR（更便宜更准），只有复杂图像才调视觉模型 | 视觉桥接降级链：OCR → 视觉模型 |
| **`fetch_custom_face`** | 动作 | **拉取 QQ 自定义/收藏表情** ⇒ 直接作为我们自己表情库的**入库来源**（入库路径 ②"联网搜索"的补充：不用上网就能拿） | §2.9 表情库入库路径 |
| **`download_file`** | 动作 | 框架自带下载器（支持 `thread_count` 与自定义 `headers`）⇒ QQ 图片/文件/表情入库不必自己写下载器，且框架可能已处理签名/鉴权 | media 包的下载层优先用它 |
| **`check_url_safely`** | 动作 | URL 安全检测 ⇒ 与"表情下载白名单""端口发布目标白名单"并列的**第三道安全闸** | 安全护栏 |
| **`request.friend` / `request.group` 事件** | 事件 | **需要回应**的外部请求（好友请求、加群请求）+ 对应动作 `set_friend_add_request` / `set_group_add_request` ⇒ 典型的"外部事件需要模型决策" | 新唤醒条件 + 工具（需审批） |
| **`message_sent` 事件** | 事件 | **机器人自己发出的消息也回传**（含你在手机上用该账号手动发言）⇒ 多端一致性：模型应知道"我刚才/主人刚用我的号说了话" | 新唤醒条件 `self_message_sent`（默认低概率/仅记录） |
| **`nc_get_packet_status`** | 动作 | 数据包后端健康状态 ⇒ **自检**（NapCat 已知故障面：packet 后端挂掉会让一批依赖发包的功能静默 1400，如 `get_private_file_url` / `send_poke` / `get_rkey`） | 启动自检 + 健康探测 |

---

## 2. ⭐⭐ 值得加（按场景）

| 能力 | 类型 | 用途 |
| :--- | :--- | :--- |
| `group_upload` 事件 | 事件 | 群文件上传 ⇒ 唤醒条件"文件到了"（并入/细化 `media_received`） |
| `group_increase` / `group_decrease` 事件 | 事件 | 群成员变动；**`decrease.sub_type` 含 `kick_me`（我被踢）与 `disband`（群解散）** ⇒ 会话可用性变化，必须告知模型 |
| `group_admin` 事件 | 事件 | 自己成为/失去管理员 ⇒ 能力边界变化（能否 @全体、能否禁言） |
| `group_ban` 事件 | 事件 | 群禁言/解除；**自己被禁言时无法发言** ⇒ 应改变状态并告知模型 |
| `group_card` / `notify/group_name` / `notify/title` 事件 | 事件 | 群名片/群名/头衔变更 ⇒ 语境与身份变化，低频入记忆 |
| `essence` 事件 + `set_essence_msg` | 事件+动作 | 精华消息增删；模型可主动"加精"标记重要内容（自我标记） |
| `notify/profile_like` 事件 + `send_like` | 事件+动作 | 资料点赞与回赞 ⇒ 社交反馈（可做"特别关心"的互动） |
| `friend_add` 事件 | 事件 | 新好友 ⇒ 关系变化，告知模型 |
| `get_friend_msg_history` / `get_group_msg_history` | 动作 | **主动阅读历史**（不只是待读池）⇒ 强化 `read_pending`：可回溯更早 |
| `get_recent_contact` | 动作 | 最近联系人 ⇒ 模型"自己寻思"时知道谁最近找过它 |
| `_get_group_notice` / `_send_group_notice` / `_del_group_notice` | 动作 | 群公告读写 ⇒ **重要事项通知全群的更优手段**（比 @全体 更礼貌、不消耗额度） |
| `set_friend_remark` / `set_group_remark` | 动作 | **给联系人与群起备注名** ⇒ 与记忆高度契合：模型维护自己的"人名映射表" |
| `get_online_clients` | 动作 | 自己在线客户端列表 ⇒ 能检测"**主人手动登录了我的号**"（正对应"防止手动登录时一直响"的场景），据此调整行为 |
| `_mark_all_as_read` | 动作 | 处理完积压后清理红点（我们自己账号，安全） |
| `send_group_forward_msg` / `send_private_forward_msg` / `send_forward_msg` | 动作 | 合并转发外发 ⇒ 长内容/多条内容打包发送，比连刷多条更优雅 |
| `get_image` / `get_record` / `get_file` | 动作 | 取媒体原始文件 ⇒ 入站媒体管线 |
| `create_collection` / `get_collection_list` | 动作 | QQ 收藏夹 ⇒ 天然的"外部存储"（模型可收藏重要内容） |
| `get_stranger_info` | 动作 | 陌生人资料 ⇒ 临时会话场景 |
| `get_group_info` / `get_group_info_ex` / `get_group_list` / `get_friends_with_category` | 动作 | 语境基础数据（群名/人数/分类）⇒ 渲染"这是哪个群" |
| `get_group_shut_list` / `get_group_honor_info` | 动作 | 群禁言列表 / 群荣誉 ⇒ 语境丰富化 |
| `can_send_image` / `can_send_record` | 动作 | 发送能力自检 ⇒ 失败前预判 |
| `get_doubt_friends_add_request` / `set_doubt_friends_add_request` | 动作 | 可疑好友请求 ⇒ 安全相关 |

---

## 3. ⭐ 可选 / 趣味

`set_group_sign` / `send_group_sign`（群签到，可做每日例行自主行为）、`translate_en2zh`（框架内置翻译）、`.get_word_slices`（中文分词，可辅助关键词匹配与记忆检索）、`ArkSharePeer` / `ArkShareGroup` / `get_mini_app_ark`（分享卡片）、`set_qq_profile` / `set_qq_avatar`（改资料/头像 ⇒ 自我表达）、`set_group_portrait`、`get_group_system_msg`、`get_group_ignore_add_request`、`get_group_ignored_notifies`、`get_ai_characters` / `get_ai_record` / `send_group_ai_record`（群 AI 语音）、`fetch_emoji_like` / `get_profile_like`、`get_robot_uin_range`、`click_inline_keyboard_button`、`.handle_quick_operation`、`get_guild_list` / `get_guild_service_profile`（频道，未用）、`_get_model_show` / `_set_model_show`、`unknown`

---

## 4. ⚠️ 需要审批（破坏性或不可逆）

| 动作 | 风险 |
| :--- | :--- |
| `set_group_kick`（踢人） | 不可逆的群体影响 |
| `set_group_ban` / `set_group_whole_ban`（禁言） | 影响他人发言权 |
| `set_group_leave`（退群，`is_dismiss` 可解散群） | **极高危**，群主可解散 |
| `delete_friend` | 关系不可逆 |
| `set_group_add_request` / `set_friend_add_request`（拒绝类） | 社交后果 |
| `set_qq_profile` / `set_qq_avatar` / `set_group_portrait` | 对外可见的形象变更 |
| `bot_exit`（退出机器人） | 自伤式操作 |
| `clean_cache` | 可能影响登录态 |

**建议**：一律**默认禁用**，走"显式放行 + 审批 + 审计"（复用 §2.10 端口发布那套护栏），并且**每次调用都要告知模型结果**。

---

## 5. 🚫 安全红线（永不进工具清单）

| 动作 | 为什么 |
| :--- | :--- |
| `send_packet` | **可发送任意 OIDB 数据包** —— 等于把协议层完全交给模型 |
| `get_cookies` / `get_csrf_token` / `get_credentials` / `get_rkey` / `get_clientkey` | 登录态与凭据 ⇒ 泄漏即账号失守 |
| `.handle_quick_operation` | 对事件做"快捷操作"，语义不透明、边界不清 |
| `get_csrf_token` 等下游派生能力 | 同上 |

**处理方式**：这些动作在 `QqTransport` 适配器里**根本不实现**（不是"实现了但不给工具"）—— 从能力面上切断，避免将来有人图方便接上去。

---

## 6. 落地建议（优先级）

1. **P0（立刻并入计划）**：`bot_offline`、`friend_recall`/`group_recall`、`nc_get_user_status`、`get_forward_msg`、`ocr_image`、`fetch_custom_face`、`download_file`、`check_url_safely`、`request.friend`/`request.group`、`message_sent`、`nc_get_packet_status`。
2. **P1**：`group_upload`、`group_decrease`(`kick_me`/`disband`)、`group_admin`、`group_ban`、`friend_add`、`get_*_msg_history`、`_*_group_notice`、`set_*_remark`、`get_online_clients`、`get_recent_contact`、`get_group_info*`。
3. **P2**：其余 ⭐ 项按需接。
4. **永远不做**：⚠️ 默认禁用 + 审批；🚫 适配器层不实现。

---

## 7. 不确定性

| # | 未验证 |
| :-- | :--- |
| a | `bot_offline` 事件在**反向 WS**（我们默认拓扑）下是否同样投递（官方文档未区分传输方式） |
| b | `nc_get_user_status` 的返回字段与限流特性（是否可高频轮询） |
| c | `ocr_image` 与 `.ocr_image` 的实际质量/延迟/是否依赖外部服务 |
| d | `download_file` 是否支持 QQ 内部 CDN 的鉴权 URL（还是只支持公网 URL） |
| e | `message_sent` 事件是否会**把机器人自己发的消息也回传**（可能与"回声"混淆，需去重） |
| f | `get_online_clients` 能否可靠区分"主人手动登录"与"机器人进程登录" |
