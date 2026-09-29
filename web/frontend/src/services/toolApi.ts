import instance from './request'
import type { Tool, ToolCreateRequest, ToolListResponse } from '@/types/tool'

export async function fetchTools(params?: {
  source?: string
  category?: string
  status?: string
  keyword?: string
  page?: number
  page_size?: number
}): Promise<ToolListResponse> {
  const res = await instance.get('/tools/list', { params })
  return res.data.data as ToolListResponse
}

export async function fetchTool(id: string): Promise<Tool> {
  const res = await instance.get(`/tools/${id}`)
  return res.data.data as Tool
}

export async function createTool(data: ToolCreateRequest): Promise<Tool> {
  const res = await instance.post('/tools', data)
  return res.data.data as Tool
}

export async function updateTool(id: string, data: Partial<ToolCreateRequest>): Promise<Tool> {
  const res = await instance.put(`/tools/${id}`, data)
  return res.data.data as Tool
}

export async function deleteTool(id: string): Promise<{ deleted: boolean; id: string }> {
  const res = await instance.delete(`/tools/${id}`)
  return res.data.data as { deleted: boolean; id: string }
}

export async function toggleTool(id: string, enabled: boolean): Promise<Tool> {
  const res = await instance.patch(`/tools/${id}/toggle`, { enabled })
  return res.data.data as Tool
}

/** 可选的工具类型（来自「参数配置」的 tool_type 分组，未配置时为空列表） */
export async function fetchToolTypes(): Promise<{ value: string; label: string }[]> {
  const res = await instance.get('/tools/types')
  return (res.data.data ?? []) as { value: string; label: string }[]
}
