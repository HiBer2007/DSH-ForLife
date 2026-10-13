<script setup lang="ts">
/**
 * 维护：手动执行与调度状态。
 *
 * ## 这一页兑现的是哪句话
 *
 * `ComingSoonView.vue:51` 对用户承诺过：
 * 「手动触发一次压缩（**走与自动路径完全相同的引擎**）」。
 * ★ 兑现它的凭据不是这一页，而是**后端那条 `POST /api/admin/maintenance/run` 调的就是
 * 自动那条 `tick()`** —— 守卫见 `packages/gateway/test/maintenance-manual-trigger-wiring.test.ts`。
 * 这一页只负责"让人按得到那个按钮"，★ 并且**如实显示结果**（跑了什么、搬了几条、失败几条）。
 *
 * ## 三条纪律（照 §52/§76.5④）
 *
 * 1. ★ **没有句柄时如实说"跑不了"** —— 不把按钮画成能点然后回一个空结果；
 * 2. ★ **跑完把 `moved/skipped/failed` 与失败原因摆出来**（"跑了但没生效"要看得见）；
 * 3. ★ 写操作要确认（它会真的搬文件与改索引）。
 */
import { computed, ref } from 'vue'

import { api } from '../api/client.ts'
import type { MaintenanceRunResponse, MaintenanceScope, MaintenanceStatus } from '../api/types-maintenance.ts'
import AsyncSection from '../components/AsyncSection.vue'
import PanelCard from '../components/PanelCard.vue'
import StatCard from '../components/StatCard.vue'
import StatusBadge from '../components/StatusBadge.vue'
import { useAsyncData } from '../composables/useAsyncData.ts'

// ★ 不轮询：维护状态几乎不变，而"刚刚跑了什么"要留在屏幕上给人看。
const state = useAsyncData<MaintenanceStatus>(() => api.get<MaintenanceStatus>('/maintenance'))

const available = computed(() => state.data.value?.available === true)
const status = computed(() => (state.data.value?.available === true ? state.data.value : undefined))
const passive = computed(() => status.value?.passive === true)

const stats = computed(() => {
  const s = status.value
  if (s === undefined) return []
  return [
    { label: '自动维护', value: s.enabled ? '已启用' : '已停用', hint: s.disabledReason ?? `每 ${String(Math.round(s.intervalMs / 1000))} 秒一轮` },
    { label: '节奏', value: s.passive ? '惰性（不排计时器）' : `${String(Math.round(s.intervalMs / 1000))} 秒/轮`, hint: s.passive ? '★ 只能手动催 —— 这正是本页最有用的场景' : '到点自动跑，手动随时可以插一轮' },
    { label: '单轮上限', value: String(s.limit), hint: '一轮最多搬多少条（与自动那条同一条策略）' },
  ]
})

// ── 跑一轮 ──────────────────────────────────────────────────────────
const running = ref<MaintenanceScope | ''>('')
const runError = ref('')
const lastRun = ref<{ scope: MaintenanceScope; at: string; result: MaintenanceRunResponse['result'] }>()

async function run(scope: MaintenanceScope): Promise<void> {
  const label = scope === 'all' ? '全部（沉降 / 碎片维护 / 复盘）' : '只跑碎片维护'
  const warning =
    scope === 'all'
      ? `跑一轮维护：${label}。\n\n这会**立刻搬文件并改索引**（与自动那条完全相同的一套策略）。继续？`
      : `只跑碎片索引的合并与淘汰（${label}）—— 不搬文件。继续？`
  if (!window.confirm(warning)) return

  running.value = scope
  runError.value = ''
  try {
    const body = scope === 'fragments' ? { only: 'fragments' } : {}
    const response = await api.post<MaintenanceRunResponse>('/maintenance/run', body)
    lastRun.value = { scope, at: new Date().toISOString(), result: response.result }
  } catch (error) {
    runError.value = error instanceof Error ? error.message : String(error)
  } finally {
    running.value = ''
  }
}

function fmt(iso: string): string {
  return iso.replace('T', ' ').slice(0, 19)
}

// ── 排队一次压缩（★ 2026-10-13，用户裁定"走二"）──────────────────────
//
// 为什么是"排队"而不是"立刻压"：压缩的**触发器在 DSH 宿主那边**
// （我们只覆写 `compactIfNeeded` 并转调），而工具/接口的上下文里**没有 agent**。
// ⇒ 所以这里做的是往 `forlife_state.acct_pending_compaction` 写一条，
//   宿主的**下一次**压缩检查会用 `context-overflow` 语义强制执行它。
//
// ★★ 这条入口的意义：`compaction_log` 至今 **0 行** ⇒ 压缩从未跑过 ⇒
//   `push_to_mid` 那条路不产生 `entities` ⇒ PLAN §5.3-3 的合并规则一直是死的。
const compactQueued = ref('')
const compactError = ref('')
const compacting = ref(false)

async function requestCompaction(): Promise<void> {
  const warning =
    '排队一次压缩。\n\n' +
    '★ 它不会立刻执行：触发器在 DSH 宿主那边，要有会话在动才会跑（下次压缩检查时执行）。\n' +
    '★ 执行时会真的写数据：往中期记忆追加条目、并可能把条目沉降成长期记忆与碎片。\n\n继续？'
  if (!window.confirm(warning)) return
  compacting.value = true
  compactQueued.value = ''
  compactError.value = ''
  try {
    const response = await api.post<{ queued: boolean; replacedPending: boolean; note: string }>(
      '/maintenance/compact',
      { reason: '面板手动触发' },
    )
    compactQueued.value = response.replacedPending
      ? `已排队（★ 之前那条待执行的被这条覆盖了）。${response.note}`
      : `已排队。${response.note}`
  } catch (error) {
    compactError.value = error instanceof Error ? error.message : String(error)
  } finally {
    compacting.value = false
  }
}
</script>

<template>
  <div class="page">
    <header class="head">
      <h1>维护</h1>
      <p class="muted">
        手动催一轮沉降 / 碎片维护 / 复盘。★ 它调的是
        <span class="mono">自动那条完全相同的 tick()</span>，不是另写一套"整理型"实现 ——
        否则面板点了维护、实际参数与自动不一样，那种偏差极难发现。
      </p>
    </header>

    <AsyncSection
      :loading="state.loading.value"
      :error="state.error.value"
      :updated-at="state.updatedAt.value"
      :skeleton-rows="3"
      @retry="state.refresh()"
    >
      <template #default>
        <!-- ★ 没有句柄：如实说"跑不了"，并且**不画能点的按钮** -->
        <div v-if="!available" class="disabled-note">
          <StatusBadge tone="warn" dot>跑不了</StatusBadge>
          <p>{{ state.data.value?.available === false ? state.data.value.reason : '' }}</p>
          <p class="muted cap">
            这一页需要网关进程握着维护循环句柄（要配 <span class="mono">FORLIFE_ROOT_HOT</span> 并真的启动）。
            ★ 在它到位之前，按钮不出现 —— 而不是让你点了再看一句错误。
          </p>
        </div>

        <template v-else>
          <div class="grid">
            <StatCard v-for="item in stats" :key="item.label" v-bind="item" />
          </div>

          <PanelCard title="手动执行" subtitle="与自动维护走同一条代码路径">
            <div class="bar">
              <button type="button" class="btn primary" :disabled="running !== ''" @click="run('all')">
                {{ running === 'all' ? '跑着…' : '跑一轮维护' }}
              </button>
              <button type="button" class="btn" :disabled="running !== ''" @click="run('fragments')">
                {{ running === 'fragments' ? '跑着…' : '只跑碎片维护' }}
              </button>
              <span v-if="passive" class="muted cap">
                当前为<strong>惰性模式</strong>：自动维护不排计时器。推进维护需在此手动执行，或由模型发起维护请求。
              </span>
            </div>

            <!-- ★★ 2026-10-13（用户裁定"走二"）：压缩的**排队**入口。
                 为什么与上面两个按钮分开：那两个是立即执行本系统的维护，
                 而这一个是"**请宿主**在下次压缩检查时压一次" —— 语义完全不同，
                 混在一起会让人以为点了就压了（那是最容易骗人的地方）。 -->
            <div class="bar">
              <button type="button" class="btn" :disabled="compacting" @click="requestCompaction()">
                {{ compacting ? '排队中…' : '排队一次压缩' }}
              </button>
              <span class="muted cap">
                压缩的触发器在 DSH 宿主那边 ⇒ 这是<strong>排队</strong>，要有会话在动才会执行；
                执行后 <code class="mono">compaction_log</code> 会留下一条记录。
              </span>
            </div>
            <p v-if="compactQueued !== ''" class="muted cap">{{ compactQueued }}</p>
            <p v-if="compactError !== ''" class="edit-error">{{ compactError }}</p>

            <p v-if="runError !== ''" class="edit-error">{{ runError }}</p>

            <div v-if="lastRun !== undefined" class="run-result">
              <p class="muted cap">
                {{ fmt(lastRun.at) }} ·
                {{ lastRun.scope === 'all' ? '全部' : '只跑碎片维护' }} ·
                <StatusBadge tone="ok" dot>已完成</StatusBadge>
              </p>
              <ul class="kv">
                <li>搬运 <span class="mono">{{ lastRun.result.moved }}</span> 条</li>
                <li>跳过 <span class="mono">{{ lastRun.result.skipped }}</span> 条</li>
                <li>
                  失败 <span class="mono">{{ lastRun.result.failed }}</span> 条
                  <span v-if="lastRun.result.failed > 0" class="warn">★ 失败不是"没做"，是"做了但没成"</span>
                </li>
                <li v-if="lastRun.result.fragments !== undefined">
                  碎片：合并 {{ lastRun.result.fragments.merged ? '做了' : '没做' }} · 淘汰
                  {{ lastRun.result.fragments.evicted }} · 拒删 {{ lastRun.result.fragments.refused }} · 孤儿
                  {{ lastRun.result.fragments.orphans }}
                </li>
                <li v-if="lastRun.result.longTerm !== undefined">
                  长期沉降：落下 {{ lastRun.result.longTerm.settled }} · 跳过 {{ lastRun.result.longTerm.skipped }} ·
                  失败 {{ lastRun.result.longTerm.failed }}（冷层 {{ lastRun.result.longTerm.coldRoot }}<template
                    v-if="lastRun.result.longTerm.fellBack"
                  >，★ 已退回热盘</template>）
                </li>
              </ul>
              <ul v-if="lastRun.result.failures.length > 0" class="failures">
                <li v-for="(reason, index) in lastRun.result.failures" :key="index">{{ reason }}</li>
              </ul>
            </div>
            <p v-else class="empty-note">
              还没手动跑过。跑完这里会留下这一轮的数字与失败原因（★ 跑完不留痕的话，
              "点了没反应"和"跑成功了但没东西可搬"就分不开）。
            </p>
          </PanelCard>
        </template>
      </template>
    </AsyncSection>
  </div>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: var(--s-4);
  max-width: var(--w-content-max);
}
.bar {
  display: flex;
  align-items: center;
  gap: var(--s-3);
  flex-wrap: wrap;
  margin-bottom: var(--s-3);
}
.disabled-note {
  display: flex;
  flex-direction: column;
  gap: var(--s-2);
  padding: var(--s-4);
  border: 1px solid var(--c-border);
  border-radius: var(--r-2);
  background: var(--c-surface-2);
}
.run-result {
  display: flex;
  flex-direction: column;
  gap: var(--s-2);
}
.kv {
  display: flex;
  flex-direction: column;
  gap: var(--s-1);
  margin: 0;
  padding-left: var(--s-4);
  list-style: disc;
}
.failures {
  margin: 0;
  padding-left: var(--s-4);
  list-style: disc;
  color: var(--c-warn, #b45309);
}
.warn {
  color: var(--c-warn, #b45309);
}
</style>
