// 标重点的纯逻辑：问 Claude 的话、读它的回答、在回复里找到这些重点、控制总量不超过 25%、把每行切成带样式的小段。
// 纯函数，不碰 $。

import type { KpItem, KpKind, KpStyle, KpStyles } from '../types'

import { FENCE, TABLE_RULE, splitChunks } from './blocks'
import type { ChunkKind } from './blocks'

// 重点最多占回复正文的比例
export const LIMIT = 0.25

// 默认：关注句黄色字（主题里的 warning，深浅主题下都看得清）；关注词荧光黄底、黑字
export const DEFAULT_STYLES: KpStyles = {
  sentence: { color: 'warning', underline: false },
  word: { color: '#000000', backgroundColor: '#FFFF00', underline: false },
}

// ---------- 问 Claude ----------

export function promptFor(answer: string): string {
  return [
    '【这是 key-points 插件在后台发起的旁路请求，不是用户的新消息。不要调用任何工具，不要寒暄，只按下面的要求输出 JSON。】',
    '',
    '<reply> 里是你在这段对话中给出的一条回复。请结合整段对话，从这条回复里挑出读者最该关注的内容，分两类：',
    '- sentence（关注句）：一句或半句话；',
    '- word（关注词）：关键的词或短语，一般 2～12 个字，可以落在关注句里面。',
    '',
    '什么算重点：',
    '1. 这段对话探讨的核心；',
    '2. 直接、简练地回答用户提问的部分；',
    '3. 需要用户知晓、或需要用户做决策的内容；',
    '4. 其他你认为重要的内容。',
    '',
    '要求：',
    '- 只从 <reply> 的正文里摘，逐字照抄原文（Markdown 符号可以省略），不要改写、不要拼接，不要从代码块和表格里摘；',
    '- 宁少勿滥：所有标注加起来不超过正文篇幅的 25%，没有明显的重点就少标或不标；',
    '- 按重要性从高到低排列，两类可以交错；',
    '- 只输出一个 JSON 数组，不要任何解释，也不要代码块标记，例如：[{"type":"sentence","text":"……"},{"type":"word","text":"……"}]；没有值得标的就输出 []。',
    '',
    '<reply>',
    answer,
    '</reply>',
  ].join('\n')
}

function toItems(data: unknown): KpItem[] | null {
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    // 也认 {"sentences": [...], "words": [...]} 这种写法
    const o = data as { sentences?: unknown; words?: unknown }
    const list = (x: unknown) => (Array.isArray(x) ? x : [])
    data = [
      ...list(o.sentences).map(text => ({ type: 'sentence', text })),
      ...list(o.words).map(text => ({ type: 'word', text })),
    ]
  }
  if (!Array.isArray(data)) return null
  const out: KpItem[] = []
  for (const x of data) {
    if (!x || typeof x !== 'object') continue
    const { type, text } = x as { type?: unknown; text?: unknown }
    if ((type === 'sentence' || type === 'word') && typeof text === 'string' && text.trim()) out.push({ type, text: text.trim() })
  }
  return out
}

// 读 Claude 的回答：一个 JSON 数组；读不懂返回 null
export function parseItems(raw: string): KpItem[] | null {
  const text = raw.trim().replace(/^```\w*\s*/, '').replace(/\s*```$/, '')
  const tries = [text]
  const a = text.indexOf('[')
  const b = text.lastIndexOf(']')
  if (a >= 0 && b > a) tries.push(text.slice(a, b + 1))
  for (const t of tries) {
    try {
      const items = toItems(JSON.parse(t))
      if (items) return items
    } catch {
      // 换下一种读法
    }
  }
  return null
}

// ---------- 行内 Markdown ----------

// 一小段文字和它在 Markdown 里的样式；符号本身（** ` [] 这些）不显示，所以不在 text 里
export type Seg = { text: string; bold?: true; italic?: true; code?: true; strike?: true; href?: string }
type Look = Omit<Seg, 'text'>

const ESCAPABLE = /[\\`*_{}[\]()#+\-.!~|<>]/
const WORDCHAR = /[\p{L}\p{N}]/u

// 这个 * 或 _ 能不能开始一段强调：后面紧跟的不是空白；_ 前面也不能是字母或数字（snake_case 里的不算）
function opens(src: string, i: number, mark: string): boolean {
  const after = src[i + mark.length]
  if (!after || /\s/.test(after)) return false
  return !(mark[0] === '_' && i > 0 && WORDCHAR.test(src[i - 1]!))
}

// 从 from 开始找收尾的 mark：前面紧挨着的不是空白；单个 * 或 _ 跳过成对的 ** __
function closing(src: string, mark: string, from: number): number {
  for (let j = from; j < src.length; j++) {
    if (src[j] === '\\') {
      j++
      continue
    }
    if (src[j] === '`') {
      const run = /^`+/.exec(src.slice(j))![0]
      const end = src.indexOf(run, j + run.length)
      if (end > j) j = end + run.length - 1 // 行内代码里的符号不算
      continue
    }
    if (!src.startsWith(mark, j)) continue
    if (mark.length === 1 && src[j + 1] === mark) {
      j++
      continue
    }
    if (j === from || /\s/.test(src[j - 1]!)) continue
    if (mark[0] === '_' && j + mark.length < src.length && WORDCHAR.test(src[j + mark.length]!)) continue
    return j
  }
  return -1
}

// 把一行 Markdown 拆成带样式的小段：粗体、斜体、删除线、行内代码、链接
export function parseInline(src: string, look: Look = {}): Seg[] {
  const out: Seg[] = []
  let buf = ''
  const flush = () => {
    if (buf) out.push({ ...look, text: buf })
    buf = ''
  }
  let i = 0
  while (i < src.length) {
    const ch = src[i]!
    const rest = src.slice(i)
    if (ch === '\\' && i + 1 < src.length && ESCAPABLE.test(src[i + 1]!)) {
      buf += src[i + 1]
      i += 2
      continue
    }
    if (ch === '`') {
      const run = /^`+/.exec(rest)![0]
      const end = src.indexOf(run, i + run.length)
      if (end > i) {
        flush()
        let code = src.slice(i + run.length, end)
        if (code.length > 2 && code.startsWith(' ') && code.endsWith(' ') && code.trim()) code = code.slice(1, -1)
        out.push({ ...look, code: true, text: code })
        i = end + run.length
      } else {
        buf += run
        i += run.length
      }
      continue
    }
    if (ch === '[' || (ch === '!' && rest[1] === '[')) {
      const m = /^!?\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+["'][^"']*["'])?\s*\)/.exec(rest)
      if (m) {
        flush()
        out.push(...parseInline(m[1] || m[2]!, { ...look, href: m[2]! }))
        i += m[0].length
        continue
      }
    }
    if (ch === '<') {
      const m = /^<((?:https?|file):[^>\s]+)>/.exec(rest)
      if (m) {
        flush()
        out.push({ ...look, href: m[1]!, text: m[1]! })
        i += m[0].length
        continue
      }
    }
    const pair = ['**', '__', '~~'].find(p => rest.startsWith(p))
    if (pair) {
      const end = opens(src, i, pair) ? closing(src, pair, i + 2) : -1
      if (end > i + 2) {
        flush()
        out.push(...parseInline(src.slice(i + 2, end), { ...look, ...(pair === '~~' ? { strike: true as const } : { bold: true as const }) }))
        i = end + 2
      } else {
        buf += pair
        i += 2
      }
      continue
    }
    if ((ch === '*' || ch === '_') && opens(src, i, ch)) {
      const end = closing(src, ch, i + 1)
      if (end > i + 1) {
        flush()
        out.push(...parseInline(src.slice(i + 1, end), { ...look, italic: true }))
        i = end + 1
        continue
      }
    }
    buf += ch
    i++
  }
  flush()
  return out
}

function plain(src: string): string {
  return parseInline(src)
    .map(s => s.text)
    .join('')
}

// ---------- 把回复拆成段和行 ----------

// 一行：前缀（列表符号、缩进、引用线）不参与标注，正文拆成小段
export type Line = { prefix: string; segs: Seg[]; heading?: number; quote?: true }

// 一段：能标注的拆成行（lines）；代码块、表格、分隔线、夹着代码块的列表条目不标注（lines 为 null），原样交给 Markdown 画。
// text 是这一段显示出来的文字（各行用换行连起来），size 是其中不算空白的字数，用来算 25%
export type Unit = { kind: ChunkKind; md: string; lines: Line[] | null; text: string; size: number }

const HEAD = /^\s{0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/
const QUOTE_LINE = /^\s{0,3}>\s?(.*)$/
const ITEM_LINE = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/

function toLines(md: string, kind: ChunkKind): Line[] | null {
  const lines: Line[] = []
  for (const raw of md.split('\n')) {
    if (FENCE.test(raw)) return null
    if (!raw.trim()) {
      lines.push({ prefix: '', segs: [] })
      continue
    }
    const h = HEAD.exec(raw)
    if (h) {
      lines.push({ prefix: '', segs: parseInline(h[2]!), heading: h[1]!.length })
      continue
    }
    const q = QUOTE_LINE.exec(raw)
    if (q) {
      lines.push({ prefix: '▎ ', segs: parseInline(q[1]!.replace(/^(>\s?)+/, '')), quote: true })
      continue
    }
    const it = ITEM_LINE.exec(raw)
    if (it) {
      const mark = /\d/.test(it[2]!) ? it[2]! : '-'
      lines.push({ prefix: `${it[1]}${mark} `, segs: parseInline(it[3]!) })
      continue
    }
    // 条目的续行保留缩进，和条目的文字对齐；普通段落的行不缩进
    const lead = kind === 'item' ? raw.length - raw.trimStart().length : 0
    lines.push({ prefix: ' '.repeat(lead), segs: parseInline(raw.trim()) })
  }
  return lines
}

function lineText(line: Line): string {
  return line.segs.map(s => s.text).join('')
}

function count(text: string): number {
  return text.replace(/\s+/g, '').length
}

// 不标注的段落显示出来的文字：表格去掉竖线和分隔行，代码块不算
function shownText(md: string, kind: ChunkKind): string {
  if (kind === 'code' || kind === 'rule') return ''
  const out: string[] = []
  let inFence = false
  for (const raw of md.split('\n')) {
    if (FENCE.test(raw)) {
      inFence = !inFence
      continue
    }
    if (inFence || (kind === 'table' && TABLE_RULE.test(raw))) continue
    out.push(plain(raw.replace(/^\s{0,3}#{1,6}\s+/, '').replace(/^\s*([-*+]|\d{1,9}[.)]|>)\s+/, '').replace(/\|/g, ' ')))
  }
  return out.join('\n')
}

export function analyze(md: string): Unit[] {
  return splitChunks(md).map(c => {
    const lines = c.kind === 'code' || c.kind === 'rule' || c.kind === 'table' ? null : toLines(c.md, c.kind)
    const text = lines ? lines.map(lineText).join('\n') : shownText(c.md, c.kind)
    return { kind: c.kind, md: c.md, lines, text, size: count(text) }
  })
}

// ---------- 在文字里找重点 ----------

// 只留字母、数字和汉字（统一成小写），记下每个留下来的字在原文里的起止位置
function letters(s: string): { text: string; at: number[]; end: number[] } {
  let text = ''
  const at: number[] = []
  const end: number[] = []
  let i = 0
  for (const ch of s) {
    if (WORDCHAR.test(ch)) {
      const low = ch.toLowerCase()
      const kept = low.length === ch.length ? low : ch
      for (let k = 0; k < kept.length; k++) {
        text += kept[k]
        at.push(i)
        end.push(i + ch.length)
      }
    }
    i += ch.length
  }
  return { text, at, end }
}

const PUNCT = /[^\p{L}\p{N}\s]/u

// 关注句在 text 里第一次出现的位置。只比字母、数字和汉字，空白、标点和 Markdown 符号对不上也不要紧；
// 引文首尾带着标点（句号、引号、括号）时，把原文里对应的标点也算进去
export function findSentence(text: string, quote: string): [number, number] | undefined {
  const src = letters(text)
  const q = letters(quote).text
  if (q.length < 2) return undefined
  const k = src.text.indexOf(q)
  if (k < 0) return undefined
  let start = src.at[k]!
  let stop = src.end[k + q.length - 1]!
  const t = quote.trim()
  const tail = /[^\p{L}\p{N}\s]*$/u.exec(t)![0].length
  for (let n = 0; n < tail && stop < text.length && PUNCT.test(text[stop]!); n++) stop++
  const head = /^[^\p{L}\p{N}\s]*/u.exec(t)![0].length
  for (let n = 0; n < head && start > 0 && PUNCT.test(text[start - 1]!); n++) start--
  return [start, stop]
}

const ASCII_WORD = /[A-Za-z0-9_]/

function lowerAscii(s: string): string {
  return s.replace(/[A-Z]/g, c => c.toLowerCase())
}

// 关注词在 text 里每一次出现的位置（英文不分大小写，也不截半个单词）；一次都对不上时，退回按关注句的办法找一次
export function findWords(text: string, word: string): [number, number][] {
  const needle = lowerAscii(word.trim())
  if (!needle) return []
  const hay = lowerAscii(text)
  const out: [number, number][] = []
  for (let from = 0; ; ) {
    const k = hay.indexOf(needle, from)
    if (k < 0) break
    const end = k + needle.length
    const cuts =
      (ASCII_WORD.test(needle[0]!) && k > 0 && ASCII_WORD.test(hay[k - 1]!)) ||
      (ASCII_WORD.test(needle[needle.length - 1]!) && end < hay.length && ASCII_WORD.test(hay[end]!))
    if (!cuts) out.push([k, end])
    from = end
  }
  if (!out.length) {
    const one = findSentence(text, word)
    if (one) out.push(one)
  }
  return out
}

// Claude 摘出来的文字可能带着 ** ` 这些符号：去掉符号、合并空白
export function cleanQuote(text: string): string {
  return plain(text).replace(/\s+/g, ' ').trim()
}

export type Range = { start: number; end: number; type: KpKind }

// 每个重点落在哪一段的哪里：关注句只标第一次出现，关注词每次出现都标；不标注的段落不找
export function place(units: readonly Unit[], items: readonly KpItem[]): Range[][] {
  const out: Range[][] = units.map(() => [])
  const placed = new Set<string>()
  for (const item of items) {
    const q = cleanQuote(item.text)
    if (!q) continue
    if (item.type === 'sentence') {
      if (placed.has(q)) continue
      for (let u = 0; u < units.length; u++) {
        if (!units[u]!.lines) continue
        const r = findSentence(units[u]!.text, q)
        if (!r) continue
        out[u]!.push({ start: r[0], end: r[1], type: 'sentence' })
        placed.add(q)
        break
      }
    } else {
      units.forEach((unit, u) => {
        if (unit.lines) for (const [start, end] of findWords(unit.text, q)) out[u]!.push({ start, end, type: 'word' })
      })
    }
  }
  return out
}

// 按 Claude 给的先后挑重点，挑到总量（关注句和关注词合起来，重叠的字只算一次）不超过正文的 limit 为止：
// 加上某一处会超，就跳过它，接着看后面更短的。原文里找不到的、重复的都丢掉
export function pick(md: string, items: readonly KpItem[], limit = LIMIT): KpItem[] {
  const units = analyze(md)
  const total = units.reduce((n, u) => n + u.size, 0)
  if (!total) return []
  const covered = units.map(() => new Set<number>())
  let used = 0
  const kept: KpItem[] = []
  const seen = new Set<string>()
  for (const item of items) {
    const text = cleanQuote(item.text)
    const key = `${item.type}:${text}`
    if (!text || seen.has(key)) continue
    seen.add(key)
    const ranges = place(units, [{ type: item.type, text }])
    if (!ranges.some(rs => rs.length)) continue
    const add = units.map(() => new Set<number>())
    let extra = 0
    ranges.forEach((rs, u) => {
      const shown = units[u]!.text
      for (const r of rs) {
        for (let p = r.start; p < r.end; p++) {
          if (/\s/.test(shown[p] ?? ' ') || covered[u]!.has(p) || add[u]!.has(p)) continue
          add[u]!.add(p)
          extra++
        }
      }
    })
    if ((used + extra) / total > limit) continue
    add.forEach((s, u) => s.forEach(p => covered[u]!.add(p)))
    used += extra
    kept.push({ type: item.type, text })
  }
  return kept
}

// ---------- 切成带样式的小段 ----------

export type Part = Seg & { sentence?: true; word?: true }
export type PaintedLine = { prefix: string; heading?: number; quote?: true; parts: Part[] }

// 按重点的起止位置把每行切开，标上它属于关注句还是关注词（两者可以重叠）
export function paint(unit: Unit, ranges: readonly Range[]): PaintedLine[] {
  let offset = 0
  return (unit.lines ?? []).map(line => {
    const parts: Part[] = []
    let pos = offset
    for (const seg of line.segs) {
      const from = pos
      const to = pos + seg.text.length
      const cuts = new Set([from, to])
      for (const r of ranges) {
        if (r.start > from && r.start < to) cuts.add(r.start)
        if (r.end > from && r.end < to) cuts.add(r.end)
      }
      const at = [...cuts].sort((a, b) => a - b)
      for (let k = 0; k + 1 < at.length; k++) {
        const a = at[k]!
        const b = at[k + 1]!
        const part: Part = { ...seg, text: seg.text.slice(a - from, b - from) }
        if (ranges.some(r => r.type === 'sentence' && r.start <= a && b <= r.end)) part.sentence = true
        if (ranges.some(r => r.type === 'word' && r.start <= a && b <= r.end)) part.word = true
        parts.push(part)
      }
      pos = to
    }
    offset = pos + 1 // 行与行之间的换行
    const painted: PaintedLine = { prefix: line.prefix, parts }
    if (line.heading) painted.heading = line.heading
    if (line.quote) painted.quote = true
    return painted
  })
}

function apply(props: Record<string, string | boolean>, style: KpStyle) {
  if (style.color) props.color = style.color
  if (style.backgroundColor) props.backgroundColor = style.backgroundColor
  if (style.underline) props.underline = true
}

// 一小段文字的 Text 样式：先照 Markdown 的样子（粗体、斜体、行内代码……），再叠上关注句、关注词的标注
export function textStyle(part: Part, line: PaintedLine, styles: KpStyles): Record<string, string | boolean> {
  const props: Record<string, string | boolean> = {}
  if (part.bold || line.heading) props.weight = 'bold'
  if (part.italic || line.heading === 1) props.italic = true
  if (line.heading === 1) props.underline = true
  if (part.strike) props.strikethrough = true
  if (part.code) props.color = 'permission'
  if (line.quote && !part.sentence && !part.word) {
    props.italic = true
    props.dimColor = true
  }
  if (part.sentence) apply(props, styles.sentence)
  if (part.word) apply(props, styles.word)
  return props
}
