import { createApp } from 'vue'
import { createPinia } from 'pinia'
import ElementPlus from 'element-plus'
import zhCn from 'element-plus/es/locale/lang/zh-cn'
import 'element-plus/dist/index.css'
import 'element-plus/theme-chalk/dark/css-vars.css'
import { MotionPlugin } from '@vueuse/motion'
import App from './App.vue'
import router from './router'
import i18n from './locales'
import { useUiStore } from '@/stores/ui'
import './assets/styles/main.css'

import '@vue-flow/core/dist/style.css'
import '@vue-flow/core/dist/theme-default.css'
import '@vue-flow/controls/dist/style.css'
import '@vue-flow/minimap/dist/style.css'

const app = createApp(App)

app.use(createPinia())
app.use(router)
app.use(i18n)
// 不传 locale 时 Element Plus 会退回英文：分页显示 "Total 12 / 12/page"、
// "Go to previous page"，日期选择器等也全是英文。整个应用是中文的，统一指定 zh-cn。
app.use(ElementPlus, { locale: zhCn })
app.use(MotionPlugin)

useUiStore().initTheme()

app.mount('#app')
