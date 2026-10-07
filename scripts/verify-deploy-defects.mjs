#!/usr/bin/env node
/**
 * 核对「子代理报的 10 处缺陷」是否真的修在了**仓库文件**里。
 *
 * ## 为什么必须"先去注释"
 *
 * 我上一次用 `grep '/app:/app'` 判断缺陷 4 还在 —— **结果匹配到的是注释**：
 *   `# ⚠️ **绝不要挂 `- /app:/app:ro`**（…实测踩到）：`
 * ⇒ **得出了相反的结论**。
 *
 * 这和审计里 S3 抓到的那个"假绿"**是同一个坑**：
 * 消费点扫描把**注释里的键**算成了消费者。
 *
 * ⇒ **判据必须建立在"真正的配置行"上**，所以这里先剥掉注释再匹配。
 */
import { readFileSync } from 'node:fs'

/** 剥掉 YAML/Dockerfile 的整行注释（只处理"行首（可含空白）#"）。 */
function stripComments(text) {
  return text
    .split(/\r?\n/)
    .filter((l) => !/^\s*#/.test(l))
    .join('\n')
}

const compose = stripComments(readFileSync('deploy/docker-compose.yml', 'utf8'))
const dockerfile = stripComments(readFileSync('deploy/Dockerfile.app', 'utf8'))
const daemon = JSON.parse(readFileSync('deploy/docker-daemon.json', 'utf8'))

/** 每条：缺陷号 + 描述 + 判据（在"去注释后"的文本里找）+ 是否"应当存在"。 */
const checks = [
  { n: 1, what: 'docker-daemon.json 不含 _comment（否则 dockerd 拒启）',
    ok: daemon['_comment'] === undefined },
  { n: 1, what: 'docker-daemon.json 保留 registry-mirrors',
    ok: Array.isArray(daemon['registry-mirrors']) && daemon['registry-mirrors'].length > 0 },
  { n: 1, what: 'docker-daemon.json 保留日志轮转',
    ok: daemon['log-driver'] === 'json-file' && daemon['log-opts'] !== undefined },

  { n: 2, what: 'Dockerfile 用 npm i -g（不是 pnpm add -g）',
    ok: dockerfile.includes('npm i -g') && !dockerfile.includes('pnpm add -g') },

  { n: 3, what: '包名带 scope：@deepseek-ai/dsh',
    ok: /npm i -g @deepseek-ai\/dsh@/.test(dockerfile) },

  { n: 4, what: 'compose 里**没有**生效的 `- /app:/app:ro`',
    ok: !/^\s*-\s*\/app:\/app/m.test(compose) },

  { n: 5, what: 'compose 把 profile 目录挂进 DSH_HOME（profiles 查找位置）',
    ok: /profiles/.test(compose) },

  { n: 7, what: 'gateway 有数据库路径（否则库落 /app/.runtime，重建即丢）',
    ok: /FORLIFE_DB|forlife\.sqlite/.test(compose) },

  { n: 8, what: 'dsh 的 healthcheck 探 3080（不是镜像默认的 8081）',
    ok: /3080/.test(compose) },

  { n: 9, what: '镜像里建了 @deepseek-ai 链接（否则组件 import 不到宿主包）',
    ok: /ln -sfn .*@deepseek-ai/.test(dockerfile) },

  { n: 10, what: 'Dockerfile 固定 /app/profiles 属主（防权限随构建漂移）',
    ok: /chown -R node:node \/app\/profiles/.test(dockerfile) },
]

let bad = 0
for (const c of checks) {
  if (c.ok) {
    console.log(`  ✅ 缺陷${String(c.n)}：${c.what}`)
  } else {
    console.log(`  ❌ 缺陷${String(c.n)}：${c.what}`)
    bad += 1
  }
}
console.log('')
console.log(`  合计：${String(checks.length - bad)}/${String(checks.length)} 通过`)
if (bad > 0) process.exitCode = 1
