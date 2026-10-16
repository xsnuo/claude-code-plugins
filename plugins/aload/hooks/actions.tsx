// 回复末尾的「操作行」：aload 和 key-points 共用这一行，两个链接并排放。
//
// 两个插件都会改同一条回复的画法，谁在外层由引擎决定。约定如下：
// - 在内层的插件先画，它建好这一行（一个 key 为 ROW 的 Box）；
// - 在外层的插件在树里找到这一行，按 ORDER 把自己的链接插进去；
// - 树里没有这一行，就自己在回复下面加一行。
// 所以只装一个插件时，这一行里就只有它自己的链接。
// 两个插件各带一份这个文件（plugins/aload/hooks/actions.tsx 和 plugins/key-points/hooks/actions.tsx），改的时候两边一起改。

import type { Elements, RenderElement, RenderNode, RenderSurface } from 'claude-code'

type BoxTag = Elements[RenderSurface]['Box']

export const ROW = 'reply-actions'
// 行里链接的先后，跟谁在外层无关
const ORDER = ['aload-read', 'key-points-link']

function keyOf(node: RenderNode): string | undefined {
  if (typeof node === 'string' || !('props' in node) || !node.props) return undefined
  const key = (node.props as { key?: unknown }).key
  return typeof key === 'string' ? key : undefined
}

function childrenOf(node: RenderNode): readonly RenderNode[] | undefined {
  if (typeof node === 'string' || (node.type !== 'Box' && node.type !== 'Text')) return undefined
  return node.children
}

function isRow(node: RenderNode): boolean {
  return typeof node !== 'string' && node.type === 'Box' && keyOf(node) === ROW
}

// 深度优先找操作行，找到就用 swap 的结果换掉它（null 表示拿掉）；树里别的部分原样复制
function swapRow(node: RenderNode, swap: (row: RenderElement) => RenderNode | null): { node: RenderNode | null; row?: RenderElement } {
  if (typeof node === 'string') return { node }
  if (isRow(node)) return { node: swap(node), row: node }
  const kids = childrenOf(node)
  if (!kids) return { node }
  for (let i = 0; i < kids.length; i++) {
    const hit = swapRow(kids[i]!, swap)
    if (!hit.row) continue
    const children = [...kids.slice(0, i), ...(hit.node === null ? [] : [hit.node]), ...kids.slice(i + 1)]
    return { node: { ...node, children } as RenderElement, row: hit.row }
  }
  return { node }
}

// 把操作行从树里拿出来：返回拿掉它之后的树，和这一行（树里没有就是 undefined）
export function takeRow(tree: RenderNode): { rest: RenderNode | null; row?: RenderElement } {
  const { node, row } = swapRow(tree, () => null)
  return row ? { rest: node, row } : { rest: tree }
}

function rank(node: RenderNode): number {
  const i = ORDER.indexOf(keyOf(node) ?? '')
  return i < 0 ? ORDER.length : i
}

// 把链接放进操作行：树里已有这一行就按 ORDER 插进去，没有就在树下面加一行
export function addAction(Box: BoxTag, tree: RenderNode, link: RenderElement): RenderElement {
  const { node, row } = swapRow(tree, r => {
    const kids = [...(childrenOf(r) ?? [])]
    let at = kids.length
    while (at > 0 && rank(kids[at - 1]!) > rank(link)) at--
    kids.splice(at, 0, link)
    return { ...r, children: kids } as RenderElement
  })
  if (row && node !== null && typeof node !== 'string') return node
  return (
    <Box flexDirection="column">
      {tree}
      <Box key={ROW} flexDirection="row" columnGap={3} paddingLeft={2}>
        {link}
      </Box>
    </Box>
  )
}
