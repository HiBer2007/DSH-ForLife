/**
 * 前端入口。
 *
 * 只做三件事：挂全局样式、装路由、挂载应用。任何"业务逻辑"都不该出现在这里。
 */
import { createApp } from 'vue'

import App from './App.vue'
import { router } from './router.ts'
import './styles/base.css'

createApp(App).use(router).mount('#app')
