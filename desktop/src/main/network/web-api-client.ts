import type { AxiosInstance, AxiosProgressEvent } from 'axios'
import { createMainHttpClient, toHttpErrorMessage } from './main-http'

/** 桌面端默认 Web 平台地址（四个同步源共用） */
export const DEFAULT_WEB_API_BASE_URL = 'http://127.0.0.1:8001'

/** Web 平台统一响应包裹（code === 0 成功） */
export interface WebApiEnvelope<T> {
  code: number
  data: T
  message: string
}

/** 二进制响应体 → Uint8Array（axios arraybuffer / Buffer 兼容） */
export function toBytes(data: unknown): Uint8Array {
  if (data instanceof Uint8Array) return data
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  throw new Error('响应内容为空')
}

/**
 * Web 平台 HTTP 客户端（同步家族共用）：
 * baseURL 归一化（去尾斜杠）+ envelope 解包 + 错误归一 + 二进制下载。
 * 代理/UA 由 main-http 的统一客户端承担（R8-5），此处不再自建 axios 实例。
 */
export class WebApiClient {
  private readonly http: AxiosInstance

  /** 底层 axios 实例（测试挂 mock adapter 用） */
  readonly axiosInstance: AxiosInstance

  constructor(baseUrl: string, timeoutMs = 15_000) {
    this.http = createMainHttpClient({
      purpose: 'web-api',
      baseURL: (baseUrl || DEFAULT_WEB_API_BASE_URL).replace(/\/+$/, ''),
      timeoutMs
    })
    this.axiosInstance = this.http
  }

  async request<T>(
    method: 'get' | 'post',
    path: string,
    body?: unknown,
    config?: Record<string, unknown>
  ): Promise<T> {
    try {
      const response =
        method === 'post'
          ? await this.http.post<WebApiEnvelope<T>>(path, body, config)
          : await this.http.get<WebApiEnvelope<T>>(path, config)
      const envelope = response.data
      if (envelope.code !== 0) {
        throw new Error(envelope.message || 'Web 服务返回错误')
      }
      return envelope.data
    } catch (error) {
      throw new Error(toHttpErrorMessage(error))
    }
  }

  /** 二进制下载（技能包等）：独立超时与进度回调 */
  async download(
    path: string,
    options: {
      timeoutMs?: number
      headers?: Record<string, string>
      onProgress?: (event: AxiosProgressEvent) => void
    } = {}
  ): Promise<Uint8Array> {
    try {
      const response = await this.http.get<ArrayBuffer>(path, {
        responseType: 'arraybuffer',
        timeout: options.timeoutMs ?? 120_000,
        headers: options.headers,
        onDownloadProgress: options.onProgress
      })
      return toBytes(response.data)
    } catch (error) {
      throw new Error(toHttpErrorMessage(error))
    }
  }
}
