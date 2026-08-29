import { ref, computed, watch, markRaw } from 'vue'
import type { Node, Edge } from '@vue-flow/core'
import { MarkerType } from '@vue-flow/core'
import dagre from 'dagre'
import { useAgentStore } from '@/stores/agent'
import type { Agent } from '@/types/agent'
import AgentNode from '@/components/agent/AgentNode.vue'
import AgentEdge from '@/components/agent/AgentEdge.vue'

const NODE_WIDTH = 240
const NODE_HEIGHT = 130

export function useAgentGraph() {
  const agentStore = useAgentStore()

  const nodeTypes = { agent: markRaw(AgentNode) }
  const edgeTypes = { agent: markRaw(AgentEdge) }
  const graphNodes = ref<Node[]>([])
  const graphEdges = ref<Edge[]>([])

  const hasAgents = computed(() => agentStore.agents.length > 0)

  function childrenOf(parentId: string): Agent[] {
    return agentStore.agents.filter((a) => a.parentId === parentId)
  }

  function buildNodes(): Node[] {
    const nodes: Node[] = []
    for (const agent of agentStore.agents) {
      nodes.push({
        id: agent.id,
        type: 'agent',
        position: { x: 0, y: 0 },
        data: {
          agent,
          isMain: !agent.parentId,
          childCount: childrenOf(agent.id).length,
        },
        draggable: true,
      })
    }
    return nodes
  }

  function buildEdges(): Edge[] {
    const edges: Edge[] = []
    const agents = agentStore.agents

    for (const agent of agents) {
      if (!agent.parentId) continue
      const parent = agents.find((a) => a.id === agent.parentId)
      if (!parent) continue
      const isActive = agent.status === 'active'
      edges.push({
        id: parent.id + '->' + agent.id,
        source: parent.id,
        target: agent.id,
        type: 'agent',
        animated: isActive,
        markerEnd: {
          type: MarkerType.ArrowClosed,
          color: isActive ? '#8b5cf6' : '#6b7280',
          width: 20,
          height: 20,
        },
        data: { status: agent.status },
      })
    }

    return edges
  }

  function applyLayout() {
    const raw = buildNodes()
    const edges = buildEdges()
    if (raw.length === 0) {
      graphNodes.value = []
      graphEdges.value = []
      return
    }

    const g = new dagre.graphlib.Graph()
    g.setDefaultEdgeLabel(() => ({}))
    g.setGraph({ rankdir: 'TB', ranksep: 140, nodesep: 120, marginx: 80, marginy: 80 })

    for (const node of raw) {
      g.setNode(node.id, { width: NODE_WIDTH, height: NODE_HEIGHT })
    }

    for (const edge of edges) {
      g.setEdge(edge.source, edge.target)
    }

    dagre.layout(g)

    const hasLayout = g.node(raw[0].id) != null
    if (!hasLayout) {
      graphNodes.value = raw
      graphEdges.value = edges
      return
    }

    for (const node of raw) {
      const pos = g.node(node.id)
      if (!pos) continue
      node.position = {
        x: pos.x - NODE_WIDTH / 2,
        y: pos.y - NODE_HEIGHT / 2,
      }
    }

    graphNodes.value = raw
    graphEdges.value = edges
  }

  watch(
    () => agentStore.agents,
    () => applyLayout(),
    { deep: true, immediate: true },
  )

  function onNodeClick({ node }: { node: Node }) {
    const agent = (node.data as { agent: Agent }).agent
    if (agent) {
      agentStore.selectAgent(agent.id)
    }
  }

  return {
    nodeTypes,
    edgeTypes,
    graphNodes,
    graphEdges,
    hasAgents,
    onNodeClick,
  }
}
