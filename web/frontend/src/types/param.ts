export type ParamType = 'group' | 'string' | 'number' | 'boolean' | 'json'
export type ParamReorderScope = 'parents' | 'children'

export interface ParamItem {
  id: string
  paramCode: string
  parentCode: string | null
  paramLabel: string
  paramName: string
  paramValue: string | null
  paramType: ParamType
  description: string
  childCount: number
  sortOrder: number
  createdAt: string
  updatedAt: string
}

export interface ParamPayload {
  paramCode: string
  parentCode: string | null
  paramLabel: string
  paramName: string
  paramValue: string | null
  paramType: ParamType
  description: string
}

export const PARAM_TYPE_LABELS: Record<ParamType, string> = {
  group: '分组',
  string: '文本',
  number: '数字',
  boolean: '布尔',
  json: 'JSON',
}

export const PARAM_TYPE_CLASSES: Record<ParamType, string> = {
  group: 'type-group',
  string: 'type-string',
  number: 'type-number',
  boolean: 'type-boolean',
  json: 'type-json',
}

export const VALUE_PARAM_TYPES: ParamType[] = ['string', 'number', 'boolean', 'json']

const PARAM_CODE_END = String.fromCharCode(36)
export const PARAM_CODE_PATTERN = new RegExp('^[A-Za-z0-9_.-]+' + PARAM_CODE_END)
