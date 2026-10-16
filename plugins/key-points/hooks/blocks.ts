// 把一块 Markdown 回复切成"段"。纯函数，不碰 $。
//
// 段：普通段落、列表的一个条目（连同它的子条目）、引用、表格各算一段；
// 标题并进紧跟着的那段；代码块、分隔线也各是一段。
// 切法和 aload 的 blocks.ts 一致（两个插件各自独立安装，所以各带一份）。

export type ChunkKind = 'para' | 'item' | 'quote' | 'table' | 'code' | 'rule' | 'heading'

export type Chunk = {
  kind: ChunkKind
  // 这一段的 Markdown 原文
  md: string
}

export const FENCE = /^\s{0,3}(`{3,}|~{3,})/
const HEADING = /^\s{0,3}#{1,6}(\s|$)/
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/
const TABLE_ROW = /^\s*\|.*\|\s*$/
export const TABLE_RULE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/
const ITEM = /^(\s{0,3})([-*+]|\d{1,9}[.)])(\s+|$)/
const QUOTE = /^\s{0,3}>/

type Draft = { kind: ChunkKind; lines: string[]; fence?: string; indent?: number; blank?: boolean }

export function splitChunks(md: string): Chunk[] {
  const drafts: Draft[] = []
  let cur: Draft | null = null
  const flush = () => {
    if (cur) {
      while (cur.lines.length && !(cur.lines[cur.lines.length - 1] ?? '').trim()) cur.lines.pop()
      if (cur.lines.length) drafts.push(cur)
    }
    cur = null
  }
  const start = (kind: ChunkKind, line: string, extra: Partial<Draft> = {}) => {
    flush()
    cur = { kind, lines: [line], ...extra }
  }

  for (const line of md.replace(/\r\n?/g, '\n').split('\n')) {
    const c = cur as Draft | null
    // 代码块里面：原样收下，直到收尾的 ```
    if (c?.fence) {
      c.lines.push(line)
      if (closesFence(line, c.fence)) {
        c.fence = undefined
        if (c.kind === 'code') flush()
      }
      continue
    }
    const fence = line.match(FENCE)
    if (fence) {
      // 列表条目里缩进的代码块属于这个条目
      if (c?.kind === 'item' && leading(line) >= 2) {
        c.lines.push(line)
        c.fence = fence[1]
        c.blank = false
      } else start('code', line, { fence: fence[1] })
      continue
    }
    if (!line.trim()) {
      if (c?.kind === 'item') {
        c.lines.push(line)
        c.blank = true
      } else flush()
      continue
    }
    if (HEADING.test(line)) {
      start('heading', line)
      flush()
      continue
    }
    if (RULE.test(line) && !(c?.kind === 'para' && /^\s{0,3}-+\s*$/.test(line))) {
      start('rule', line)
      flush()
      continue
    }
    if (TABLE_ROW.test(line) || (c?.kind === 'table' && TABLE_RULE.test(line))) {
      if (c?.kind === 'table') c.lines.push(line)
      else start('table', line)
      continue
    }
    const item = line.match(ITEM)
    if (item) {
      if (c?.kind === 'item' && (item[1] ?? '').length >= (c.indent ?? 2)) {
        c.lines.push(line) // 子条目
        c.blank = false
      } else start('item', line, { indent: item[0].length })
      continue
    }
    if (c?.kind === 'item') {
      if (leading(line) >= 2 || !c.blank) {
        c.lines.push(line) // 条目的续行
        c.blank = false
        continue
      }
      flush()
    }
    if (QUOTE.test(line)) {
      if (c?.kind === 'quote') c.lines.push(line)
      else start('quote', line)
      continue
    }
    const now = cur as Draft | null
    if (now?.kind === 'para' || now?.kind === 'quote') now.lines.push(line)
    else start('para', line)
  }
  flush()

  // 标题并进下一段（下一段是代码、分隔线或没有下一段时，标题单独成段）
  const chunks: Chunk[] = []
  let heading: string[] = []
  for (const d of drafts) {
    if (d.kind === 'heading') {
      if (heading.length) chunks.push({ kind: 'heading', md: heading.join('\n') })
      heading = d.lines
      continue
    }
    if (heading.length && d.kind !== 'code' && d.kind !== 'rule') {
      chunks.push({ kind: d.kind, md: [...heading, ...d.lines].join('\n') })
    } else {
      if (heading.length) chunks.push({ kind: 'heading', md: heading.join('\n') })
      chunks.push({ kind: d.kind, md: d.lines.join('\n') })
    }
    heading = []
  }
  if (heading.length) chunks.push({ kind: 'heading', md: heading.join('\n') })
  return chunks
}

function closesFence(line: string, fence: string): boolean {
  const t = line.trim()
  return t.length >= fence.length && t[0] === fence[0] && /^(`+|~+)$/.test(t)
}

function leading(line: string): number {
  return line.length - line.trimStart().length
}
