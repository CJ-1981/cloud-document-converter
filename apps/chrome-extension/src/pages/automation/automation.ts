import { createApp } from 'vue'
import { VueQueryPlugin } from '@tanstack/vue-query'
import { i18n } from '@/pages/shared/i18n'
import App from './automation.vue'
import { initTheme } from '../shared/theme'
import '../shared/shared.css'
import './automation.css'

createApp(App).use(i18n).use(VueQueryPlugin).mount('#app')

initTheme()
