// 把一条带标注的回复画出来。
//
// 引擎的 Markdown 元素不能给其中一部分文字上色，所以有重点的段落由这里自己逐行画（Text 可以设字体色、背景色、下划线）；
// 没有重点的段落、代码块、表格还是交给 Markdown，和引擎画的一样。
// 终端里引擎画回复时上面空一行、开头一个 ⏺，后面的块缩进 2 格，这里照着画。

import type { Elements, RenderElement, RenderSurface } from 'claude-code'

import type { KpStyles } from '../types'

import { paint, textStyle } from './marks'
import type { PaintedLine, Range, Unit } from './marks'

type Table = Elements[RenderSurface]

type Body = {
  els: Table
  surface: RenderSurface
  isFirstOfReply: boolean
  units: readonly Unit[]
  ranges: readonly (readonly Range[])[]
  styles: KpStyles
}

const LINKABLE = /^(https?|file):/

function drawLine({ Box, Text, Link }: Table, line: PaintedLine, styles: KpStyles): RenderElement {
  if (!line.parts.length) return <Text> </Text>
  const pieces = line.parts.map(part => {
    const inner = part.href && LINKABLE.test(part.href) ? <Link href={part.href}>{part.text}</Link> : part.text
    const props = textStyle(part, line, styles)
    return Object.keys(props).length ? <Text {...props}>{inner}</Text> : inner
  })
  const text = <Text>{pieces}</Text>
  if (!line.prefix) return text
  return (
    <Box flexDirection="row">
      <Box flexShrink={0}>
        <Text dimColor={!!line.quote}>{line.prefix}</Text>
      </Box>
      <Box flexDirection="column" flexGrow={1} flexShrink={1}>
        {text}
      </Box>
    </Box>
  )
}

export function drawBody({ els, surface, isFirstOfReply, units, ranges, styles }: Body): RenderElement {
  const { Box, Text, Markdown } = els
  const rows = units.map((unit, i) => {
    const marks = ranges[i] ?? []
    const tight = i > 0 && unit.kind === 'item' && units[i - 1]!.kind === 'item'
    const content =
      unit.lines && marks.length ? (
        <Box flexDirection="column">{paint(unit, marks).map(line => drawLine(els, line, styles))}</Box>
      ) : (
        <Markdown text={unit.md} />
      )
    return (
      <Box flexDirection="column" marginTop={i === 0 || tight ? 0 : 1}>
        {content}
      </Box>
    )
  })
  if (surface !== 'terminal') return <Box flexDirection="column">{rows}</Box>
  if (!isFirstOfReply) {
    return (
      <Box flexDirection="column" marginTop={1} paddingLeft={2}>
        {rows}
      </Box>
    )
  }
  return (
    <Box flexDirection="row" marginTop={1}>
      <Box flexShrink={0}>
        <Text>⏺ </Text>
      </Box>
      <Box flexDirection="column" flexGrow={1} flexShrink={1}>
        {rows}
      </Box>
    </Box>
  )
}
