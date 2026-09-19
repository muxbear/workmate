#!/usr/bin/env node
/**
 * Ke-Work 对话功能对齐 · 端到端联调探针（网页版 / Web API 侧）
 * 用法：node web/frontend/scripts/alignment-e2e-probe.mjs <base> <account> <password>
 * 例：  node web/frontend/scripts/alignment-e2e-probe.mjs http://127.0.0.1:8001 admin ******
 * 作用：登录 → 选专家/技能/知识库 → 流式对话 → 校验 selection/token/done → 校验产物与下载。
 */

import { constants, publicEncrypt } from 'node:crypto'

const base = process.argv[2] ? process.argv[2] : 'http://127.0.0.1:8001'
const account = process.argv[3]
const password = process.argv[4]
const prompt = '请在工作区创建 alignment-check.md，内容含三行：任务名称、执行时间、结论。'

if (!account || !password) {
  console.log('用法: node alignment-e2e-probe.mjs <base> <account> <password>')
  process.exit(2)
}

const headers = (token) => {
  const out = { 'Content-Type': 'application/json' }
  if (token) out.Authorization = 'Bearer ' + token
  return out
}

async function getJson(path, token) {
  const res = await fetch(base + path, { headers: headers(token) })
  const text = await res.text()
  if (!res.ok) throw new Error(path + ' HTTP ' + res.status)
  return JSON.parse(text)
}

async function postJson(path, body, token) {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: headers(token),
    body: JSON.stringify(body),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(path + ' HTTP ' + res.status + '' + text.slice(0, 200))
  return JSON.parse(text)
}

const checks = []
function add(status, name, detail) {
  checks.push({ status: status, name: name, detail: detail ? detail : '' })
  console.log('[' + status + '] ' + name + (detail ? ' :: ' + detail : ''))
}

async function main() {
  const keyRes = await getJson('/api/auth/public-key')
  const encrypted = publicEncrypt(
    { key: keyRes.data.publicKey, padding: constants.RSA_PKCS1_PADDING },
    Buffer.from(password, 'utf8'),
  ).toString('base64')
  const login = await postJson('/api/auth/login/account', { account: account, password: encrypted })
  const token = login.data.tokens.accessToken
  add('PASS', '登录', account)

  const experts = await getJson('/api/experts?page=1&page_size=5', token)
  const skills = await getJson('/api/skill/list?page=1&page_size=5', token)
  const kbs = await getJson('/api/knowledge-bases?page=1&page_size=5', token)
  const expertItems = experts.data.items ? experts.data.items : []
  const skillItems = skills.data.items ? skills.data.items : []
  const kbItems = kbs.data.items ? kbs.data.items : []
  add('INFO', '专家/技能/知识库数量', expertItems.length + ' / ' + skillItems.length + ' / ' + kbItems.length)

  const selectedExpert = expertItems.length > 0 ? expertItems[0] : null
  const body = {
    message: prompt,
    workspace_id: 'probe-ws',
    allow_network: false,
    allow_shell: true,
    mode: 'default',
  }
  if (selectedExpert) body.expert_id = selectedExpert.id
  if (skillItems.length > 0) body.skill_ids = [skillItems[0].id]
  if (kbItems.length > 0) body.kb_ids = [kbItems[0].id]


  const providers = await getJson('/api/providers', token)
  const providerItems = providers.data ? providers.data : []
  let modelLabel = '未选择模型（走默认）'
  if (providerItems.length > 0) {
    const provider = providerItems[0]
    const models = provider.models ? provider.models : []
    if (models.length > 0) {
      body.provider_id = provider.id
      body.model_id = models[0].id
      modelLabel = provider.name + ' / ' + models[0].name
    }
  }
  add('INFO', '本次模型', modelLabel)

  const res = await fetch(base + '/api/chat/stream', {
    method: 'POST',
    headers: headers(token),
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    add('FAIL', '流式对话', 'HTTP ' + res.status)
    return
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let tokens = 0
  let sawSelection = false
  let sawAgentStart = false
  let durationMs = 0
  let threadId = ''
  const artifacts = []

  const handle = (line) => {
    if (!line.startsWith('data: ')) return
    let payload = null
    try {
      payload = JSON.parse(line.slice(6))
    } catch (err) {
      return
    }
    const event = payload.event
    if (event === 'selection') sawSelection = true
    if (event === 'agent_start') sawAgentStart = true
    if (event === 'token') tokens += 1
    if (event === 'artifact') artifacts.push(payload.data)
    if (event === 'done') {
      threadId = payload.data.thread_id
      durationMs = payload.data.duration_ms ? payload.data.duration_ms : 0
    }
  }

  let reading = true
  while (reading) {
    const chunk = await reader.read()
    if (chunk.done) {
      reading = false
      break
    }
    buffer += decoder.decode(chunk.value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop()
    for (const line of lines) handle(line)
  }
  if (buffer.trim()) handle(buffer)

  if (sawSelection) add('PASS', 'selection 事件', '已回显会话选择项')
  else add('FAIL', 'selection 事件', '未收到 selection')
  if (sawAgentStart) add('PASS', 'agent_start 事件', '已触发主智能体')
  else add('FAIL', 'agent_start 事件', '未收到 agent_start')
  if (tokens > 0) add('PASS', 'token 流', tokens + ' 个增量')
  else add('FAIL', 'token 流', '未收到任何 token')
  add(durationMs > 0 ? 'PASS' : 'FAIL', 'done 耗时', durationMs + ' ms')

  if (artifacts.length > 0) {
    add('PASS', 'artifact 事件', artifacts.length + ' 个产物')
    const list = await getJson('/api/chat/artifacts/' + encodeURIComponent(threadId), token)
    const items = list.data ? list.data : []
    const paths = new Set(items.map((item) => item.path))
    let matched = true
    for (const artifact of artifacts) {
      if (!paths.has(artifact.path)) matched = false
    }
    add(matched ? 'PASS' : 'FAIL', '产物落库', items.length + ' 条记录')
  } else {
    add('SKIP', 'artifact 事件', '本次回复未生成文件')
  }

  if (artifacts.length > 0 && threadId) {
    const target = artifacts[0]
    const url = base + '/api/chat/artifacts/' + encodeURIComponent(threadId) + '/download?path=' + encodeURIComponent(target.path)
    const fileRes = await fetch(url, { headers: headers(token) })
    add(fileRes.ok ? 'PASS' : 'FAIL', '产物下载', 'HTTP ' + fileRes.status)
  } else {
    add('SKIP', '产物下载', '无产物可校验')
  }
}

main()
  .then(() => {
    const failed = checks.filter((item) => item.status === 'FAIL').length
    console.log('')
    console.log('总结：' + checks.length + ' 项检查，' + failed + ' 项失败')
    process.exit(failed > 0 ? 1 : 0)
  })
  .catch((err) => {
    console.log('')
    console.log('探针执行失败：' + err.message)
    process.exit(1)
  })
