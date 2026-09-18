/**
 * 桌面端 OAuth2 scope 常量与目录。
 *
 * DESKTOP_SCOPE_CATALOG 与 web/backend/src/api/oauth2/scope_service.py 的 SCOPE_CATALOG 对齐，
 * 供桌面端「授权管理」界面展示；DESKTOP_DEFAULT_SCOPES 为一次授权覆盖全部能力的默认集合，
 * 与 web/backend/src/db/seeds/oauth2_clients_seed.json 中 ke-work-desktop.allowed_scopes 对齐。
 */

/** 读取用户资料（必选，服务端强制保留） */
export const SCOPE_USER_READ = 'user:read'
/** 创建和修改会话（必选，服务端强制保留） */
export const SCOPE_CONVERSATION_WRITE = 'conversation:write'

/** 技能页：读取并同步技能列表 */
export const SCOPE_SKILL_READ = 'skill:read'
/** 专家页：读取并同步专家列表 */
export const SCOPE_EXPERT_READ = 'expert:read'
/** 设置-模型：读取并同步模型提供商和模型 */
export const SCOPE_MODEL_READ = 'model:read'
/** 云端工作：读取智能体配置 */
export const SCOPE_AGENT_READ = 'agent:read'
/** 云端工作：读取会话 */
export const SCOPE_CONVERSATION_READ = 'conversation:read'
/** 云端工作：读取工作区 */
export const SCOPE_WORKSPACE_READ = 'workspace:read'

/** 桌面端可见的 scope 元数据（授权管理界面用） */
export interface DesktopScopeMeta {
  key: string
  label: string
  description: string
  group: string
  /** 必选 scope 不可关闭（服务端会强制保留） */
  required: boolean
}

/** scope 目录（顺序即界面展示顺序） */
export const DESKTOP_SCOPE_CATALOG: readonly DesktopScopeMeta[] = [
  {
    key: SCOPE_USER_READ,
    label: '读取用户资料（昵称、头像）',
    description: '用于展示你的账号信息，登录必需',
    group: '账号',
    required: true
  },
  {
    key: SCOPE_CONVERSATION_WRITE,
    label: '创建和修改会话',
    description: '云端工作模式下新建或修改会话必需',
    group: '会话',
    required: true
  },
  {
    key: SCOPE_CONVERSATION_READ,
    label: '读取会话',
    description: '关闭后云端会话列表不可用',
    group: '会话',
    required: false
  },
  {
    key: SCOPE_WORKSPACE_READ,
    label: '读取工作区',
    description: '关闭后云端工作区不可用',
    group: '工作区',
    required: false
  },
  {
    key: SCOPE_AGENT_READ,
    label: '读取智能体配置',
    description: '关闭后云端智能体配置不可用',
    group: '智能体',
    required: false
  },
  {
    key: SCOPE_SKILL_READ,
    label: '读取并同步技能列表',
    description: '关闭后技能页无法从 Web 端同步技能',
    group: '技能',
    required: false
  },
  {
    key: SCOPE_EXPERT_READ,
    label: '读取并同步专家列表',
    description: '关闭后专家页无法从 Web 端同步专家',
    group: '专家',
    required: false
  },
  {
    key: SCOPE_MODEL_READ,
    label: '读取并同步模型提供商和模型',
    description: '关闭后设置中的模型无法从 Web 端同步',
    group: '模型',
    required: false
  }
]

/** 桌面端默认权限集合（登录时一次申请，覆盖所有需要 Web OAuth2 的入口） */
export const DESKTOP_DEFAULT_SCOPES: readonly string[] = DESKTOP_SCOPE_CATALOG.map(
  (scope) => scope.key
)
