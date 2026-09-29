/**
 * 「类型」筛选项 —— 四个页面（专家 / 工具 / 技能 / MCP 服务）共用的取数逻辑。
 *
 * 这些页面的类型清单**唯一来源是「参数配置」**：各域后端提供一个只要求登录的
 * 读接口（`/api/experts/categories`、`/api/tools/types`、`/api/skill/types`、
 * `/api/mcp/types`），由它们去读对应的参数分组。所以页面上不做任何硬编码兜底——
 * 管理员没配置时筛选就是空的。
 *
 * 用法：
 *   const { options, load } = useParamTypes(fetchToolTypes)
 *   onMounted(load)
 */
import { ref } from 'vue'

/** 筛选项：value 是写进业务表 category 字段的编码，label 是展示名 */
export interface TypeOption {
  value: string
  label: string
}

/** 各域接口的返回形状归一化后都是 { value, label } 列表 */
export type TypeOptionLoader = () => Promise<TypeOption[]>

export function useParamTypes(loader: TypeOptionLoader) {
  const options = ref<TypeOption[]>([])
  const loading = ref(false)

  /** 取一次类型清单；失败时保持为空（页面筛选退化成只有「全部」），不抛异常 */
  async function load(): Promise<void> {
    loading.value = true
    try {
      options.value = await loader()
    } catch {
      options.value = []
    } finally {
      loading.value = false
    }
  }

  return { options, loading, load }
}
