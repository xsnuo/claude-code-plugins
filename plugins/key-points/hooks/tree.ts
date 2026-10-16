// 看里层画出来的树：引擎自己画的回复正文，在树里是一个 { type: 'engine' } 节点。
// 标重点时只把这个节点换成带标注的正文，里层插件在回复下面加的东西（比如 aload 的 read aload）原样留着。

import type { RenderElement, RenderNode } from 'claude-code'

function childrenOf(node: RenderNode): readonly RenderNode[] | undefined {
  if (typeof node === 'string' || (node.type !== 'Box' && node.type !== 'Text')) return undefined
  return node.children
}

export function countEngine(node: RenderNode): number {
  if (typeof node === 'string') return 0
  if (node.type === 'engine') return 1
  return (childrenOf(node) ?? []).reduce((n, child) => n + countEngine(child), 0)
}

// 把树里的引擎节点换成 by（树里别的部分原样复制）
export function replaceEngine(node: RenderNode, by: RenderElement): RenderNode {
  if (typeof node === 'string') return node
  if (node.type === 'engine') return by
  const kids = childrenOf(node)
  if (!kids) return node
  return { ...node, children: kids.map(child => replaceEngine(child, by)) } as RenderElement
}

function shownTexts(node: RenderNode, out: string[]): string[] {
  if (typeof node === 'string') {
    out.push(node)
    return out
  }
  if (node.type === 'Markdown') out.push(node.props.text)
  for (const child of childrenOf(node) ?? []) shownTexts(child, out)
  return out
}

function flat(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

// 里层有没有插件把正文拆开自己画（比如 aload 的每段模式：第一段交给引擎，后面的段自己用 Markdown 画）。
// 看引擎节点以外显示的文字，有没有哪一段是这条回复原文的一部分
export function drawsPieces(node: RenderNode, text: string): boolean {
  const whole = flat(text)
  return shownTexts(node, []).some(piece => {
    const p = flat(piece)
    return p.length >= 2 && whole.includes(p)
  })
}
