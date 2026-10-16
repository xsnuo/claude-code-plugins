import { atom, read, update } from 'claude-code'
import type { EngineInterface, ModelCompleteResult, ModelForkResult, Register, RenderElement } from 'claude-code'

import type { KpFinal, KpMark, KpStyle, KpStyles } from '../types'

import { drawBody } from './draw'
import { DEFAULT_STYLES, analyze, parseItems, pick, place, promptFor } from './marks'
import { countEngine, drawsPieces, replaceEngine } from './tree'

// key-points：每条最终回复末尾一个「📌 key points」，点了才标重点，再点取消。
// 点的时候带着整段对话和这条回复，在后台另问 Claude 一次（$.model.fork，不进对话记录、界面上不显示），
// 让它挑出关注句和关注词；插件在原文里找到它们，控制总量不超过正文的 25%，再改这条回复的画法把它们标出来。
// 存下来的回复原文一个字不动，取消标注就恢复原样。

type $ = EngineInterface

const LINK_KEY = 'key-points-link'
// 链接点了由插件接住，不会打开网页；.invalid 是保留域名，按住 ⌘ 点开也去不了任何地方
const LINK_URL = 'https://key-points.invalid/toggle'
const FINALS_MAX = 100
const STORE_KEY = 'styles'

// 会话级状态：写入会让读它的地方重画
const finals = atom({ plugin: 'key-points', key: 'finals' } as const, [])
const marks = atom({ plugin: 'key-points', key: 'marks' } as const, {})
const styles = atom({ plugin: 'key-points', key: 'styles' } as const, DEFAULT_STYLES)

// ---------- 最终回复 ----------

function flat(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

// 由回复原文算出的 id（FNV-1a）：同一条回复在历史里、重新加载后都是同一个
function idOf(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0
  return `${h.toString(16)}-${text.length}`
}

async function addFinals($: $, answers: string[]) {
  const add = answers.filter(a => a.trim()).map(text => ({ id: idOf(flat(text)), text, flat: flat(text) }))
  if (!add.length) return
  const fresh = new Set(add.map(a => a.id))
  const list = await update($, finals, old => [...old.filter(a => !fresh.has(a.id)), ...add].slice(-FINALS_MAX))
  // 丢掉已经不在列表里的回复的标注
  const keep = new Set(list.map(a => a.id))
  const all = await read($, marks)
  if (Object.keys(all).some(id => !keep.has(id))) {
    await update($, marks, old => Object.fromEntries(Object.entries(old).filter(([id]) => keep.has(id))))
  }
}

// 这一块属于哪条最终回复（最终回复可能拆成几块，链接放在最后一块下面）
function ownerOf(list: readonly KpFinal[], blockText: string): { final: KpFinal; isTail: boolean } | undefined {
  const t = flat(blockText)
  if (!t) return undefined
  for (let i = list.length - 1; i >= 0; i--) {
    const final = list[i]!
    if (final.flat.endsWith(t)) return { final, isTail: true }
    if (final.flat.includes(t)) return { final, isTail: false }
  }
  return undefined
}

// 历史回复：你每次提问之后、下一次提问之前，Claude 的最后一段文字就是那一轮的最终回复
// （任务通知、子代理回报这些也是 user 消息，但不算提问）
async function loadHistoryFinals($: $) {
  let rows
  try {
    rows = await $.session.messages()
  } catch {
    return
  }
  const answers: string[] = []
  let last = ''
  for (const row of rows) {
    if (row.role === 'user') {
      const t = row.text.trim()
      const isPrompt = !!t && !row.toolResults?.length && !t.startsWith('<') && !t.startsWith('Another Claude session')
      if (isPrompt) {
        if (last) answers.push(last)
        last = ''
      }
    } else if (row.text.trim()) last = row.text
  }
  if (last) answers.push(last)
  await addFinals($, answers)
}

// ---------- 标重点 ----------

async function setMark($: $, id: string, mark: KpMark) {
  await update($, marks, all => ({ ...all, [id]: mark }))
}

function failure(r: Exclude<ModelForkResult | ModelCompleteResult, { isAnswered: true }>): string {
  if (r.reason === 'api-error') return r.status ? `API ${r.status}` : 'network'
  if (r.reason === 'empty-reply') return 'no answer'
  if (r.reason === 'aborted') return 'interrupted'
  return r.reason
}

// 在后台问 Claude：带着整段对话（fork 走主对话的缓存），把这条回复原文附在问题里
async function ask($: $, final: KpFinal) {
  const prompt = promptFor(final.text)
  let result: ModelForkResult | ModelCompleteResult
  try {
    result = await $.model.fork({ prompt })
    // 还没有可以复制的对话（比如恢复会话后还没聊过）：退一步，只带这条回复去问
    if (!result.isAnswered && result.reason === 'nothing-to-fork') result = await $.model.complete({ model: await $.session.model(), prompt })
  } catch {
    await setMark($, final.id, { status: 'error', items: [], error: 'refused' })
    return
  }
  if (!result.isAnswered) {
    await setMark($, final.id, { status: 'error', items: [], error: failure(result) })
    return
  }
  const items = parseItems(result.text)
  if (!items) {
    await setMark($, final.id, { status: 'error', items: [], error: 'unreadable answer' })
    return
  }
  await setMark($, final.id, { status: 'on', items: pick(final.text, items) })
}

// 点链接：没标过就去问；标着就取消；取消过的直接再显示，不再花钱
async function press($: $, final: KpFinal) {
  const mark = (await read($, marks))[final.id]
  if (mark?.status === 'loading') return
  if (mark?.items.length && (mark.status === 'on' || mark.status === 'off')) {
    await setMark($, final.id, { ...mark, status: mark.status === 'on' ? 'off' : 'on' })
    return
  }
  await setMark($, final.id, { status: 'loading', items: [] })
  void ask($, final)
}

function label(mark: KpMark | undefined): string {
  if (mark?.status === 'loading') return '⏳ key points…'
  if (mark?.status === 'error') return `⚠️ key points: ${mark.error ?? 'failed'}, retry`
  if (mark?.status === 'on') return mark.items.length ? '📌 hide key points' : '📌 key points: none found'
  return '📌 key points'
}

// ---------- 标注方式 ----------

const THEME_KEYS = [
  'text', 'inverseText', 'inactive', 'subtle', 'suggestion', 'remember', 'success', 'error', 'warning', 'merged', 'claude',
  'permission', 'planMode', 'autoAccept', 'promptBorder', 'bashBorder', 'ide', 'diffAdded', 'diffRemoved',
  'diffAddedDimmed', 'diffRemovedDimmed', 'diffAddedWord', 'diffRemovedWord',
]
const BASIC = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white', 'gray', 'grey']
const COLOR_NAMES = [...BASIC, ...BASIC.slice(0, 8).map(c => `${c}Bright`)]
const ZH_COLORS: Record<string, string> = { 黑: 'black', 红: 'red', 绿: 'green', 黄: 'yellow', 蓝: 'blue', 紫: 'magenta', 青: 'cyan', 白: 'white', 灰: 'gray' }
const NONE = ['none', 'off', 'no', '无', '-']

// 认得的颜色：#RGB、#RRGGBB、颜色名（yellow、redBright）、主题色（warning、success）、中文单字（黄、红）。
// 返回 null 表示“不要”，undefined 表示认不出
function parseColor(raw: string): string | null | undefined {
  const v = raw.trim()
  if (NONE.includes(v.toLowerCase())) return null
  if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(v)) return v.toUpperCase()
  const zh = ZH_COLORS[v.replace(/色$/, '')]
  if (zh) return zh
  return [...THEME_KEYS, ...COLOR_NAMES].find(name => name.toLowerCase() === v.toLowerCase())
}

function validStyle(x: unknown, fallback: KpStyle): KpStyle {
  if (!x || typeof x !== 'object') return fallback
  const o = x as Record<string, unknown>
  const style: KpStyle = { underline: o.underline === true }
  for (const k of ['color', 'backgroundColor'] as const) {
    const c = typeof o[k] === 'string' ? parseColor(o[k] as string) : null
    if (c) style[k] = c
  }
  return style
}

async function loadStyles($: $) {
  let saved: unknown
  try {
    saved = await $.store.get(STORE_KEY)
  } catch {
    return
  }
  if (!saved || typeof saved !== 'object') return
  const o = saved as Record<string, unknown>
  const next: KpStyles = { sentence: validStyle(o.sentence, DEFAULT_STYLES.sentence), word: validStyle(o.word, DEFAULT_STYLES.word) }
  await update($, styles, () => next)
}

const KINDS: Record<string, keyof KpStyles> = { sentence: 'sentence', s: 'sentence', 句: 'sentence', 关注句: 'sentence', word: 'word', w: 'word', 词: 'word', 关注词: 'word' }
const NAMES: Record<keyof KpStyles, string> = { sentence: '关注句', word: '关注词' }

const USAGE = [
  '/key-points                                    查看当前的标注方式',
  '/key-points sentence|word color <颜色|none>    字体色',
  '/key-points sentence|word bg <颜色|none>       背景色',
  '/key-points sentence|word underline on|off     下划线',
  '/key-points reset                              恢复默认（关注句黄字；关注词荧光黄底、黑字）',
  '颜色可以写 #RRGGBB、颜色名（yellow、redBright）、主题色（warning、success）或中文（黄、红）。三种方式可以组合。',
].join('\n')

function describeStyle(s: KpStyle): string {
  return `字体色 ${s.color ?? '默认'}，背景色 ${s.backgroundColor ?? '无'}，下划线 ${s.underline ? '开' : '关'}`
}

function describe(st: KpStyles): string {
  return [`关注句：${describeStyle(st.sentence)}`, `关注词：${describeStyle(st.word)}`, '', USAGE].join('\n')
}

async function saveStyles($: $, next: KpStyles) {
  await update($, styles, () => next)
  try {
    await $.store.set(STORE_KEY, next)
  } catch {
    // 存不住只影响下次会话，这次照样生效
  }
}

async function command($: $, args: string): Promise<string> {
  const [first = '', prop = '', ...rest] = args.trim().split(/\s+/).filter(Boolean)
  const value = rest.join(' ')
  const current = await read($, styles)
  if (!first || first === 'status') return describe(current)
  if (first === 'reset') {
    await saveStyles($, DEFAULT_STYLES)
    return `已恢复默认。\n${describe(DEFAULT_STYLES)}`
  }
  const kind = KINDS[first.toLowerCase()]
  if (!kind) return USAGE
  const style: KpStyle = { ...current[kind] }
  if (prop === 'underline') {
    const on = ['on', 'yes', 'true', '开'].includes(value.toLowerCase())
    if (!on && !['off', 'no', 'false', '关'].includes(value.toLowerCase())) return `用法：/key-points ${kind} underline on|off`
    style.underline = on
  } else if (prop === 'color' || prop === 'bg' || prop === 'background') {
    const color = parseColor(value)
    if (color === undefined) return `认不出颜色「${value}」。\n${USAGE}`
    const k = prop === 'color' ? 'color' : 'backgroundColor'
    if (color === null) delete style[k]
    else style[k] = color
  } else return USAGE
  await saveStyles($, { ...current, [kind]: style })
  const warn = !style.color && !style.backgroundColor && !style.underline ? `\n注意：${NAMES[kind]}现在没有任何样式，标了也看不出来。` : ''
  return `${NAMES[kind]}：${describeStyle(style)}${warn}`
}

// ---------- 注册 ----------

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    // 重新加载后，正在进行的提问已经没了：把“正在标”改回没标过，可以重新点
    const all = await read($, marks)
    if (Object.values(all).some(m => m.status === 'loading')) {
      await update($, marks, old => Object.fromEntries(Object.entries(old).filter(([, m]) => m.status !== 'loading')))
    }
    await loadStyles($)
    await loadHistoryFinals($)
    await $.command.register({
      name: 'key-points',
      description: '标重点：设置关注句、关注词的标注方式（字体色、背景色、下划线）',
      argumentHint: '[sentence|word color|bg|underline <值> | reset]',
      immediate: true,
    })
    return started
  })

  // 一轮结束：记下这轮的最终回复（子代理的回合不算），它下面才出现 key points
  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (!e.agentId && e.reason === 'answer' && e.answer.trim()) await addFinals($, [e.answer])
    return done
  })

  on('command.run', { command: 'key-points' }, async ($, e) => ({ text: await command($, e.args) }))

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    if (e.props.isSummary || !e.props.text.trim()) return next(e)
    const owner = ownerOf(await read($, finals), e.props.text)
    if (!owner) return next(e)
    const mark = (await read($, marks))[owner.final.id]
    const inner = await next(e)
    let tree: RenderElement = inner
    if (mark?.status === 'on' && mark.items.length) {
      const units = analyze(e.props.text)
      const ranges = place(units, mark.items)
      if (ranges.some(r => r.length)) {
        const body = drawBody({ els: $.ui.resolve(e), surface: e.surface, isFirstOfReply: e.props.isFirstOfReply, units, ranges, styles: await read($, styles) })
        // 一般只把引擎画的正文换掉，里层插件在下面加的行（比如 aload 的 read aload）原样留着；
        // 里层有插件把正文拆开自己画了（比如 aload 的每段模式），标着重点时整条改由这里画，免得正文出现两遍
        tree = countEngine(inner) === 1 && !drawsPieces(inner, e.props.text) ? (replaceEngine(inner, body) as RenderElement) : body
      }
    }
    if (!owner.isTail) return tree
    // 链接在回复下面单独占一行。和别的插件（比如 aload）的链接上下排开，谁的文字变长变短都不会挤动别人
    const { Box, Markdown } = $.ui.resolve(e)
    const final = owner.final
    return (
      <Box flexDirection="column">
        {tree}
        <Box paddingLeft={2}>
          <Markdown key={LINK_KEY} text={`[${label(mark)}](${LINK_URL})`} onLinkPress={() => void press($, final)} />
        </Box>
      </Box>
    )
  })
}
