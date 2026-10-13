<script setup lang="ts">
/**
 * 喂食记忆 —— 手动把资料交给 AI 记住。
 *
 * 这一页要回答的问题：
 *  1. **喂什么、记成什么**：知识（长期记忆，以后靠检索想起来）还是经历（中期记忆，参与当下上下文）；
 *  2. **这一下会发生什么**：先"预览"（dry-run，一个字都不写）再"喂食"；
 *  3. **喂完怎么反悔**：删除**不走这一页** —— 去「记忆条目」页按来源（feed:…）过滤后归档。
 *     归档不是真删（记忆是不可再生数据），这跟面板其它地方是同一条规矩。
 *
 * 刻意**只有粘贴框**，没有文件上传：大文件走命令行（`node scripts/feed-memory.ts <目录>`），
 * 那里能递归扫目录、还能按来源重导。浏览器这边只做"一段一段地喂"，
 * 而且受接口请求体上限（64 KB）约束 —— 这一点直接写在页面上，别让人喂到一半才发现。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { RouterLink } from 'vue-router'

import { api } from '../api/client.ts'
import type { FeedKind, FeedResponse, FeedResultView } from '../api/types-feed.ts'
import PanelCard from '../components/PanelCard.vue'
import StatCard from '../components/StatCard.vue'
import StatusBadge from '../components/StatusBadge.vue'
import { formatNumber } from '../utils/format.ts'

const text = ref('')
const source = ref('')
const kind = ref<FeedKind>('knowledge')
const busy = ref(false)
const notice = ref<{ tone: 'ok' | 'err'; text: string }>()
const result = ref<FeedResultView>()

/** 一次喂食请求体上限（与后端 `MAX_BODY_BYTES` 同一个数：64 KB）。 */
const BODY_LIMIT_KB = 64

const bytes = computed(() => new TextEncoder().encode(text.value).length)
const tooBig = computed(() => bytes.value > BODY_LIMIT_KB * 1024)
const canSubmit = computed(() => !busy.value && text.value.trim() !== '' && !tooBig.value)

/** 目标值 → 人话。 */
const KINDS: readonly { readonly value: FeedKind; readonly label: string; readonly hint: string }[] = [
  { value: 'knowledge', label: '知识（长期）', hint: '事实、资料、结论：以后要靠检索想起来，不会被压缩掉' },
  { value: 'experience', label: '经历（中期）', hint: '发生过的事：参与当前上下文，会被压缩成碎片' },
]

async function submit(dryRun: boolean): Promise<void> {
  if (!canSubmit.value) return
  busy.value = true
  notice.value = undefined
  result.value = undefined
  try {
    const response = await api.post<FeedResponse>('/feed', {
      items: [{ content: text.value }],
      as: kind.value,
      ...(source.value.trim() === '' ? {} : { source: source.value.trim() }),
      ...(dryRun ? { dryRun: true } : {}),
    })
    result.value = response.result
    notice.value = {
      tone: 'ok',
      text: dryRun
        ? '这是预览：一个字都没写。确认无误后点「喂食」。'
        : `已喂入（来源 ${response.result.source}）。`,
    }
  } catch (error) {
    // **必须显示错误**：静默失败会让人以为内容已经进去了
    notice.value = { tone: 'err', text: error instanceof Error ? error.message : String(error) }
  } finally {
    busy.value = false
  }
}

const ACTION_LABEL: Record<string, string> = {
  inserted: '新增',
  updated: '更新',
  unchanged: '未改动',
  duplicate: '判重跳过',
  archived: '归档',
  planned: '预览',
}

function actionLabel(action: string): string {
  return ACTION_LABEL[action] ?? action
}

function actionTone(action: string): 'ok' | 'warn' | 'muted' | 'info' {
  if (action === 'inserted' || action === 'updated') return 'ok'
  if (action === 'duplicate') return 'warn'
  if (action === 'archived') return 'muted'
  return 'info'
}

/** 预览时"本来会做什么"（真实计数在 dry-run 下都是 0，别把它显示成"什么都不会发生"）。 */
function planned(action: string): number {
  return result.value?.details.filter((row) => row.wouldBe === action).length ?? 0
}

// ── ★ 模型驱动投喂（`FIX_PLAN.md` §21/§23）────────────────────────────────
//
// 与上面那块**根本不同**：
//  - 上面是**内容驱动**：你把文本交上来，我们直接写库（一批就完了）
//  - 这里是**模型驱动**：我们只登记"要喂这一份素材"（每段一个**可读路径**），
//    然后**以轮次为界**一段一段地喂 —— 模型自己去 `read`、自己决定记成什么，
//    每一轮结束再传下一批（单轮上限 30 分钟），中途断了下次接着喂（断点续传）。
//
// ⚠️ 面板这一块**只负责"开始"**：开始之后是**轮次**在推进，进度看下面的
//    "已投喂 N/M 段"（那来自游标）。**它不是一个跑完就返回的请求。**
const runDir = ref('')
const runKind = ref<FeedKind>('experience')
const runPerTurn = ref(20)
const runBusy = ref(false)
const runNotice = ref<{ tone: 'ok' | 'err'; text: string }>()
const runInfo = ref<{
  readonly source: string
  readonly kind: FeedKind
  readonly perTurn: number
  readonly segments: number
  readonly first: string | null
  readonly fedThrough: number
}>()

/**
 * **实时**进度（来自 `GET /feed-run`）。
 *
 * ⚠️ 开始那个 POST 返回的只是"**开始那一刻**"的快照 —— 投喂是**以轮次为界**
 * 推进的，喂了几轮之后那个数字就不动了，而用户会**以为卡住了**。所以这里轮询。
 */
interface FeedRunProgress {
  readonly active: boolean
  readonly source?: string
  readonly kind?: FeedKind
  readonly perTurn?: number
  readonly segments?: number
  readonly fedThrough?: number
  readonly pending?: number
  readonly done?: boolean
  readonly next?: { readonly from: number; readonly to: number } | null
  readonly lastSegment?: string | null
}
const progress = ref<FeedRunProgress>()

/** 轮询间隔：投喂是"一轮几分钟"量级的事，3 秒足够，也不至于把面板变成压测工具。 */
const POLL_MS = 3000
let pollTimer: number | undefined

async function refreshProgress(): Promise<void> {
  try {
    const next = await api.get<FeedRunProgress>('/feed-run')
    progress.value = next
    // 喂完了就停 —— 没必要一直问（她不会自己再开始）
    if (next.active !== true || next.done === true) stopPolling()
  } catch {
    // 读数失败不打扰用户：下一轮会补上（这一页别因为读数坏掉就不能用）
  }
}

function startPolling(): void {
  if (pollTimer !== undefined) return
  pollTimer = window.setInterval(() => void refreshProgress(), POLL_MS)
}

function stopPolling(): void {
  if (pollTimer !== undefined) {
    window.clearInterval(pollTimer)
    pollTimer = undefined
  }
}

// 打开页面就问一次：**她可能正在投喂**（上一轮、或另一个页面开始的）
onMounted(() => {
  void refreshProgress().then(() => {
    if (progress.value?.active === true && progress.value.done !== true) startPolling()
  })
})
onBeforeUnmount(stopPolling)

/** 进度那一行的话（把三种状态说清，别让人对着一堆数字猜）。 */
const progressLine = computed(() => {
  const p = progress.value
  if (p === undefined) return ''
  if (p.active !== true) return '现在没有在投喂。'
  const total = p.segments ?? 0
  const fed = p.fedThrough ?? 0
  if (p.done === true) return `投喂完成：${formatNumber(fed)}/${formatNumber(total)} 段。`
  const next = p.next ?? null
  const range = next === null ? '' : `，本轮第 ${formatNumber(next.from)}–${formatNumber(next.to)} 段`
  return `已投喂 ${formatNumber(fed)}/${formatNumber(total)} 段（还剩 ${formatNumber(p.pending ?? 0)} 段${range}）`
})

const canStartRun = computed(
  () => !runBusy.value && runDir.value.trim() !== '' && runPerTurn.value >= 1,
)

/**
 * 来源名：用户填了就用，没填就**从目录名推**。
 *
 * ★ 为什么必须有它（不能让后端自己编）：来源名是**运行 / 游标 / 会话三条线的关联键**
 * —— "这份素材喂到第几段"就是按它记的。空的话后端会拒（那是刻意的）。
 * 而推出来的名字**会显示在下面的结果里**，所以不是"偷偷替用户决定"。
 */
const effectiveSource = computed(() => {
  const typed = source.value.trim()
  if (typed !== '') return typed
  const dir = runDir.value.trim().replace(/[/\\]+$/, '')
  return dir.split(/[/\\]/).pop() ?? ''
})

async function startRun(): Promise<void> {
  if (!canStartRun.value) return
  runBusy.value = true
  runNotice.value = undefined
  runInfo.value = undefined
  try {
    const response = await api.post<{
      readonly source: string
      readonly kind: FeedKind
      readonly perTurn: number
      readonly segments: number
      readonly first: string | null
      readonly fedThrough: number
    }>('/feed-run', {
      // ★ 来源名缺省**从目录名推**（见 `effectiveSource`）——
      //   它是运行/游标/会话三条线的关联键，空的话后端会拒（那是刻意的）
      source: effectiveSource.value,
      as: runKind.value,
      perTurn: runPerTurn.value,
      dir: runDir.value.trim(),
    })
    runInfo.value = response
    // ★ 开始之后**打开轮询** —— 否则面板上的数字会停在"开始那一刻"不动
    startPolling()
    void refreshProgress()
    runNotice.value = {
      tone: 'ok',
      text:
        `已登记 ${formatNumber(response.segments)} 段 —— 从现在起每一轮喂一批。` +
        '下面的进度每 3 秒自己更新（它跟着游标走）。',
    }
  } catch (error) {
    runNotice.value = { tone: 'err', text: error instanceof Error ? error.message : String(error) }
  } finally {
    runBusy.value = false
  }
}
</script>

<template>
  <div class="page">
    <!-- ★ 模型驱动投喂（`FIX_PLAN.md` §21/§23）。放在最前面：它是**主力**路径 ——
         手工喂一段（下面那块）是"补一句"用的，而这一块才是"把一整份资料交给她"。 -->
    <PanelCard
      title="开始投喂（一段一段来）"
      subtitle="登记一份分段素材，之后每一轮喂一批 —— 她自己读、自己决定记成什么；断了下次接着喂"
    >
      <form class="form" @submit.prevent="startRun()">
        <label class="field">
          <span>素材目录（一段一个文本文件，按文件名里的数字排序）</span>
          <input
            v-model="runDir"
            type="text"
            placeholder="例如 /data/dsh/forlife/chat-feed-v2"
            autocomplete="off"
          />
        </label>

        <label class="field">
          <span>记成什么</span>
          <select v-model="runKind">
            <option v-for="option in KINDS" :key="option.value" :value="option.value">
              {{ option.label }}
            </option>
          </select>
        </label>

        <label class="field">
          <span>每轮几段（一轮结束传下一批；单轮上限 30 分钟）</span>
          <input v-model.number="runPerTurn" type="number" min="1" max="200" />
        </label>

        <p class="hint">
          来源名：<strong>{{ effectiveSource === '' ? '（还没填目录）' : effectiveSource }}</strong>
          —— 它决定"这份素材喂到第几段"记在谁名下；填了上面的「来源」就用你填的，否则从目录名推。
        </p>

        <div class="actions">
          <button type="submit" class="btn primary" :disabled="!canStartRun">
            {{ runBusy ? '正在登记…' : '开始投喂' }}
          </button>
        </div>
      </form>

      <p v-if="runNotice" :class="['notice', runNotice.tone]">{{ runNotice.text }}</p>

      <!-- ★ **实时**进度（轮询 `GET /feed-run`）—— 不是"开始那一刻"的快照。
           喂了几轮之后上面的提示不动了，但这里会跟着游标走。 -->
      <div v-if="progress?.active === true" class="result">
        <StatCard label="已投喂" :value="formatNumber(progress.fedThrough ?? 0)" />
        <StatCard label="待投喂" :value="formatNumber(progress.pending ?? 0)" />
        <StatCard label="每轮" :value="formatNumber(progress.perTurn ?? 0)" />
        <p class="hint">{{ progressLine }}</p>
        <p class="hint">
          来源 <code>{{ progress.source }}</code> · 记成
          {{ progress.kind === 'knowledge' ? '知识（长期）' : '经历（中期）' }}
          <template v-if="progress.lastSegment"> · 最后一段 <code>{{ progress.lastSegment }}</code></template>
        </p>
      </div>
      <p v-else-if="progress !== undefined" class="hint">{{ progressLine }}</p>

      <!-- 开始那个请求的应答（"登记了什么"）—— 与上面的实时进度是两件事 -->
      <div v-if="runInfo" class="result">
        <StatCard label="已登记段数" :value="formatNumber(runInfo.segments)" />
        <StatCard label="开始时的进度" :value="formatNumber(runInfo.fedThrough)" />
        <p class="hint">
          第一段：<code>{{ runInfo.first ?? '（没有）' }}</code>
        </p>
      </div>
    </PanelCard>

    <PanelCard title="喂食记忆" subtitle="把一段资料亲手交给它 —— 走的是与聊天记忆完全相同的沉降路径">
      <form class="form" @submit.prevent="submit(false)">
        <label class="field">
          <span>资料内容（一段一段喂；空行会被当成段落分界）</span>
          <textarea
            v-model="text"
            class="editor"
            rows="10"
            placeholder="粘贴要它记住的资料。写成自足的段落：将来单独看到也能懂。"
          />
        </label>

        <div class="row">
          <div class="segmented" role="radiogroup" aria-label="记成什么">
            <button
              v-for="option in KINDS"
              :key="option.value"
              type="button"
              role="radio"
              :aria-checked="kind === option.value"
              :data-active="kind === option.value"
              :title="option.hint"
              @click="kind = option.value"
            >
              {{ option.label }}
            </button>
          </div>
          <label class="field grow">
            <span>来源（可选；同一个来源 = 同一份东西，再喂一次会更新它）</span>
            <input v-model="source" type="text" placeholder="例如 docs/部署笔记.md" />
          </label>
        </div>

        <p class="muted hint">
          {{ KINDS.find((option) => option.value === kind)?.hint }}
          ·
          <span :class="{ over: tooBig }">{{ formatNumber(bytes) }} / {{ BODY_LIMIT_KB }} KB</span>
          字节（接口上限；更大的资料请用命令行 <span class="mono">node scripts/feed-memory.ts &lt;目录&gt;</span>）
        </p>

        <p v-if="notice" class="hint" :class="notice.tone === 'ok' ? 'ok' : 'err'">{{ notice.text }}</p>

        <div class="actions">
          <button type="button" class="btn" :disabled="!canSubmit" @click="submit(true)">预览（不写入）</button>
          <button type="submit" class="btn primary" :disabled="!canSubmit">
            {{ busy ? '处理中…' : '喂食' }}
          </button>
        </div>
      </form>
    </PanelCard>

    <PanelCard
      v-if="result"
      :title="result.dryRun ? '预览结果（一个字都没写）' : '喂食结果'"
      :subtitle="`来源 ${result.source} · 库里的标记 ${result.scope}`"
    >
      <div class="grid grid-4">
        <StatCard
          label="新增"
          :value="formatNumber(result.dryRun ? planned('inserted') : result.inserted)"
          :hint="result.dryRun ? '预览：预计新增' : '写进记忆的段数'"
          tone="ok"
        />
        <StatCard
          label="更新"
          :value="formatNumber(result.dryRun ? planned('updated') : result.updated)"
          hint="同源重导：覆盖已有段落"
        />
        <StatCard
          label="判重跳过"
          :value="formatNumber(result.duplicates)"
          hint="已有记忆里几乎相同的段落"
          :tone="result.duplicates > 0 ? 'warn' : 'neutral'"
        />
        <StatCard
          label="归档"
          :value="formatNumber(result.dryRun ? planned('archived') : result.archived)"
          hint="上一版多出来的段落（可恢复）"
          :tone="result.archived > 0 ? 'warn' : 'neutral'"
        />
      </div>

      <p class="muted hint">
        共 {{ formatNumber(result.chunkCount) }} 段 / 约 {{ formatNumber(result.tokens) }} token<span
          v-if="result.revision !== undefined"
        >
          · 渲染修订号 {{ formatNumber(result.revision) }}（中期记忆会参与下一轮上下文）</span
        >
      </p>

      <ul class="rows">
        <li v-for="(row, index) in result.details" :key="`${row.id}-${String(index)}`" class="row-item">
          <StatusBadge :tone="actionTone(row.action)">{{ actionLabel(row.action) }}</StatusBadge>
          <span class="mono row-id">{{ row.index < 0 ? '上一版' : `第 ${row.index + 1} 段` }}</span>
          <span class="row-reason">{{ row.reason }}</span>
        </li>
      </ul>

      <template #footer>
        <p class="muted legend">
          {{ result.hint }}
          也可以直接去
          <RouterLink to="/memory">「记忆条目」</RouterLink>
          页按来源搜索 <span class="mono">{{ result.scope }}</span> 后归档。
        </p>
      </template>
    </PanelCard>

    <PanelCard title="删除与重导（都不是这一页的按钮）" subtitle="记忆的管理只有一套">
      <p class="muted note">
        **删除**：没有"删除喂进来的东西"这个接口 —— 到「记忆条目」页按来源（<span class="mono">feed:…</span>）过滤后
        <strong>归档</strong>。归档不是真删：记忆是不可再生数据，而且真删会让它引用过的中期条目断链。
      </p>
      <p class="muted note">
        **重导**：用**同一个来源**再喂一次就是"更新那一份东西"（长期记忆逐段更新，多出来的段落自动归档）。
        来源留空时按内容派生 —— 同样的内容重复喂是幂等的，不同的内容互不覆盖。
      </p>
      <p class="muted note">
        **分块与去重不在这里**：段落切分、判重、压缩、碎片化、沉降全都是记忆系统自己的机制
        （这一页只负责把资料递进去），所以喂进来的东西在面板、沉降与召回里和聊天记忆完全一样。
      </p>
    </PanelCard>
  </div>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: var(--s-4);
  max-width: var(--w-content-max);
}

.form {
  display: flex;
  flex-direction: column;
  gap: var(--s-3);
}
.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.field > span {
  color: var(--c-text-3);
  font-size: var(--t-xs);
}
.field input,
.editor {
  width: 100%;
  padding: var(--s-2) var(--s-3);
  background: var(--c-bg);
  border: 1px solid var(--c-border-strong);
  border-radius: var(--r-md);
  color: var(--c-text);
  font-family: inherit;
  font-size: var(--t-sm);
}
.editor {
  line-height: 1.7;
  resize: vertical;
}
.field input:focus,
.editor:focus {
  border-color: var(--c-brand);
  outline: none;
  box-shadow: 0 0 0 3px var(--c-brand-soft);
}

.row {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: var(--s-3);
}
.grow {
  flex: 1 1 240px;
}

.segmented {
  display: inline-flex;
  gap: 2px;
  padding: 2px;
  background: var(--c-surface-2);
  border-radius: var(--r-md);
}
.segmented button {
  min-height: 30px;
  padding: 0 var(--s-3);
  border: none;
  border-radius: var(--r-sm);
  background: transparent;
  color: var(--c-text-3);
  font-size: var(--t-xs);
  cursor: pointer;
}
.segmented button[data-active='true'] {
  background: var(--c-surface);
  color: var(--c-text);
  box-shadow: var(--sh-1);
}

.grid {
  display: grid;
  gap: var(--s-3);
}
.grid-4 {
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
}

.hint {
  margin-top: var(--s-2);
  font-size: var(--t-xs);
  line-height: 1.7;
}
.hint.ok {
  color: var(--c-ok);
}
.hint.err {
  color: var(--c-err, #d9534f);
}
.over {
  color: var(--c-err, #d9534f);
  font-weight: 600;
}

.actions {
  display: flex;
  gap: var(--s-2);
}
.btn {
  min-height: 32px;
  padding: 0 var(--s-3);
  border: 1px solid var(--c-border-strong);
  border-radius: var(--r-md);
  background: transparent;
  color: var(--c-text-2);
  font-size: var(--t-sm);
  cursor: pointer;
}
.btn:hover:not(:disabled) {
  border-color: var(--c-brand);
  color: var(--c-brand);
}
.btn.primary {
  border-color: transparent;
  background: var(--c-brand);
  color: #fff;
}
.btn:disabled {
  opacity: 0.6;
  cursor: default;
}

.rows {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-top: var(--s-3);
  list-style: none;
}
.row-item {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--s-2);
  padding: var(--s-2) 0;
  border-bottom: 1px solid var(--c-border);
}
.row-id {
  color: var(--c-text-3);
  font-size: var(--t-xs);
}
.row-reason {
  color: var(--c-text-2);
  font-size: var(--t-sm);
}

.legend,
.note {
  font-size: var(--t-xs);
  line-height: 1.8;
}
.note {
  margin-bottom: var(--s-2);
}
</style>
