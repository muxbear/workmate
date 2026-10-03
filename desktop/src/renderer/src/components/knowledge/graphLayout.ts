/**
 * 图谱力导向布局（纯函数，零依赖）
 *
 * Fruchterman-Reingold 风格：斥力 k²/d、引力 d²/k、温度线性冷却，外加向心力防止
 * 孤立节点飘出画布。初始位置由「按 key 排序 + 黄金角螺旋」确定 —— 同一输入两次布局
 * 结果完全一致（单测可钉住）。桌面规模（≤150 节点）同步跑几百轮迭代只需几十毫秒。
 */

export interface GraphLayoutNode {
  key: string
  mentions: number
}

export interface GraphLayoutLink {
  from: string
  to: string
  weight: number
}

export interface GraphLayoutInput {
  nodes: GraphLayoutNode[]
  links: GraphLayoutLink[]
}

export interface GraphLayoutOptions {
  width: number
  height: number
  /** 迭代轮数（默认 300） */
  iterations?: number
}

export interface GraphLayoutResult {
  positions: Map<string, { x: number; y: number }>
}

export function layoutGraph(
  input: GraphLayoutInput,
  options: GraphLayoutOptions
): GraphLayoutResult {
  const width = Math.max(1, options.width)
  const height = Math.max(1, options.height)
  const iterations = Math.max(1, options.iterations ?? 300)
  const nodes = [...input.nodes].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  const n = nodes.length
  const positions = new Map<string, { x: number; y: number }>()
  if (n === 0) return { positions }
  if (n === 1) {
    positions.set(nodes[0].key, { x: width / 2, y: height / 2 })
    return { positions }
  }

  const index = new Map(nodes.map((node, i) => [node.key, i]))
  const xs = new Float64Array(n)
  const ys = new Float64Array(n)
  const golden = Math.PI * (3 - Math.sqrt(5))
  const radius = Math.min(width, height) * 0.35
  for (let i = 0; i < n; i += 1) {
    const angle = golden * i
    const r = radius * Math.sqrt((i + 1) / n)
    xs[i] = width / 2 + r * Math.cos(angle)
    ys[i] = height / 2 + r * Math.sin(angle)
  }

  const edges: Array<readonly [number, number]> = []
  for (const link of input.links) {
    const a = index.get(link.from)
    const b = index.get(link.to)
    if (a === undefined || b === undefined || a === b) continue
    edges.push([a, b])
  }

  const k = Math.sqrt((width * height) / n)
  let temperature = Math.min(width, height) / 10
  const dx = new Float64Array(n)
  const dy = new Float64Array(n)
  for (let iter = 0; iter < iterations; iter += 1) {
    dx.fill(0)
    dy.fill(0)

    // 斥力（所有节点两两相斥）
    for (let i = 0; i < n; i += 1) {
      for (let j = i + 1; j < n; j += 1) {
        let ax = xs[i] - xs[j]
        let ay = ys[i] - ys[j]
        let dist = Math.sqrt(ax * ax + ay * ay)
        if (dist < 0.01) {
          // 完全重合时给一个确定性的分离方向（避免 0 除）
          ax = 0.01 * (i + 1)
          ay = 0.01
          dist = Math.sqrt(ax * ax + ay * ay)
        }
        const force = (k * k) / dist
        const ux = ax / dist
        const uy = ay / dist
        dx[i] += ux * force
        dy[i] += uy * force
        dx[j] -= ux * force
        dy[j] -= uy * force
      }
    }

    // 引力（有边相连的节点互相吸引）
    for (const [a, b] of edges) {
      const ax = xs[a] - xs[b]
      const ay = ys[a] - ys[b]
      const dist = Math.max(0.01, Math.sqrt(ax * ax + ay * ay))
      const force = (dist * dist) / k
      const ux = ax / dist
      const uy = ay / dist
      dx[a] -= ux * force
      dy[a] -= uy * force
      dx[b] += ux * force
      dy[b] += uy * force
    }

    // 向心力 + 位移限幅（温度冷却）+ 画布边界
    for (let i = 0; i < n; i += 1) {
      dx[i] += (width / 2 - xs[i]) * 0.01
      dy[i] += (height / 2 - ys[i]) * 0.01
      const dist = Math.max(0.01, Math.sqrt(dx[i] * dx[i] + dy[i] * dy[i]))
      const step = Math.min(dist, temperature)
      xs[i] = Math.min(width, Math.max(0, xs[i] + (dx[i] / dist) * step))
      ys[i] = Math.min(height, Math.max(0, ys[i] + (dy[i] / dist) * step))
    }
    temperature = Math.max(0.1, temperature * (1 - (iter + 1) / iterations))
  }

  for (let i = 0; i < n; i += 1) positions.set(nodes[i].key, { x: xs[i], y: ys[i] })
  return { positions }
}
