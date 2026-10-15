// 把一块 Markdown 回复切成"段"，并把每段整理成朗读用的文字。纯函数，不碰 $。
//
// 段：普通段落、列表的一个条目（连同它的子条目）、引用、表格各算一段；
// 标题并进紧跟着的那段一起念；代码块、分隔线也是一段，但不念（没有朗读图标）。

export type ChunkKind = 'para' | 'item' | 'quote' | 'table' | 'code' | 'rule' | 'heading'

export type Chunk = {
  kind: ChunkKind
  // 这一段的 Markdown 原文，原样交给引擎去画
  md: string
  // 念出来的文字；空串表示这一段没有朗读图标
  speech: string
}

const FENCE = /^\s{0,3}(`{3,}|~{3,})/
const HEADING = /^\s{0,3}#{1,6}(\s|$)/
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/
const TABLE_ROW = /^\s*\|.*\|\s*$/
const TABLE_RULE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/
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
      if (heading.length) chunks.push(toChunk('heading', heading))
      heading = d.lines
      continue
    }
    if (heading.length && d.kind !== 'code' && d.kind !== 'rule') {
      chunks.push(toChunk(d.kind, [...heading, ...d.lines]))
    } else {
      if (heading.length) chunks.push(toChunk('heading', heading))
      chunks.push(toChunk(d.kind, d.lines))
    }
    heading = []
  }
  if (heading.length) chunks.push(toChunk('heading', heading))
  return chunks
}

function closesFence(line: string, fence: string): boolean {
  const t = line.trim()
  return t.length >= fence.length && t[0] === fence[0] && /^(`+|~+)$/.test(t)
}

function leading(line: string): number {
  return line.length - line.trimStart().length
}

function toChunk(kind: ChunkKind, lines: string[]): Chunk {
  const md = lines.join('\n')
  return { kind, md, speech: kind === 'code' || kind === 'rule' ? '' : toSpeech(md) }
}

// ---------- 朗读文字 ----------

function cells(row: string): string[] {
  return row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(s => s.trim())
}

function endSentence(s: string): string {
  return /[。！？.!?；;：:]$/.test(s) ? s : `${s}。`
}

// 表格每行念成一句：第一格当这一行的名字，其余格念成"表头：内容"
export function tableToSpeech(lines: string[]): string {
  const hasHeader = lines.length > 1 && TABLE_RULE.test(lines[1] ?? '')
  const header = hasHeader ? cells(lines[0] ?? '').map(inline) : []
  const body = (hasHeader ? lines.slice(2) : lines).filter(l => !TABLE_RULE.test(l))
  const out: string[] = []
  for (const row of body) {
    const [first, ...rest] = cells(row).map(inline)
    const parts = first ? [first] : []
    rest.forEach((value, i) => {
      if (!value) return
      const name = header[i + 1]
      parts.push(name ? `${name}：${value}` : value)
    })
    if (parts.length) out.push(endSentence(parts.join('，')))
  }
  return out.join('\n')
}

const PICTOGRAPH = /[\p{Extended_Pictographic}\u{FE0F}\u{200D}\u{20E3}]/gu

// 行内的整理：去掉只给眼睛看的符号
function inline(s: string): string {
  return s
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '') // 图片
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // 链接只念文字
    .replace(/<?https?:\/\/[^\s)>]+>?/g, '链接')
    .replace(/`([^`]+)`/g, (_, code: string) => (code.length > 40 ? '一段代码' : code))
    .replace(/(^|[\s(（"“'])((?:~|\.{1,2})?\/(?:[\w.@-]+\/)+([\w.@-]+))(:\d+(?::\d+)?)?/g, '$1$3') // 路径只念文件名
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/(^|[^\w*])\*([^*\s][^*]*?)\*(?!\w)/g, '$1$2')
    .replace(/~~([^~]+)~~/g, '$1')
    .replace(/<\/?[a-zA-Z][^>]*>/g, '')
    .replace(PICTOGRAPH, '')
    .replace(/[ \t]+/g, ' ')
    .trim()
}

export function toSpeech(md: string): string {
  const lines = md.split('\n')
  const out: string[] = []
  let table: string[] = []
  const flushTable = () => {
    if (table.length) out.push(tableToSpeech(table))
    table = []
  }
  let inFence = false
  for (const raw of lines) {
    if (FENCE.test(raw)) {
      flushTable()
      if (!inFence) out.push('（这里有一段代码）')
      inFence = !inFence
      continue
    }
    if (inFence) continue
    if (TABLE_ROW.test(raw) || (table.length && TABLE_RULE.test(raw))) {
      table.push(raw)
      continue
    }
    flushTable()
    const line = raw
      .replace(/^\s{0,3}#{1,6}\s*/, '') // 标题
      .replace(/^\s*(>\s?)+/, '') // 引用
      .replace(/^\s*([-*+]|\d{1,9}[.)])\s+(\[[ xX]\]\s+)?/, '') // 列表符号、勾选框
    const text = inline(line).replace(/\s*\|\s*/g, '，') // 没有首尾竖线的表格行
    if (text) out.push(text)
  }
  flushTable()
  return out
    .join('\n')
    .replace(/\n{2,}/g, '\n')
    .trim()
}

// ---------- 从某个位置往后读 ----------

export type Span = Chunk & { start: number; end: number }

// 每段在原文里的起止位置（end 是下一段的开头，最后一段到原文结尾）
export function chunkSpans(md: string): Span[] {
  const text = md.replace(/\r\n?/g, '\n')
  const spans: Span[] = []
  let pos = 0
  for (const c of splitChunks(text)) {
    const firstLine = c.md.split('\n')[0] ?? ''
    const at = text.indexOf(firstLine, pos)
    const start = at >= 0 ? at : pos
    spans.push({ ...c, start, end: text.length })
    pos = start + firstLine.length
  }
  for (let i = 0; i + 1 < spans.length; i++) spans[i]!.end = spans[i + 1]!.start
  return spans
}

// 从原文第 offset 个字符开始，往后要念的各段文字（空段跳过）。
// 落在一段中间就从那里念起；落在代码块里从下一段念；落在表格里整张表念（表头要用）
export function speechFrom(md: string, offset = 0): string[] {
  const text = md.replace(/\r\n?/g, '\n')
  const out: string[] = []
  for (const s of chunkSpans(text)) {
    if (s.end <= offset) continue
    if (s.start < offset && s.kind !== 'table' && s.kind !== 'code' && s.kind !== 'rule') {
      const partial = toSpeech(text.slice(offset, s.end))
      if (partial) out.push(partial)
      continue
    }
    if (s.speech) out.push(s.speech)
  }
  return out
}

// 只留字母、数字和汉字，记下每个留下来的字在原文里的位置
function letters(s: string): { text: string; at: number[] } {
  let text = ''
  const at: number[] = []
  let i = 0
  for (const ch of s) {
    if (/[\p{L}\p{N}]/u.test(ch)) {
      text += ch.toLowerCase()
      at.push(i)
    }
    i += ch.length
  }
  return { text, at }
}

// 选中的文字是屏幕上看到的样子（没有 ** ` # 这些符号、表格画成了框线），
// 所以只比字母、数字和汉字：找到它在 Markdown 原文里从哪开始；找不到返回 -1
export function locate(md: string, selected: string): number {
  const src = letters(md.replace(/\r\n?/g, '\n'))
  const sel = letters(selected).text
  if (!sel) return -1
  for (const n of [24, 12, 6]) {
    const probe = sel.slice(0, n)
    const at = src.text.indexOf(probe)
    if (at >= 0) return src.at[at]!
    if (probe.length === sel.length) break
  }
  return -1
}
