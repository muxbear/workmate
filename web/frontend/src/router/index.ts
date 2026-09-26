import { createRouter, createWebHistory } from 'vue-router'
import type { RouteRecordRaw } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { usePermissionStore } from '@/stores/permission'

const MainLayout = () => import('@/components/MainLayout.vue')

const routes: RouteRecordRaw[] = [
  {
    path: '/',
    component: MainLayout,
    meta: { requiresAuth: true },
    children: [
      {
        path: '',
        redirect: '/overview',
      },
      {
        path: 'chat',
        name: 'chat',
        component: () => import('@/views/HomeView.vue'),
        meta: { title: '对话', permKey: 'chat:conversation' },
      },
      {
        path: 'overview',
        name: 'overview',
        component: () => import('@/views/OverviewView.vue'),
        meta: { title: '概览', permKey: 'control:overview' },
      },
      {
        path: 'skills',
        name: 'skills',
        component: () => import('@/views/SkillsView.vue'),
        meta: { title: 'Skills', permKey: 'agent:skills' },
      },
      {
        path: 'tools',
        name: 'tools',
        component: () => import('@/views/ToolsView.vue'),
        meta: { title: 'Tools', permKey: 'agent:tools' },
      },
      {
        path: 'agents',
        name: 'agents',
        component: () => import('@/views/AgentsView.vue'),
        meta: { title: '代理管理中心', permKey: 'agent:manage' },
      },
      {
        path: 'experts',
        name: 'experts',
        component: () => import('@/views/ExpertView.vue'),
        meta: { title: '专家', permKey: 'agent:expert' },
      },
      {
        path: 'models',
        name: 'models',
        component: () => import('@/views/ModelsView.vue'),
        meta: { title: '模型', permKey: 'agent:models' },
      },
      {
        path: 'scheduled-tasks',
        name: 'scheduled-tasks',
        component: () => import('@/views/ScheduledTasksView.vue'),
        meta: { title: '定时任务', permKey: 'control:scheduled' },
      },
      {
        path: 'knowledge-base',
        name: 'knowledge-base',
        component: () => import('@/views/KnowledgeBaseView.vue'),
        meta: { title: '知识库', permKey: 'knowledge:base' },
      },
      {
        path: 'mcp',
        name: 'mcp-square',
        component: () => import('@/views/McpSquareView.vue'),
        meta: { title: 'MCP 广场', permKey: 'mcp:square' },
      },
      {
        path: 'mcp/:id',
        name: 'mcp-detail',
        component: () => import('@/views/McpDetailView.vue'),
        meta: { title: 'MCP 详情', permKey: 'mcp:square' },
      },
      {
        path: 'admin/users',
        name: 'admin-users',
        component: () => import('@/views/UserManagementView.vue'),
        meta: { title: '人员管理', permKey: 'admin:users' },
      },
      {
        path: 'admin/rbac',
        name: 'admin-rbac',
        component: () => import('@/views/RbacView.vue'),
        meta: { title: '角色权限', permKey: 'admin:rbac' },
      },
      {
        path: 'admin/resources',
        name: 'admin-resources',
        component: () => import('@/views/ResourceManagementView.vue'),
        meta: { title: '资源管理', permKey: 'admin:resources' },
      },
      {
        path: 'admin/org',
        name: 'admin-org',
        component: () => import('@/views/OrgDeptView.vue'),
        meta: { title: '机构部门', permKey: 'admin:org' },
      },
      {
        path: 'admin/accounts',
        name: 'admin-accounts',
        component: () => import('@/views/AccountManagementView.vue'),
        meta: { title: '账号管理', permKey: 'admin:accounts' },
      },
      {
        path: 'admin/announcements',
        name: 'admin-announcements',
        component: () => import('@/views/AnnouncementView.vue'),
        meta: { title: '公告管理', permKey: 'admin:announcements' },
      },
      {
        path: 'admin/params',
        name: 'admin-params',
        component: () => import('@/views/ParamConfigView.vue'),
        meta: { title: '参数配置', permKey: 'admin:params' },
      },
    ],
  },
  {
    path: '/login',
    component: () => import('@/components/auth/AuthLayout.vue'),
    children: [
      {
        path: '',
        name: 'login',
        component: () => import('@/views/LoginView.vue'),
        meta: { title: '登录', guest: true },
      },
    ],
  },
  {
    path: '/register',
    component: () => import('@/components/auth/AuthLayout.vue'),
    children: [
      {
        path: '',
        name: 'register',
        component: () => import('@/views/RegisterView.vue'),
        meta: { title: '注册', guest: true },
      },
      {
        path: 'email',
        name: 'register-email',
        component: () => import('@/views/EmailRegisterView.vue'),
        meta: { title: '邮箱注册', guest: true },
      },
    ],
  },
  {
    path: '/oauth/callback',
    name: 'oauth-callback',
    component: () => import('@/views/OAuthCallbackView.vue'),
    meta: { title: '第三方登录', guest: true },
  },
  {
    path: '/oauth2/authorize',
    name: 'oauth2-authorize',
    component: () => import('@/views/OAuth2AuthorizeView.vue'),
    meta: { title: '客户端授权' },
  },
  {
    // 链接分享的落地页（迭代 6 T6.3）：**未登录也能打开**（只显示元信息）。
    // 刻意**不加** `meta.guest`——守卫会把已登录用户弹回首页，而"已登录的人点链接"
    // 恰恰是最常见的场景；也不加 requiresAuth（那就只剩登录页可看）。与
    // `/oauth2/authorize` 同类：两边都要能进。
    path: '/share/kb/:token',
    name: 'kb-share-preview',
    component: () => import('@/views/KbSharePreviewView.vue'),
    meta: { title: '知识库分享' },
  },
  {
    path: '/:pathMatch(.*)*',
    name: 'not-found',
    redirect: '/',
  },
]

const router = createRouter({
  history: createWebHistory(),
  routes,
})

// 全局前置守卫
router.beforeEach((to, _from, next) => {
  const authStore = useAuthStore()

  if (to.meta.requiresAuth && !authStore.isAuthenticated) {
    return next({ name: 'login', query: { redirect: to.fullPath } })
  }

  if (to.meta.guest && authStore.isAuthenticated) {
    // 已登录用户访问登录/注册等游客页时，回到根路径（根路径会自动跳转到概览，并按权限回落到首个可访问菜单）
    return next({ path: '/' })
  }

  // Permission check
  const permKey = to.meta.permKey as string | undefined
  if (permKey) {
    const permStore = usePermissionStore()
    if (permStore.loaded && !permStore.hasPermission(permKey)) {
      return next({ path: '/overview' })
    }
  }

  next()
})

// 路由懒加载的模块拉取失败（例如开发服务器依赖预构建缓存失效、发版后旧 chunk 404）时，
// 页面会整片空白。这里做一次性自动刷新，避免用户一直卡在白屏。
const CHUNK_RELOAD_KEY = 'chunk_reload_at'
let chunkReloaded = false

router.onError((error) => {
  const message = error instanceof Error ? error.message : String(error)
  const isChunkLoadError =
    message.includes('Failed to fetch dynamically imported module') ||
    message.includes('error loading dynamically imported module') ||
    message.includes('Importing a module script failed')
  if (!isChunkLoadError || chunkReloaded) return
  chunkReloaded = true
  try {
    const last = Number(window.sessionStorage.getItem(CHUNK_RELOAD_KEY) ?? 0)
    if (Date.now() - last < 10_000) return
    window.sessionStorage.setItem(CHUNK_RELOAD_KEY, String(Date.now()))
  } catch {
    // sessionStorage 不可用时仍然刷新一次
  }
  window.location.reload()
})

export default router
