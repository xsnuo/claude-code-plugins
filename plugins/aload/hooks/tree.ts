// 看里层画出来的树：引擎自己画的回复正文，在树里是一个 { type: 'engine' } 节点。
// 每段模式下，aload 自己分段画正文；里层插件在回复下面加的东西（比如 key-points 的链接）要从里层的树里拿出来接在后面。

import type { RenderElement, RenderNode } from 'claude-code'

function childrenOf(node: RenderNode): readonly RenderNode[] | undefined {
  if (typeof node === 'string' || (node.type !== 'Box' && node.type !== 'Text')) return undefined
  return node.children
}

export function hasEngine(node: RenderNode): boolean {
  if (typeof node === 'string') return false
  return node.type === 'engine' || (childrenOf(node) ?? []).some(hasEngine)
}

// 去掉引擎画的正文，剩下里层插件加的东西；什么都不剩就是 null
export function withoutEngine(node: RenderNode): RenderNode | null {
  if (typeof node === 'string') return node
  if (node.type === 'engine') return null
  const kids = childrenOf(node)
  if (!kids) return node
  const rest = kids.map(withoutEngine).filter((child): child is RenderNode => child !== null)
  if (!rest.length && kids.length) return null
  return { ...node, children: rest } as RenderElement
}
