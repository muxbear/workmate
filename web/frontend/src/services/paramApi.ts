import instance from './request'
import type { ParamItem, ParamPayload, ParamReorderScope } from '@/types/param'

export async function fetchParentParams(keyword?: string): Promise<ParamItem[]> {
  const res = await instance.get('/params/parents', {
    params: keyword ? { keyword } : undefined,
  })
  return res.data.data
}

export async function fetchChildrenParams(parentCode: string): Promise<ParamItem[]> {
  const res = await instance.get('/params/' + encodeURIComponent(parentCode) + '/children')
  return res.data.data
}

export async function createParam(payload: ParamPayload): Promise<ParamItem> {
  const res = await instance.post('/params', payload)
  return res.data.data
}

export async function updateParam(id: string, payload: ParamPayload): Promise<ParamItem> {
  const res = await instance.put('/params/' + id, payload)
  return res.data.data
}

export async function deleteParam(id: string): Promise<{ deleted: number }> {
  const res = await instance.delete('/params/' + id)
  return res.data.data
}

export async function reorderParams(payload: {
  scope: ParamReorderScope
  parentCode: string | null
  ids: string[]
}): Promise<ParamItem[]> {
  const res = await instance.put('/params/reorder', payload)
  return res.data.data
}
