# DSH-ForLife 应用镜像（多阶段：构建 → 运行）
#
# ## 为什么是多阶段
#
# 前端（`@forlife/admin-ui`）要 **Vite 构建**，而构建产物是静态文件。
# 把整个构建链（Vite + vue-tsc + devDependencies）留在运行镜像里的话：
#  - 镜像大几倍；
#  - **devDependencies 里的东西会进生产**（那是攻击面）。
#
# ## 为什么一个镜像跑两个服务
#
# `dsh` 与 `gateway` **共用同一份代码与同一份 node_modules**
# （gateway 的运行时依赖在同一个 pnpm workspace 里）。
# 打两个镜像的话，**同一份代码会有两个版本**，而它们的契约必须一致 ——
# 那正是"版本漂移"最容易出事的地方。
#
# ⇒ **一个镜像，两个入口**：compose 里用不同的 `command` 起。
#
# ## ⚠️ 我**没能验证**的部分（如实说）
#
# **这个镜像没有被构建过** —— 本机拉不到基础镜像
# （`dialing registry-1.docker.io:443 ... i/o timeout`，没有到 Docker Hub 的网络）。
# 我验的只有：**Dockerfile 语法**、**compose 能解析**、
# 以及**里面引用的路径与命令在本机真实存在**。
# **"真的能 build 出来、能跑起来"没有被验证过。**

# ── 阶段 1：构建 ────────────────────────────────────────────────────────
FROM node:24-alpine AS build

# ★★ 2026-10-07 真机实测（`--no-cache` 冷构建）：**墙钟 33 分 8 秒**，超过「全新部署 ≤30 分钟」。
#
# 根因：**容器里没有镜像源** ⇒ 三次拉取全走 `registry.npmjs.org`：
#   - `npm i -g @deepseek-ai/dsh@0.1.7-rc.2`  → **786 MB，≈15 分钟**
#   - `pnpm install --frozen-lockfile --prod` → **579 秒**（缓存热时只要 55 秒）
#   - `corepack` 下 `pnpm-12.3.4.tgz`

# ⚠️ `pnpm` 到这一步才存在（corepack 装出来的）—— 所以 registry 要**分两次设**：
#   `npm config set` 在第一个 FROM 之后就行，`pnpm config set` 必须在这里。
#   （我第一次把两条写在一起 ⇒ `/bin/sh: pnpm: not found`、构建 exit 127。）
#
# 宿主 `~/.npmrc` 指向 npmmirror，**但容器读不到它**（干净的 node:24-alpine）。
# ⇒ 在这里显式设一次，**对所有后续 RUN 生效**。
#
# 用 `--global`（落 `/usr/local/etc/npmrc`）而不是写 `~/.npmrc`：
# 镜像里跑构建的用户可能不是 root，写文件容易写错位置。
RUN npm config set --global registry https://registry.npmmirror.com

# pnpm 用 corepack（与根 package.json 的 packageManager 字段一致）
RUN corepack enable

# ⚠️ `pnpm` 到**这一步**才存在（上一行 corepack 装出来的）——
#   所以 registry 要**分两次设**：`npm config set` 在第一个 FROM 之后就行，
#   `pnpm config set` 必须在这里。
#   （我第一次把两条写在一起 ⇒ `/bin/sh: pnpm: not found`、构建 exit 127。）
RUN pnpm config set --global registry https://registry.npmmirror.com

WORKDIR /build

# **先只拷清单** —— 依赖没变时这一层能命中缓存，
# 否则每改一行源码都要重装一次依赖
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/contracts/package.json packages/contracts/
COPY packages/store/package.json packages/store/
COPY packages/gateway/package.json packages/gateway/
COPY packages/admin-ui/package.json packages/admin-ui/
COPY packages/dsh-component/package.json packages/dsh-component/

# `--frozen-lockfile`：**锁文件与清单不一致时直接失败**，
# 而不是悄悄装一个"差不多"的版本组合（那样构建不可复现）
RUN pnpm install --frozen-lockfile

# 再拷源码
COPY . .

# 构建前端（产物在 packages/admin-ui/dist）
RUN pnpm -F @forlife/admin-ui build

# ── 阶段 2：运行 ────────────────────────────────────────────────────────
FROM node:24-alpine AS runtime

RUN corepack enable

# ★★ **runtime 阶段必须自己设一遍** —— `FROM` 会开一个**新阶段**，
#   build 阶段的 `npm config set` **不会带过来**。
#   而**最慢的那一步**（`npm i -g @deepseek-ai/dsh`，786 MB、≈15 分钟）就在**这个阶段**。
RUN npm config set --global registry https://registry.npmmirror.com \
 && pnpm config set --global registry https://registry.npmmirror.com

WORKDIR /app

# ★ **装 dsh CLI** —— compose 里 `dsh` 服务的命令是 `dsh --profile ...`，
# 而 **dsh 是全局命令，不是仓库里的文件**。
#
# **不挂宿主的 dsh**：那样镜像就不可移植了（宿主版本一变，容器行为就变）。
# 装进镜像 ⇒ 版本由这个 Dockerfile 决定，**可复现**。
#
# ⚠️ **这一步要构建时能访问 npm registry** —— 我**没能验证**
# （本机连不上 Docker Hub，更别说在容器里跑 install）。
#
# ── 2026-10-07 真机部署时发现的两处错误（已修，实测见报告）───────────────
#
# ❌ 原来写的是 `pnpm add -g dsh@0.1.7-rc.2`，**两处都错**：
#
#  1. **包名少了 scope**。npm 上的 `dsh`（无 scope）**是另一个人的包**
#     （registry 实测只有 `1.0.0` / `1.0.1`，**没有** `0.1.7-rc.2`）。
#     真正的 CLI 是 **`@deepseek-ai/dsh`**（实测有 30 个版本，含 `0.1.7-rc.2`）。
#     仓库自己的 `scripts/setup-dev.ps1:15` 写的就是 `npm i -g @deepseek-ai/dsh`。
#     ⚠️ 就算版本恰好撞上，装进来的也会是**别人的包** —— 这是供应链风险，不只是构建失败。
#
#  2. **`pnpm add -g` 在这里必然失败**（实测原始错误）：
#       Error: ERR_PNPM_GLOBAL_BIN_DIR_NOT_IN_PATH
#         × The configured global bin directory "/root/.local/share/pnpm/bin" is not in PATH
#     pnpm 12 会检查全局 bin 目录在不在 PATH 里，不在就拒绝安装。
#     改用 **npm**（node 镜像自带，装到 /usr/local/bin，天然在 PATH 里）。
RUN npm i -g @deepseek-ai/dsh@0.1.7-rc.2

# 只带**运行需要的东西**：清单 + 依赖 + 源码 + 前端产物。
# **不带** devDependencies（`--prod`）、不带构建缓存。
COPY --from=build /build/package.json /build/pnpm-lock.yaml /build/pnpm-workspace.yaml ./
COPY --from=build /build/packages ./packages

# ★ **profiles 必须带进来**（2026-10-07 真机部署时发现的缺陷：原来没拷）。
#
# 两件事都依赖它：
#   1. `dsh --profile forlife-web` 要能找到这个 profile；
#   2. pnpm workspace 要在 `profiles/forlife-web/node_modules/` 里建出
#      `forlife-memory -> ../../packages/dsh-component` 这条链接 ——
#      而 profile 的 `dsh.profile.bundles` 里就列着 `forlife-memory`。
#      不拷的话 bundle 解析不到，dsh 起不来。
COPY --from=build /build/profiles ./profiles

# ★★ 2026-10-08 修：**把 build 阶段的 pnpm store 复制过来**，然后用 `--prefer-offline` 装。
#
# ## 原来的样子（两个问题一起犯）
#
#     RUN pnpm install --frozen-lockfile --prod && pnpm store prune
#
#   ① **慢**：这一步重新解析+下载全部依赖。实测一个 9.66 MB 的包只跑
#     **17 KiB/s** ⇒ 单这一步就要 ~10 分钟。
#   ② **会直接失败**：报 `failed to lookup address information: Try again`
#     —— 那是 **DNS 解析失败**，不是超时。
#     ⇒ 构建时而好时坏，看起来像“磁盘/网络抽风”，实则每次都在赌 DNS。
#
# ## 为什么复制 store 就能一箭双雕
#
#   build 阶段已经 `pnpm install --frozen-lockfile`（**全量依赖**），
#   store 里已经有所有 tarball。而 `--prod` 要装的是全量的**子集**
#   ⇒ **store 里一定都有**，不需要网络。
#
#   用 `--prefer-offline` 而不是 `--offline`：万一真有一个包 store 里没有，
#   它会**回退到联网**而不是直接报错。宁可慢一点，不要因为一个包就建不出来。
#
#   ★ **不用 `COPY --from=build /build/node_modules`**（那是另一种写法）：
#   那样会把 **devDependencies 也带进运行镜像**，镜像变大得多。
#   复制 store 只多几十 MB，而且 store 在后面 `pnpm store prune` 时会被清掉。
COPY --from=build /root/.local/share/pnpm/store /root/.local/share/pnpm/store
RUN pnpm install --frozen-lockfile --prod --prefer-offline && pnpm store prune

# ★ **让 /app 下的包能解析到宿主 DSH 的包树**（2026-10-07 真机部署实测踩到）。
#
# 我们的组件（`forlife-memory` = `packages/dsh-component`）**不声明** `@deepseek-ai/dsh-*`
# 为依赖 —— 那是刻意的设计（见 EXECUTION_PLAN：声明 peer 会让 pnpm 在有网/无网环境下
# 行为不一致），它靠**宿主 DSH 提供**这些包。
#
# 开发机上这件事由 `scripts/setup-dev.ps1` 做：往仓库根 `node_modules/@deepseek-ai`
# 建一条指向宿主全局安装的 **junction**。镜像里没有这一步 ⇒ 实测原始错误：
#   IMPORT FAIL: ERR_MODULE_NOT_FOUND
#   Cannot find package '@deepseek-ai/schemastery'
#   imported from /app/packages/dsh-component/src/config.ts
# 表现是 dsh 起来了、但**我们自己的三条 entry 全部 failed to import**：
#   forlife-memory (forlife-memory): failed to import
#   forlife-memory-panel (forlife-memory/panel): failed to import
#   forlife-compaction (forlife-memory/compaction): failed to import
#
# ⇒ 在镜像里建同一条链接（目标就是上面 `npm i -g` 装出来的那棵树，283 个包）。
#   **不必把宿主 ~/.dsh 或任何本机路径扯进来** —— 目标在镜像内。
RUN rm -rf /app/node_modules/@deepseek-ai && \
    ln -sfn /usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai /app/node_modules/@deepseek-ai && \
    ls /app/node_modules/@deepseek-ai | wc -l

# ★ **profile 目录必须对 node 可写**（2026-10-07 真机部署实测踩到）。
#
# DSH **每次启动都无条件写** profile 根配置：
#   `writeFileSync(join(profile.dir, 'cordis.yml'), PROFILE_ROOT_CONFIG)`
#   —— `dsh-app-boot/lib/index.js` 的 `prepareProfile()`，没有"存在就跳过"的判断。
#
# 而 profile 是在 `$DSH_HOME/profiles/forlife-web` 被读到的（compose 把那里链到
# `/app/profiles/forlife-web`）⇒ **镜像里那份的属主必须是 node**，否则实测：
#   Error: EACCES: permission denied, open '/data/dsh/profiles/forlife-web/cordis.yml'
#       at writeFileSync (node:fs:2482:20)
#       at prepareProfile (…/dsh-app-boot/lib/index.js:189:2)
#
# ⚠️ 这一条**很容易被"别的构建"打回原形**：目录权限取决于构建上下文里的 mode，
#    重建一次就可能从 777 变成 775 ⇒ 服务从"好的"变成"崩溃重启"。
#    **显式 chown 一次，就跟构建上下文的 mode 无关了。**
RUN chown -R node:node /app/profiles

# 前端静态产物（gateway 从它服务 /admin/）
COPY --from=build /build/packages/admin-ui/dist ./packages/admin-ui/dist

# 数据卷（compose 挂进来）
VOLUME ["/data"]

# ## 两个入口（compose 用 command 选）
#
# **不用 ENTRYPOINT 写死** —— 一个镜像两个服务，写死就变成两个镜像。
#
# 默认起 gateway（它是"对外那一个"，也是健康检查能探到的那个）
ENV FORLIFE_ADMIN_HOST=0.0.0.0
ENV FORLIFE_ADMIN_PORT=8081
EXPOSE 8081

# ★ **命名卷的属主**（2026-10-07 真机部署实测踩到）：
#
# compose 把两个**命名卷**挂在 `/data` 与 `/data/dsh` 上，而 Docker 新建命名卷是
# `root:root`，容器却以 `node`(uid 1000) 跑 ⇒ 实测原始错误：
#   mkdir: can't create directory '/data/dsh/profiles': Permission denied     （dsh）
#   errno: -13, code: 'EACCES', syscall: 'mkdir', path: '/app/.runtime/dsh/forlife/db'  （gateway）
#
# ⇒ 在镜像里**先把这些目录建好并 chown 给 node**。Docker 挂载**空命名卷**时会把
#   镜像里该路径的内容与属主一起"播种"进卷里（非空卷不播种）⇒ 部署侧不需要
#   额外的 chown 步骤，`docker compose up` 就能起来。
RUN mkdir -p /data/dsh /data/tiers/hot /data/tiers/warm && chown -R node:node /data

# **非 root 运行**（node 镜像自带 uid 1000 的 node 用户）
USER node

# 健康检查：gateway 有一个**不需要登录**的存活探测吗？
# ⇒ 用 `/admin/`（静态页，**不碰数据库**）——
#   探数据库的话，库锁住时健康检查会跟着红，而那不是"进程死了"。
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8081/admin/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# 默认入口：gateway
# （dsh 那条在 compose 里覆盖成 `dsh --profile forlife-web --no-open` ——
#  **dsh 是全局 CLI，不是仓库里的文件**，所以那一条依赖镜像里装了 dsh）
CMD ["node", "packages/gateway/src/server.ts"]
