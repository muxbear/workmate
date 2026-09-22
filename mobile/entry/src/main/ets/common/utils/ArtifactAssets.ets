/**
 * 产物取件:带 token 拉取字节 / 解码图片 / 下载到应用沙箱。
 *
 * 说明:产物接口需要 Authorization,因此不能把地址直接交给 Image 组件;
 * 这里统一用 http 拉字节后再渲染或落盘。
 */

import { http } from '@kit.NetworkKit'
import { fileIo } from '@kit.CoreFileKit'
import { image } from '@kit.ImageKit'
import { common } from '@kit.AbilityKit'
import { Constants } from '../constants/Constants'
import { HttpClient } from '../../services/http/HttpClient'

/** 拉取产物字节(图片/文本/zip 通用);失败返回 undefined */
export async function fetchArtifactBytes(url: string): Promise<ArrayBuffer | undefined> {
  const request = http.createHttp()
  const header: Record<string, string> = {}
  const token: string = HttpClient.getInstance().getToken()
  if (token !== '') {
    header['Authorization'] = `Bearer ${token}`
  }
  try {
    const resp = await request.request(url, {
      method: http.RequestMethod.GET,
      header: header,
      expectDataType: http.HttpDataType.ARRAY_BUFFER,
      connectTimeout: Constants.TIMEOUT_MS,
      readTimeout: Constants.TIMEOUT_MS
    })
    if (resp.responseCode !== 200) {
      return undefined
    }
    return resp.result as ArrayBuffer
  } catch (err) {
    return undefined
  } finally {
    request.destroy()
  }
}

/** 拉取并解码为 PixelMap(供 Image 渲染);失败返回 undefined */
export async function loadArtifactPixelMap(url: string): Promise<image.PixelMap | undefined> {
  const bytes: ArrayBuffer | undefined = await fetchArtifactBytes(url)
  if (bytes === undefined) {
    return undefined
  }
  try {
    const source: image.ImageSource = image.createImageSource(bytes)
    return await source.createPixelMap()
  } catch (err) {
    return undefined
  }
}

/**
 * 下载产物到应用沙箱(filesDir/artifacts/),返回保存路径。
 *
 * 说明:移动端没有浏览器式另存为,统一落到应用沙箱,再由上层决定分享或打开。
 */
export async function saveArtifactToSandbox(
  context: common.UIAbilityContext,
  url: string,
  fileName: string
): Promise<string | undefined> {
  const bytes: ArrayBuffer | undefined = await fetchArtifactBytes(url)
  if (bytes === undefined) {
    return undefined
  }
  const dir: string = `${context.filesDir}/artifacts`
  try {
    if (!fileIo.accessSync(dir)) {
      fileIo.mkdirSync(dir)
    }
    const path: string = `${dir}/${fileName}`
    const file = fileIo.openSync(path, fileIo.OpenMode.READ_WRITE | fileIo.OpenMode.CREATE | fileIo.OpenMode.TRUNC)
    fileIo.writeSync(file.fd, bytes)
    fileIo.closeSync(file)
    return path
  } catch (err) {
    return undefined
  }
}
