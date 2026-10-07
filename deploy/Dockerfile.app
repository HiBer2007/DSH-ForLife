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

# pnpm 用 corepack（与根 package.json 的 packageManager 字段一致）
RUN corepack enable

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

WORKDIR /app

# ★ **装 dsh CLI** —— compose 里 `dsh` 服务的命令是 `dsh --profile ...`，
# 而 **dsh 是全局命令，不是仓库里的文件**。
#
# **不挂宿主的 dsh**：那样镜像就不可移植了（宿主版本一变，容器行为就变）。
# 装进镜像 ⇒ 版本由这个 Dockerfile 决定，**可复现**。
#
# ⚠️ **这一步要构建时能访问 npm registry** —— 我**没能验证**
# （本机连不上 Docker Hub，更别说在容器里跑 install）。
RUN pnpm add -g dsh@0.1.7-rc.2

# 只带**运行需要的东西**：清单 + 依赖 + 源码 + 前端产物。
# **不带** devDependencies（`--prod`）、不带构建缓存。
COPY --from=build /build/package.json /build/pnpm-lock.yaml /build/pnpm-workspace.yaml ./
COPY --from=build /build/packages ./packages
RUN pnpm install --frozen-lockfile --prod && pnpm store prune

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
