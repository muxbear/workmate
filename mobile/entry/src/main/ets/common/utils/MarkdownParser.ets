export interface InlinePiece {
  bold: boolean
  text: string
}

/**
 * 解析 **加粗** 内联标记(设计与 AI 回复仅使用此一种内联语法)。
 * 未配对的 ** 视为普通文本;空片段丢弃。
 */
export function parseBold(text: string): InlinePiece[] {
  const parts = text.split(/\*\*(.*?)\*\*/g)
  const out: InlinePiece[] = []
  for (let i = 0; i < parts.length; i++) {
    if (parts[i] === '') {
      continue
    }
    out.push({ bold: i % 2 === 1, text: parts[i] })
  }
  return out
}
