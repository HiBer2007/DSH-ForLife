<script setup lang="ts">
/**
 * 「建设中」页 —— 对**尚未实现**的页面给出诚实的说明。
 *
 * 为什么不做成空白或假数据：这一版外壳先把导航与主题立起来，
 * 六个数据页在后续阶段填。与其画一堆假数字，不如明确写出"这页要放什么、数据从哪来"，
 * 这样你一眼能看出进度，也不会把假数据当成真的。
 */
import { computed } from 'vue'
import { useRoute } from 'vue-router'

import AppIcon from '../components/AppIcon.vue'

/** 每个待建页的说明：要放什么、数据来源、属于哪个阶段。 */
const NOTES: Record<string, { readonly plans: readonly string[]; readonly source: string; readonly phase: string }> = {
  conversations: {
    plans: [
      '每个会话的积压深度、最近一轮时间、轮次耗时分布',
      '待读池（对方在我方忙碌时说的话）的条数与最旧一条的年龄',
      '出站队列（发不出去的消息）与失败原因，可重发',
      '按会话下钻：这条会话最近的往返记录',
    ],
    source: '/api/admin/conversations ← gateway 直接读 SQLite（与 DSH 内嵌面板同一套语义）',
    phase: '阶段 B',
  },
  wake: {
    plans: [
      '唤醒规则总表：按会话类型分组（私聊/临时会话/群聊/不分类型），显示生效值与来源（默认 / 该会话覆盖）',
      '唤醒判定留痕：为什么醒、为什么没醒（拒绝了哪条规则）',
      '自唤醒触发器列表：定时/文件/系统事件，含下次触发时间与失败退避状态',
      '一键全局暂停（立即生效）',
    ],
    source: '/api/admin/wake ← wake_rules / wake_log / triggers',
    phase: '阶段 B',
  },
  memory: {
    plans: [
      '三层视图：L1 窗口 / L2 长期 / L3 中期，各自的条目表与 token 占比',
      '单条entry：内容、来源（模型写入 / 压缩产物）、epoch、命中次数、最后使用时间',
      '检索试验台（对标 AstrBot 的 recall 接口）：输入一段话，看它会召回什么、排序与分数',
      '手动操作：提升到 L2、降级、合并、删除（全部记审计）',
    ],
    source: '/api/admin/memory ← memory_entries / revisits / FTS5',
    phase: '阶段 B',
  },
  compaction: {
    plans: [
      '压缩历史（事务视角）：每次压缩的状态、前后 token、产物条目、回滚原因',
      '前后对比：被压缩掉的原文摘要 vs 新生成的 L3 条目',
      '失败与重试：模型输出不合规时的原始返回（这是排障的关键证据）',
      '手动触发一次压缩（走与自动路径完全相同的引擎）',
    ],
    source: '/api/admin/compaction ← compaction_log / compaction_runs',
    phase: '阶段 B',
  },
  routing: {
    plans: [
      '角色→候选模型有序表（L1/L2/L3/视觉/嵌入/评分器/子代理），可增删改排序',
      '推理端点登记：类型 / 运行模式 / 后端 / baseUrl / 能力（图片、嵌入维度）',
      '端点试跑（真发一次请求，记录真实延迟）与常驻/按需模式切换',
      '路由统计：降级率、按层与来源分布、最近切换与不确定样本',
    ],
    source: '/api/admin/routing ← model_routes / inference_endpoints / routing_log / endpoint_probe_log',
    phase: '阶段 C',
  },
  prompts: {
    plans: [
      '两个槽位（P1 系统提示词 / P2 回答风格）的编辑器，实时字数与 token 估算',
      '预览：最终拼装结果 + 与当前生效版本的 diff + 是否会造成缓存未命中',
      '历史版本与回滚（保留每次修改者与时间）',
      '变量白名单：哪些变量能进稳定前缀、哪些会破坏缓存',
    ],
    source: '/api/admin/prompts ← prompts / prompt_revisions（与 DSH 内嵌面板同一张表）',
    phase: '阶段 C',
  },
  media: {
    plans: [
      '表情库浏览（缩略图墙）、容量与 LRU 状态',
      '按会话/来源的调用统计与"视觉调用节省率"（哈希命中的复用率）',
      '手动上传、打标签、删除',
    ],
    source: '/api/admin/media ← media_assets / media_usages',
    phase: '阶段 D',
  },
  storage: {
    plans: [
      '各表与文件的占用（内存库 / blob / 向量目录 / 日志）',
      '冷热分层状态与迁移任务（可中断、可续传、SHA 校验）',
      '清理入口 cleanup(target)：先预览将删除什么，再执行',
    ],
    source: '/api/admin/storage ← 文件系统统计 + 迁移任务表',
    phase: '阶段 D',
  },
  logs: {
    plans: [
      '实时日志流（SSE，不是 WebSocket）：支持 Last-Event-ID 断线续传',
      '按级别/来源过滤，关键字高亮，暂停与清屏',
      '手机上看日志：默认折叠堆栈，点开看详情',
    ],
    source: '/api/admin/events（SSE）',
    phase: '阶段 D',
  },
}

const route = useRoute()
const note = computed(() => NOTES[String(route.name ?? '')])
</script>

<template>
  <section class="wrap">
    <div class="card">
      <div class="head">
        <span class="badge">建设中</span>
        <h2>{{ String(route.meta.title ?? '该页') }}</h2>
      </div>
      <p class="muted">这一页还没实现。当前版本先把外壳（导航 / 深色模式 / 手机端）与总览做完，
        数据页按下面的顺序填。</p>

      <template v-if="note">
        <h3>这页会放什么</h3>
        <ul class="plans">
          <li v-for="(line, index) in note.plans" :key="index">
            <AppIcon name="check" :size="14" />
            <span>{{ line }}</span>
          </li>
        </ul>
        <dl class="meta">
          <div>
            <dt>数据来源</dt>
            <dd class="mono">{{ note.source }}</dd>
          </div>
          <div>
            <dt>计划阶段</dt>
            <dd>{{ note.phase }}</dd>
          </div>
        </dl>
      </template>
    </div>
  </section>
</template>

<style scoped>
.wrap {
  max-width: 820px;
}
.card {
  display: flex;
  flex-direction: column;
  gap: var(--s-4);
  padding: var(--s-5);
  background: var(--c-surface);
  border: 1px solid var(--c-border);
  border-radius: var(--r-lg);
}
.head {
  display: flex;
  align-items: center;
  gap: var(--s-3);
}
.head h2 {
  font-size: var(--t-lg);
}
.badge {
  padding: 2px 8px;
  border-radius: var(--r-full);
  background: var(--c-warn-soft);
  color: var(--c-warn);
  font-size: var(--t-xs);
  font-weight: 600;
}
h3 {
  font-size: var(--t-base);
  color: var(--c-text-2);
}
.plans {
  display: flex;
  flex-direction: column;
  gap: var(--s-2);
  list-style: none;
}
.plans li {
  display: flex;
  align-items: flex-start;
  gap: var(--s-2);
  color: var(--c-text-2);
}
.plans svg {
  flex: none;
  margin-top: 4px;
  color: var(--c-ok);
}
.meta {
  display: flex;
  flex-direction: column;
  gap: var(--s-3);
  padding-top: var(--s-3);
  border-top: 1px solid var(--c-border);
}
.meta div {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.meta dt {
  color: var(--c-text-3);
  font-size: var(--t-xs);
}
.meta dd {
  color: var(--c-text-2);
  word-break: break-all;
}
</style>
