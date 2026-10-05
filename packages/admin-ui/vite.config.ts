/**
 * 前端构建配置。
 *
 * 两个关键点：
 *  1. `base: '/admin/'` —— 产物挂在 gateway 的 `/admin` 下（Caddy 只反代这一个前缀），
 *     所以资源引用必须是绝对前缀路径，不能是 `/assets/...`。
 *  2. `outDir: 'dist'` —— gateway 直接从 `packages/admin-ui/dist` 读文件提供静态服务；
 *     镜像里这份 dist 由多阶段构建拷进去（不参与 Node 侧运行）。
 *
 * 开发期用 `vite dev`，`/api/admin` 由 dev server 代理到本机 gateway（8081），
 * 这样前端热更新与真实接口可以同时用。
 */
import { fileURLToPath, URL } from 'node:url'

import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

export default defineConfig({
  base: '/admin/',
  plugins: [vue()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // 目标浏览器：手机端 Safari/Chrome 近几年版本都支持 ES2020+，不必为老浏览器降级
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 800,
  },
  server: {
    port: 5273,
    proxy: {
      '/api/admin': {
        target: 'http://127.0.0.1:8081',
        changeOrigin: false,
      },
    },
  },
})
