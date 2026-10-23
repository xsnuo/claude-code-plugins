// index 的纯逻辑，不碰 $：
// - 从对话记录里切出一轮轮的“提问 + 最终回复”；
// - 算目录里显示的文字（按终端格子算宽度，汉字占两格）；
// - 给 Claude 写摘要的提示词，读它的回答；
// - 把目录项和界面上那一行提问对上号（界面上那一行的 id 才能用来跳转）。

export type Msg = {
  role: 'user' | 'assistant'
  text: string
  toolResults?: readonly unknown[]
  toolUses?: readonly { tool_use_id: string }[]
}
// 一轮：key 用来和界面上那一行对上号；prompt 是显示用的提问；answer 是这轮最后一段文字（最终回复）；
// at 是提问在对话记录里的位置（第几条消息），往上翻找时用来比较先后
export type Turn = { key: string; prompt: string; answer: string; at: number }

// ---------- 切分 ----------

const INTERRUPTED = /^\[Request interrupted by user/
// 引擎自己插进对话里的 user 消息：任务通知、提醒、本地命令的输出、! 命令、别的会话发来的消息等
const ENGINE_TAG = /^<([a-z]+-)+[a-z]+[\s>]/
const OTHER_SENDER = /^Another Claude session/

// 斜杠命令在记录里是 <command-name>/x</command-name><command-args>…</command-args>，还原成“/x …”
export function commandLine(text: string): string | undefined {
  if (!text.startsWith('<command-')) return undefined
  const name = /<command-name>\/?([^<]*)<\/command-name>/.exec(text)?.[1]?.trim()
  if (!name) return undefined
  const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1]?.trim()
  return args ? `/${name} ${args}` : `/${name}`
}

export function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

// 对号用的 key：去掉所有空白，取前 60 个字
export function keyOf(s: string): string {
  return s.replace(/\s+/g, '').slice(0, 60)
}

// 你每次提问开始一轮，下一次提问之前 Claude 的最后一段文字是这一轮的最终回复。
// 任务通知、别的会话发来的消息这些也是 user 消息：它们不进目录，但会结束上一轮（后面的回复不算上一轮的）。
// 斜杠命令：触发了回复的（技能、提示词命令）算一轮；/clear、/reload-plugins 这类本地命令没有回复，不算。
// isRunning：最后一轮还在回答，这时还没有回复的命令也先留着
export function splitTurns(rows: readonly Msg[], isRunning = false): Turn[] {
  const out: (Turn & { isCommand: boolean })[] = []
  let cur: (Turn & { isCommand: boolean }) | undefined
  for (const [at, row] of rows.entries()) {
    if (row.role === 'assistant') {
      if (cur && row.text.trim()) cur.answer = row.text
      continue
    }
    if (row.toolResults?.length) continue
    const t = row.text.trim()
    if (!t || INTERRUPTED.test(t)) continue
    const cmd = commandLine(t)
    if (cmd) cur = { key: keyOf(cmd), prompt: cmd, answer: '', at, isCommand: true }
    else if (ENGINE_TAG.test(t) || OTHER_SENDER.test(t)) cur = undefined
    else cur = { key: keyOf(t), prompt: t, answer: '', at, isCommand: false }
    if (cur) out.push(cur)
  }
  return out
    .filter((t, i) => !t.isCommand || t.answer || (isRunning && i === out.length - 1))
    .map(({ key, prompt, answer, at }) => ({ key, prompt, answer, at }))
}

// 最后一条 user 消息是不是目录里的一轮：是任务通知、别的会话发来的消息时，正在跑的那一轮不是目录里的最后一项
export function endsWithTurn(rows: readonly Msg[]): boolean {
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i]!
    if (row.role !== 'user' || row.toolResults?.length) continue
    const t = row.text.trim()
    if (!t || INTERRUPTED.test(t)) continue
    return !!commandLine(t) || !(ENGINE_TAG.test(t) || OTHER_SENDER.test(t))
  }
  return false
}

// 回复、工具调用、命令这些行在对话记录里的位置：界面画出它们那一行时，就知道那一行在哪一轮、在提问的上面还是下面。
// 工具调用按 tool_use_id，回复和命令按文字（文字重复的不算，分不清是哪一条）
export type Places = { tools: Map<string, number>; texts: Map<string, number> }

export function placesOf(rows: readonly Msg[]): Places {
  const tools = new Map<string, number>()
  const texts = new Map<string, number>()
  const twice = new Set<string>()
  rows.forEach((row, at) => {
    if (row.role === 'user' && row.toolResults?.length) return
    row.toolUses?.forEach((use, j) => tools.set(use.tool_use_id, at + (j + 1) / 1000))
    const t = row.text.trim()
    const key = keyOf(row.role === 'user' ? (commandLine(t) ?? t) : t)
    if (!key) return
    if (texts.has(key)) twice.add(key)
    texts.set(key, at)
  })
  for (const key of twice) texts.delete(key)
  return { tools, texts }
}

// 由原文算出的 id（FNV-1a）：同一段回复在历史里、重新加载后都是同一个
export function hashOf(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0
  return `${h.toString(16)}-${text.length}`
}

// ---------- 显示 ----------

// 没有摘要时的替补：回复里第一句像样的话（去掉代码块和 Markdown 符号）
export function headOf(answer: string): string {
  const lines = answer.replace(/```[\s\S]*?(```|$)/g, '\n').split('\n')
  for (const raw of lines) {
    const line = raw
      .replace(/^\s*(#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)+/, '')
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/(\*\*|__|`|~~)/g, '')
      .replace(/^\|.*\|$/, '')
      .trim()
    if (line && !/^[-=:|\s]+$/.test(line)) return line.slice(0, 200)
  }
  return ''
}

// 一个字在终端里占几格：汉字、全角符号、大部分 emoji 占两格
const WIDE: [number, number][] = [
  [0x1100, 0x115f], [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf], [0x4e00, 0x9fff],
  [0xa000, 0xa4cf], [0xac00, 0xd7a3], [0xf900, 0xfaff], [0xfe30, 0xfe4f], [0xff00, 0xff60],
  [0xffe0, 0xffe6], [0x1f300, 0x1f64f], [0x1f900, 0x1f9ff], [0x20000, 0x3fffd],
]

export function cellWidth(ch: string): number {
  const c = ch.codePointAt(0) ?? 0
  if (c < 0x1100) return 1
  return WIDE.some(([a, b]) => c >= a && c <= b) ? 2 : 1
}

export function widthOf(s: string): number {
  let w = 0
  for (const ch of s) w += cellWidth(ch)
  return w
}

// 截到 width 格以内，截掉了就以 … 结尾
export function fit(s: string, width: number): string {
  if (widthOf(s) <= width) return s
  let w = 0
  let out = ''
  for (const ch of s) {
    const cw = cellWidth(ch)
    if (w + cw > width - 1) break
    out += ch
    w += cw
  }
  return `${out}…`
}

// 断行时不想拆开的字符：英文、数字和版本号、路径里常见的符号
const WORDISH = /[\w.\-/:@#%+~]/

// 折成最多 maxLines 行，每行不超过 width 格；英文单词、版本号尽量不拆开，放不下的最后一行以 … 结尾
export function wrapLines(s: string, width: number, maxLines: number): string[] {
  const lines: string[] = []
  let rest = oneLine(s)
  while (rest && lines.length < maxLines) {
    if (lines.length === maxLines - 1 || widthOf(rest) <= width) {
      lines.push(fit(rest, width))
      break
    }
    let w = 0
    let cut = 0
    for (const ch of rest) {
      const cw = cellWidth(ch)
      if (w + cw > width) break
      w += cw
      cut += ch.length
    }
    // 断在英文单词、版本号、路径中间时，退回到这个词的开头（词太长、这一行会剩不到三分之一就不退了）
    let start = cut
    while (start > 0 && WORDISH.test(rest[start - 1]!)) start--
    if (WORDISH.test(rest[cut] ?? '') && start < cut && widthOf(rest.slice(0, start)) >= width / 3) cut = start
    lines.push(rest.slice(0, cut).trimEnd())
    rest = rest.slice(cut).trimStart()
  }
  return lines
}

// ---------- 摘要 ----------

const QUESTION_MAX = 1500
const ANSWER_HEAD = 6000
const ANSWER_TAIL = 2000

function clip(s: string, head: number, tail = 0): string {
  return s.length <= head + tail ? s : `${s.slice(0, head)}\n……\n${tail ? s.slice(-tail) : ''}`
}

export function summaryPrompt(question: string, answer: string): string {
  return [
    '【这是 index 插件在后台发起的请求，用来给对话目录写摘要，不是用户的新消息。不要调用任何工具，不要寒暄。】',
    '',
    '<question> 是用户的一次提问，<reply> 是对这次提问的最终回复。请给 <reply> 写一句摘要，放进对话目录里，让人扫一眼就知道这一轮的结果：',
    '- 说结论、做了什么或建议了什么，不要复述提问；',
    '- 用 <reply> 的语言写；中文不超过 40 个字，其他语言不超过 25 个词；',
    '- 不要以“回复”“用户”“我”“Claude”开头，不要 Markdown、引号和句末的句号；',
    '- 例如：“改用 haiku 写摘要，测试已通过，还没提交”“aload 只能在 Mac 上用，tag 改几处就能跨平台”。',
    '- 直接输出这一句摘要本身，不要“摘要：”之类的开头，也不要别的内容。',
    '',
    '<question>',
    clip(question, QUESTION_MAX),
    '</question>',
    '',
    '<reply>',
    clip(answer, ANSWER_HEAD, ANSWER_TAIL),
    '</reply>',
  ].join('\n')
}

// 读 Claude 写的摘要：取第一行像样的话，去掉 Markdown 符号、引号和句末句号；读不出返回 ''
export function cleanSummary(raw: string): string {
  const line = headOf(raw)
    // 模型偶尔先说一句“摘要：”“需要概括这一轮的结果：”再给正文
    .replace(/^[^:：]{0,20}(摘要|总结|概括|结果|结论|summary)[^:：]{0,6}[:：]\s*/i, '')
    .replace(/^(这一轮|这轮|本轮)的?(结论|结果)?(是|为)?[，,：:\s]*/, '')
    .replace(/^(用户的|该|这轮|本轮|这条|此)?(回复|回答)(中|里)?[，,：:\s]*/, '')
    .replace(/^["'“‘「『]+|["'”’」』]+$/g, '')
    .replace(/[。.]$/, '')
    .trim()
  return line.slice(0, 120)
}

// ---------- 对号 ----------

export type Known = { id: string; key: string }

// 很长的提问只比前面一段：界面上的写法和记录里的偶尔有出入（比如带图片时）
const LOOSE = 20

// 给每个目录项找界面上那一行的 id。known 是见过的提问行，按在对话里的先后排。
// 按文字对：文字只出现一次的直接对上，先后排错了也不要紧；
// 文字相同的几轮（比如几次“继续”）按先后从后往前一一对应：最近的几次总是先画出来的
export function assignIds(keys: readonly string[], known: readonly Known[]): (string | undefined)[] {
  const out: (string | undefined)[] = keys.map(() => undefined)
  const used = new Set<string>()
  const groups = new Map<string, number[]>()
  keys.forEach((k, i) => groups.set(k, [...(groups.get(k) ?? []), i]))
  for (const [k, at] of groups) {
    const ids = known.filter(r => r.key === k).map(r => r.id)
    for (let a = at.length - 1, b = ids.length - 1; a >= 0 && b >= 0; a--, b--) {
      out[at[a]!] = ids[b]
      used.add(ids[b]!)
    }
  }
  keys.forEach((k, i) => {
    if (out[i] || k.length < LOOSE) return
    const row = known.findLast(r => !used.has(r.id) && r.key.length >= LOOSE && r.key.slice(0, LOOSE) === k.slice(0, LOOSE))
    if (!row) return
    out[i] = row.id
    used.add(row.id)
  })
  return out
}
