import { describe, it, expect } from '@ohos/hypium'
import {
  attachArtifactsToMessages,
  groupArtifactsByTurn,
  turnLabel,
  ArtifactCarrier,
  ArtifactTurnGroup
} from '../main/ets/common/utils/ArtifactGroups'
import { ChatArtifact } from '../main/ets/common/types/Models'

function artifact(path: string, turn?: string): ChatArtifact {
  const parts: Array<string> = path.split('/')
  return {
    path: path,
    name: parts[parts.length - 1],
    source_tool: 'write_file',
    created_at: 1,
    turn: turn
  } as ChatArtifact
}

export default function artifactGroupsTest() {
  describe('ArtifactGroups', () => {
    it('groupArtifactsByTurn_groupsInOrder', 0, () => {
      const groups: Array<ArtifactTurnGroup> = groupArtifactsByTurn([
        artifact('/artifacts/t1/turn-1/a.md', 'turn-1'),
        artifact('/artifacts/t1/turn-1/a/f1.png', 'turn-1'),
        artifact('/artifacts/t1/turn-2/b.md', 'turn-2'),
        artifact('/workspace/legacy.txt')
      ])
      expect(groups.length).assertEqual(2)
      expect(groups[0].turn).assertEqual('turn-1')
      expect(groups[0].items.length).assertEqual(2)
      expect(groups[1].turn).assertEqual('turn-2')
      // 无轮次的产物并入当前分组
      expect(groups[1].items.length).assertEqual(2)
    })

    it('attachArtifactsToMessages_matchesTurns', 0, () => {
      const messages: Array<ArtifactCarrier> = [
        { role: 'user' } as ArtifactCarrier,
        { role: 'assistant' } as ArtifactCarrier,
        { role: 'user' } as ArtifactCarrier,
        { role: 'assistant' } as ArtifactCarrier
      ]
      const result: Array<ArtifactCarrier> = attachArtifactsToMessages(messages, [
        artifact('/artifacts/t1/turn-1/a.md', 'turn-1'),
        artifact('/artifacts/t1/turn-2/b.md', 'turn-2')
      ])
      const first: Array<ChatArtifact> | undefined = result[1].artifacts
      const second: Array<ChatArtifact> | undefined = result[3].artifacts
      expect(first !== undefined).assertTrue()
      expect(second !== undefined).assertTrue()
      if (first !== undefined && second !== undefined) {
        expect(first[0].path).assertEqual('/artifacts/t1/turn-1/a.md')
        expect(second[0].path).assertEqual('/artifacts/t1/turn-2/b.md')
      }
    })

    it('attachArtifactsToMessages_fallsBackToLast', 0, () => {
      const messages: Array<ArtifactCarrier> = [
        { role: 'assistant' } as ArtifactCarrier,
        { role: 'assistant' } as ArtifactCarrier
      ]
      const result: Array<ArtifactCarrier> = attachArtifactsToMessages(messages, [
        artifact('/artifacts/t1/turn-1/a.md', 'turn-1')
      ])
      expect(result[0].artifacts === undefined).assertTrue()
      const last: Array<ChatArtifact> | undefined = result[1].artifacts
      expect(last !== undefined).assertTrue()
      if (last !== undefined) {
        expect(last.length).assertEqual(1)
      }
    })

    it('attachArtifactsToMessages_emptyInputs', 0, () => {
      const messages: Array<ArtifactCarrier> = [{ role: 'user' } as ArtifactCarrier]
      expect(attachArtifactsToMessages(messages, []).length).assertEqual(1)
      const empty: Array<ChatArtifact> = []
      expect(attachArtifactsToMessages([], empty).length).assertEqual(0)
    })

    it('turnLabel_formatsTurn', 0, () => {
      expect(turnLabel('turn-3')).assertEqual('第 3 轮交付物')
      expect(turnLabel('')).assertEqual('')
      expect(turnLabel(undefined)).assertEqual('')
      expect(turnLabel('bad')).assertEqual('')
    })
  })
}