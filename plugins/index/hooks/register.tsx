import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderSurface, SiteView } from 'claude-code'

import type { IxFavorite, IxSummary, IxTurn } from '../types'

import { FAVORITES_MAX, clipText, completed, favoriteOf, matchFavorites, nthOf, readSaved, withSession } from './favorites'
import { locate, reveal } from './jump'
import type { JumpIO } from './jump'
import { fitCount, lastTop, scrolled } from './layout'
import { Rows } from './rows'
import { assignIds, cleanSummary, endsWithTurn, fit, hashOf, headOf, keyOf, oneLine, placesOf, splitTurns, summaryPrompt, wrapLines } from './turns'

// index：/index 在右侧弹出本次会话的目录，每一轮一项：提问的缩略、回答的摘要。点一项，左边的对话就跳到那次提问。
//
// - 目录由 $.session.messages() 切出来；摘要在后台请 Claude（haiku）写，一轮一次，写好的存进 $.store，下次不再写；
// - 跳转用 $.ui.scroll 把那一行提问翻到屏幕顶上。它要那一行的 id，而对话记录里没有 id，
//   所以插件记下界面画过的每一行提问（rows.ts），按文字和目录对上号；
//   还没画过的（太早的、往上翻才会画的），就从它下面离它最近的、画过的一行开始往上翻，直到它被画出来（jump.ts）；
// - 收藏（favorites.ts）：点一项前面的 ☆ 收藏、★ 取消。收藏缓存着那一轮的内容和界面上那一行的 id，
//   固定在目录顶上，列表怎么翻都不会把它滚走（所以目录列表由插件自己翻，layout.ts）；/clear 之后清空；
// - 设置（存进 $.store，下次会话照样用）：摘要是否请 Claude 写、进入会话时是否自动打开目录、提问最多折成几行；
// - 点击和翻动对话都只在全屏界面（/tui fullscreen）里有效。

type $ = EngineInterface

const PANE = 'index'
const TITLE = '目录'
// 停靠在右边时想要的宽度（用户拖动过的宽度优先）
const PANE_COLUMNS = 50
const TURNS_MAX = 300
const SUMMARY_LINES = 2
// 提问最多折成几行：默认 2，/index lines 可以改成 1 到 PROMPT_LINES_MAX
const PROMPT_LINES = 2
const PROMPT_LINES_MAX = 5
const HOVER = { color: 'suggestion' }
const STAR = '★'
const NO_STAR = '☆'
const STAR_COLOR = 'warning'
// 固定在顶上的收藏最多占目录的多少
const PINNED_SHARE = 0.4

// 摘要：先用快的模型，用不了（账号没有、报错、超时）就换下一个，最后用当前会话的模型。只写别名，跟着升级
const SUMMARY_MODELS = ['haiku', 'sonnet'] as const
const SUMMARY_TIMEOUT_MS = 30000
// 同时写几条
const PARALLEL = 2
// 存进 $.store 的摘要最多留多少条
const SAVED_MAX = 500
const STORE_SUMMARIES = 'summaries'
const STORE_USE_MODEL = 'useModel'
const STORE_AUTO_OPEN = 'autoOpen'
const STORE_PROMPT_LINES = 'promptLines'
// 各段对话的收藏（会话 id → 收藏），重开、恢复会话后还在
const STORE_FAVORITES = 'favorites'

// 会话级状态：写入会让读它的地方重画
const turns = atom({ plugin: 'index', key: 'turns' } as const, [])
const running = atom({ plugin: 'index', key: 'running' } as const, false)
const summaries = atom({ plugin: 'index', key: 'summaries' } as const, {})
const useModel = atom({ plugin: 'index', key: 'useModel' } as const, true)
const autoOpen = atom({ plugin: 'index', key: 'autoOpen' } as const, false)
const promptLines = atom({ plugin: 'index', key: 'promptLines' } as const, PROMPT_LINES)
// 这个进程已经进过会话了：重新加载插件时 session.start 会再来一次，那时不再自动打开
const entered = atom({ plugin: 'index', key: 'entered' } as const, false)
const favorites = atom({ plugin: 'index', key: 'favorites' } as const, [])
const listView = atom({ plugin: 'index', key: 'view' } as const, { top: 0, follow: true })

const rows = new Rows()
// 写摘要要用的提问和回复原文（按回复的 hash）。只在内存里，重新加载后由 refresh() 补回
const sources = new Map<string, { question: string; answer: string }>()
// $.store 里存着的摘要（跨会话）：hash → 摘要
let saved: Record<string, string> = {}
const queue: string[] = []
// 正在写的摘要（按回复的 hash）
const writing = new Set<string>()
// 上次写成摘要的是第几个模型：下次从它开始（重新加载插件后从头来）
let modelFrom = 0
let jumping = false
// 主对话有一轮正在跑（turn.start 到 turn.complete 之间）
let isTurnRunning = false
// 上一次画目录时列表区的排版：每一项几行、列表区几行。翻动目录（ui.scroll）时按它算翻到第几项
let layout: { heights: number[]; room: number } | undefined

// ---------- 目录 ----------

async function isOpen($: $, placedOnly = true): Promise<boolean> {
  try {
    return (await $.ui.panes()).some(p => p.id === PANE && (!placedOnly || p.isPlaced))
  } catch {
    return false
  }
}

// 从对话记录重新切一遍目录
async function refresh($: $) {
  let msgs
  try {
    msgs = await $.session.messages()
  } catch {
    return
  }
  const list = splitTurns(msgs, isTurnRunning).slice(-TURNS_MAX)
  // 目录最后一项还在回答：跑着的这一轮是它（不是任务通知之类引起的）
  const isLive = isTurnRunning && endsWithTurn(msgs)
  if ((await read($, running)) !== isLive) await update($, running, () => isLive)
  sources.clear()
  const next: IxTurn[] = list.map(t => {
    const hash = t.answer.trim() ? hashOf(t.answer) : ''
    if (hash) sources.set(hash, { question: t.prompt, answer: t.answer })
    return { key: t.key, prompt: oneLine(t.prompt).slice(0, 400), hash, head: headOf(t.answer) }
  })
  if (JSON.stringify(await read($, turns)) !== JSON.stringify(next)) await update($, turns, () => next)
  await syncFavorites($)
  if (await isOpen($)) await summarizeAll($)
}

// ---------- 摘要 ----------

async function summarizeAll($: $) {
  const list = await read($, turns)
  const isRunning = await read($, running)
  const sums = await read($, summaries)
  const isOn = await read($, useModel)
  // 收藏里缓存着的摘要也算写过的（比如恢复会话时从 $.store 读回来的）
  const cached = new Map((await read($, favorites)).filter(f => f.hash && f.summary).map(f => [f.hash, f.summary]))
  const known: Record<string, IxSummary> = {}
  const todo: string[] = []
  list.forEach((t, i) => {
    // 还在回答的那一轮先不写
    if (!t.hash || sums[t.hash] || (isRunning && i === list.length - 1)) return
    const text = saved[t.hash] ?? cached.get(t.hash)
    if (text) known[t.hash] = { status: 'done', text }
    else if (isOn) todo.push(t.hash)
  })
  if (Object.keys(known).length) await update($, summaries, all => ({ ...all, ...known }))
  // 新的先写：打开目录时看到的是最后几轮
  for (const hash of todo.reverse()) if (!queue.includes(hash) && !writing.has(hash)) queue.push(hash)
  pump($)
}

function pump($: $) {
  while (writing.size < PARALLEL && queue.length) {
    const hash = queue.shift()!
    writing.add(hash)
    void summarizeOne($, hash).finally(() => {
      writing.delete(hash)
      pump($)
    })
  }
}

async function setSummary($: $, hash: string, s: IxSummary) {
  await update($, summaries, all => ({ ...all, [hash]: s }))
}

async function summarizeOne($: $, hash: string) {
  const src = sources.get(hash)
  if (!src) return
  // 目录已经关了：还没开始写的都不写了
  if (!(await isOpen($))) {
    queue.length = 0
    return
  }
  await setSummary($, hash, { status: 'loading', text: '' })
  const text = await askSummary($, src.question, src.answer)
  await setSummary($, hash, text ? { status: 'done', text } : { status: 'error', text: '' })
  if (!text) return
  await remember($, hash, text)
  await syncFavorites($)
}

async function askSummary($: $, question: string, answer: string): Promise<string> {
  const models: string[] = [...SUMMARY_MODELS]
  try {
    models.push(await $.session.model())
  } catch {
    // 拿不到当前模型，就只试上面几个
  }
  const prompt = summaryPrompt(question, answer)
  for (let i = Math.min(modelFrom, models.length - 1); i < models.length; i++) {
    try {
      const r = await $.model.complete({ model: models[i]!, prompt, effort: 'low', maxTokens: 300, timeoutMs: SUMMARY_TIMEOUT_MS })
      const text = r.isAnswered ? cleanSummary(r.text) : ''
      if (text) {
        modelFrom = i
        return text
      }
    } catch {
      // 这个模型用不了（比如账号没有权限），试下一个
    }
  }
  return ''
}

async function remember($: $, hash: string, text: string) {
  delete saved[hash]
  saved[hash] = text
  const keys = Object.keys(saved)
  for (const k of keys.slice(0, Math.max(0, keys.length - SAVED_MAX))) delete saved[k]
  try {
    await $.store.set(STORE_SUMMARIES, saved)
  } catch {
    // 存不住只影响下次会话，这次照样显示
  }
}

async function loadStore($: $) {
  try {
    const s = await $.store.get(STORE_SUMMARIES)
    if (s && typeof s === 'object' && !Array.isArray(s)) {
      saved = Object.fromEntries(Object.entries(s).filter(([, v]) => typeof v === 'string')) as Record<string, string>
    }
    const flag = await $.store.get(STORE_USE_MODEL)
    if (typeof flag === 'boolean') await update($, useModel, () => flag)
    const auto = await $.store.get(STORE_AUTO_OPEN)
    if (typeof auto === 'boolean') await update($, autoOpen, () => auto)
    const n = await $.store.get(STORE_PROMPT_LINES)
    if (isLines(n)) await update($, promptLines, () => n)
  } catch {
    // 读不到就用默认
  }
}

// ---------- 收藏 ----------

// 写好的摘要（没有就是 undefined）
function summaryFor(sums: Record<string, IxSummary>, hash: string): string | undefined {
  if (!hash) return undefined
  const s = sums[hash]
  return s?.status === 'done' ? s.text : saved[hash]
}

// 改收藏：状态里一份，$.store 里按会话 id 存一份（重开、恢复会话后还在）
async function setFavorites($: $, items: IxFavorite[]) {
  await update($, favorites, () => items)
  try {
    const sid = await $.session.id()
    await $.store.set(STORE_FAVORITES, withSession(readSaved(await $.store.get(STORE_FAVORITES)), sid, items, Date.now()))
  } catch {
    // 存不住只影响重开会话后还在不在，这次照样有
  }
}

async function loadFavorites($: $) {
  // 热重载后状态里还在，不用读
  if ((await read($, favorites)).length) return
  try {
    const items = readSaved(await $.store.get(STORE_FAVORITES))[await $.session.id()]?.items
    if (items?.length) await update($, favorites, () => items)
  } catch {
    // 读不到就当没有
  }
}

// 收藏时还在回答的那几轮答完了，补上回答；摘要写好了，也缓存一份
async function syncFavorites($: $) {
  const favs = await read($, favorites)
  if (!favs.length) return
  const list = await read($, turns)
  const isLive = await read($, running)
  const sums = await read($, summaries)
  const at = new Map([...matchFavorites(list, favs)].map(([i, j]) => [j, i]))
  const next = favs.map((f, j) => {
    let g = f
    const i = at.get(j)
    const t = i === undefined ? undefined : list[i]!
    if (t && !g.hash && t.hash && !(isLive && i === list.length - 1)) g = completed(g, t, sources.get(t.hash))
    const summary = summaryFor(sums, g.hash)
    if (summary && summary !== g.summary) g = { ...g, summary }
    return g
  })
  if (next.some((g, j) => g !== favs[j])) await setFavorites($, next)
}

// 点一项前面的 ☆ / ★：收藏或取消
async function star($: $, index: number, key: string) {
  const list = await read($, turns)
  const i = list[index]?.key === key ? index : list.findIndex(t => t.key === key)
  if (i < 0) return
  const favs = await read($, favorites)
  const j = matchFavorites(list, favs).get(i)
  if (j !== undefined) return setFavorites($, favs.filter((_, k) => k !== j))
  if (favs.length >= FAVORITES_MAX) {
    $.ui.toast(`最多收藏 ${FAVORITES_MAX} 轮，先取消几个`)
    return
  }
  const t = list[i]!
  const isLive = (await read($, running)) && i === list.length - 1
  const summary = summaryFor(await read($, summaries), t.hash) ?? ''
  // 界面上那一行已经认得就记下来，以后直接跳
  const id = assignIds(
    list.map(x => x.key),
    rows.order,
  )[i]
  await setFavorites($, [...favs, favoriteOf(t, nthOf(list, i), sources.get(t.hash), summary, isLive, id)])
}

// 点收藏栏里的 ★：取消
async function unstar($: $, j: number, key: string) {
  const favs = await read($, favorites)
  const k = favs[j]?.key === key ? j : favs.findIndex(f => f.key === key)
  if (k >= 0) await setFavorites($, favs.filter((_, x) => x !== k))
}

// 跳转时找到了（或者发现不对了）那一行的 id：记进收藏
async function rememberId($: $, fav: IxFavorite, id: string | undefined) {
  const favs = await read($, favorites)
  const k = favs.findIndex(f => f.key === fav.key && f.hash === fav.hash && f.nth === fav.nth)
  if (k < 0 || favs[k]!.id === id) return
  const next = [...favs]
  const { id: _old, ...rest } = favs[k]!
  next[k] = id ? { ...rest, id } : rest
  await setFavorites($, next)
}

// 点收藏栏里的一项：这一轮还在目录里就跳过去；压缩对话时去掉了，就把缓存的提问和回答复制到剪贴板
async function jumpFavorite($: $, j: number, key: string, view: SiteView, surface: RenderSurface) {
  const favs = await read($, favorites)
  const k = favs[j]?.key === key ? j : favs.findIndex(f => f.key === key)
  const fav = favs[k]
  if (!fav) return
  const list = await read($, turns)
  const i = [...matchFavorites(list, favs)].find(([, x]) => x === k)?.[0]
  if (i !== undefined) return jump($, i, list[i]!.key, view)
  const copied = await $.ui.copy({ text: clipText(fav), surface }).catch(() => ({ isCopied: false }))
  $.ui.toast(
    copied.isCopied
      ? '这一轮压缩对话时从界面上去掉了，跳不过去；缓存的提问和回答已复制到剪贴板'
      : '这一轮压缩对话时从界面上去掉了，跳不过去',
  )
}

// ---------- 跳转 ----------

function explain(deny: string): string {
  if (/person-initiated/i.test(deny)) return '只有你自己点的时候才能跳转'
  if (/no-surface/i.test(deny)) return '现在没有可以跳转的界面'
  if (/moved meanwhile/i.test(deny)) return '对话刚好在滚动，再点一次'
  if (/nothing drawn/i.test(deny)) return '没找到这一轮在界面上的位置：可能被折叠了，或者压缩对话时去掉了'
  return `跳不过去（${deny}）。跳转只在全屏界面里有效：/tui fullscreen`
}

async function jump($: $, index: number, key: string, view: SiteView) {
  if (jumping) return
  jumping = true
  try {
    // 正在看子代理的对话：先回到主对话
    if (view.agentId !== undefined) {
      const back = await $.ui.view({})
      if (back.deny) {
        $.ui.toast(`回不到主对话：${back.deny}`)
        return
      }
    }
    // 重新切一遍目录：要知道每一轮在对话记录里的位置，也顺便查清回复、工具调用各在哪
    let msgs
    try {
      msgs = await $.session.messages()
    } catch {
      return
    }
    const list = splitTurns(msgs, isTurnRunning).slice(-TURNS_MAX)
    const toc = { keys: list.map(t => t.key), at: list.map(t => t.at) }
    const i = list[index]?.key === key ? index : toc.keys.indexOf(key)
    if (i < 0) return
    const places = placesOf(msgs)
    // 收藏过的一轮记着界面上那一行的 id，直接跳，不用往上翻找
    const favs = await read($, favorites)
    const fj = matchFavorites(await read($, turns), favs).get(i)
    const fav = fj === undefined ? undefined : favs[fj]
    const io: JumpIO = {
      scroll: async (id, block) => (await $.ui.scroll({ to: { requestId: id }, block })).deny,
      sleep: ms => $.clock.sleep(ms),
      toast: text => $.ui.toast(text, { timeoutMs: 2000 }),
      debug: text => $.ui.log(text, { to: 'debug' }),
    }
    // 找到的那一行要是已经不在界面上了（比如压缩对话后），忘掉它，再找一次
    for (let attempt = 0; attempt < 2; attempt++) {
      const found = fav?.id && attempt === 0 ? { id: fav.id } : await locate(rows, toc, places, i, io)
      if ('miss' in found) {
        $.ui.toast(
          found.miss === 'far'
            ? '离得比较远，还没翻到这一轮。再点一次，接着往上找'
            : '没找到这一轮在界面上的位置：可能被折叠了，或者压缩对话时去掉了',
        )
        return
      }
      const deny = 'deny' in found ? found.deny : await reveal(rows, found.id, io)
      if (!deny) {
        if (fav && 'id' in found) await rememberId($, fav, found.id)
        return
      }
      if (!/nothing drawn/i.test(deny) || !('id' in found)) {
        $.ui.toast(explain(deny))
        return
      }
      rows.forget(found.id)
      if (fav?.id === found.id) await rememberId($, fav, undefined)
    }
  } finally {
    jumping = false
  }
}

// ---------- 命令 ----------

const USAGE = [
  '/index                打开或关闭对话目录',
  '/index summary on     摘要请 Claude 来写（默认，用 haiku，一轮写一次，写过的会记住）',
  '/index summary off    不请 Claude 写，摘要用回复的第一句',
  '/index auto on        进入会话时自动打开目录（启动、claude --resume、/clear 之后）',
  '/index auto off       不自动打开，要看时执行 /index（默认）',
  `/index lines N        提问最多折成几行，1 到 ${PROMPT_LINES_MAX}（默认 ${PROMPT_LINES}）`,
  '在目录里点一项前面的 ☆ 收藏这一轮，点 ★ 取消；收藏固定在目录顶上，/clear 之后清空',
].join('\n')

function isLines(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= PROMPT_LINES_MAX
}

// 设置存进 $.store，下次会话照样用
async function saveSetting($: $, key: string, value: unknown) {
  try {
    await $.store.set(key, value)
  } catch {
    // 存不住只影响下次会话
  }
}

async function usage($: $): Promise<string> {
  const now = [
    `摘要：${(await read($, useModel)) ? 'Claude 写' : '回复的第一句'}`,
    `进入会话时自动打开：${(await read($, autoOpen)) ? '开' : '关'}`,
    `提问最多 ${await read($, promptLines)} 行`,
  ]
  return `${USAGE}\n\n现在的设置：${now.join(' · ')}`
}

// 进入会话时自动打开（/index auto on）。不是用户自己执行的，终端不够宽（144 列，用户用 /index 打开过的是 110 列）时引擎先不画，
// 拉宽终端或执行 /index 才出来；后台会话还没有界面连上时也先不画，连上时（session.attach）再写摘要
async function openOnEnter($: $) {
  if (!(await read($, autoOpen))) return
  if ((await $.ui.panes().catch(() => [])).some(p => p.id === PANE)) return
  await update($, listView, () => ({ top: 0, follow: true }))
  const opened = await $.ui.open({ id: PANE, title: TITLE, columns: PANE_COLUMNS }).catch(() => undefined)
  if (opened && !opened.isPlaced) $.ui.log(`index: 目录先不显示（${opened.reason}）`, { to: 'debug' })
  await summarizeAll($)
}

async function toggle($: $, isFullscreen: boolean): Promise<string> {
  const pane = (await $.ui.panes().catch(() => [])).find(p => p.id === PANE)
  // 自动打开时没画出来的（终端不够宽）：这次是用户自己要的，再开一次就画出来了
  if (pane?.isShown && pane.isPlaced) {
    await $.ui.close({ id: PANE })
    queue.length = 0
    return '目录已关闭'
  }
  // 上次没写成的摘要，这次再试
  const sums = await read($, summaries)
  if (Object.values(sums).some(s => s.status === 'error')) {
    await update($, summaries, old => Object.fromEntries(Object.entries(old).filter(([, s]) => s.status !== 'error')))
  }
  await refresh($)
  // 停在最后几轮；之后新加的轮次也跟着显示出来
  await update($, listView, () => ({ top: 0, follow: true }))
  const opened = await $.ui.open({ id: PANE, title: TITLE, columns: PANE_COLUMNS })
  await summarizeAll($)
  if (!opened.isPlaced) return `目录已打开，但还没显示出来：${opened.reason}`
  return isFullscreen ? '目录已打开，点一项就跳到那次提问' : '目录已打开。现在不是全屏界面，点击跳转用不了，可以先执行 /tui fullscreen'
}

async function command($: $, args: string, isFullscreen: boolean): Promise<string> {
  const [first = '', second = ''] = args.trim().split(/\s+/).filter(Boolean)
  if (!first) return toggle($, isFullscreen)
  if (first === 'summary' && (second === 'on' || second === 'off')) {
    const isOn = second === 'on'
    await update($, useModel, () => isOn)
    await saveSetting($, STORE_USE_MODEL, isOn)
    if (isOn && (await isOpen($))) await summarizeAll($)
    if (!isOn) queue.length = 0
    return isOn ? '摘要改由 Claude 来写（用 haiku，一轮写一次）' : '摘要不再请 Claude 写，改用回复的第一句'
  }
  if (first === 'auto' && (second === 'on' || second === 'off')) {
    const isOn = second === 'on'
    await update($, autoOpen, () => isOn)
    await saveSetting($, STORE_AUTO_OPEN, isOn)
    return isOn ? '以后进入会话时自动打开目录（启动、claude --resume、/clear 之后）' : '以后进入会话时不再自动打开目录，要看时执行 /index'
  }
  if (first === 'lines' && second) {
    const n = Number(second)
    if (!isLines(n)) return `行数要是 1 到 ${PROMPT_LINES_MAX} 的整数，比如 /index lines ${PROMPT_LINES}`
    await update($, promptLines, () => n)
    await saveSetting($, STORE_PROMPT_LINES, n)
    return n === 1 ? '提问只显示一行，放不下的截掉' : `提问最多折成 ${n} 行，放不下的截掉`
  }
  return usage($)
}

// ---------- 画目录 ----------

function summaryOf(t: IxTurn, s: IxSummary | undefined, isLive: boolean, isOn: boolean): string {
  if (isLive) return '⋯ 回答中'
  if (!t.hash) return '（没有文字回复）'
  if (isOn && s?.status === 'done') return s.text
  if (isOn && s?.status === 'loading') return `⋯ ${t.head}`
  return t.head || '（没有文字回复）'
}

// ---------- 注册 ----------

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    // 重新加载后，正在写的摘要已经没人管了：改回没写过，打开目录时重写
    const sums = await read($, summaries)
    if (Object.values(sums).some(s => s.status === 'loading')) {
      await update($, summaries, old => Object.fromEntries(Object.entries(old).filter(([, s]) => s.status !== 'loading')))
    }
    await loadStore($)
    await loadFavorites($)
    await $.command.register({
      name: 'index',
      description: '对话目录：在右侧打开或关闭本次会话的目录，点一项跳到那次提问',
      argumentHint: '[summary on|off] [auto on|off] [lines N]',
      immediate: true,
    })
    await refresh($)
    // 进程里第一次进会话（启动、--resume、后台会话）才自动打开；重新加载插件不算。
    // 不等它：这时界面可能还没起来，等着会拖住启动
    if (!(await read($, entered))) {
      await update($, entered, () => true)
      void openOnEnter($)
    }
    return started
  })

  // 后台会话自动打开的目录，要等界面连上（claude attach）才画出来：那时再写摘要
  on('session.attach', async ($, e, next) => {
    const attached = await next(e)
    if (await isOpen($)) void summarizeAll($)
    return attached
  })

  // 主对话一轮开始、结束时更新目录（子代理的不算）。不等它更新完，免得拖慢对话
  on('turn.start', async ($, e, next) => {
    const started = await next(e)
    if (e.agentId === undefined) {
      if (e.text) rows.started(e.text, Date.now())
      isTurnRunning = true
      void refresh($)
    }
    return started
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId === undefined) {
      isTurnRunning = false
      void refresh($)
    }
    return done
  })

  // /clear 之后是新的对话：目录和收藏都清空，记下的行也作废
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      rows.reset()
      queue.length = 0
      sources.clear()
      isTurnRunning = false
      await update($, turns, () => [])
      await update($, running, () => false)
      await update($, favorites, () => [])
      await update($, listView, () => ({ top: 0, follow: true }))
      try {
        await $.store.set(STORE_FAVORITES, withSession(readSaved(await $.store.get(STORE_FAVORITES)), e.sessionId, [], Date.now()))
      } catch {
        // 删不掉也不要紧：新的对话是新的会话 id，读不到这些
      }
      // 新的对话也算进入会话：目录被关掉了就再打开
      void openOnEnter($)
    }
    return next(e)
  })

  // presentation 是引擎填的；没填（比如测试里）就当是全屏
  on('command.run', { command: 'index' }, async ($, e) => ({ text: await command($, e.args, e.presentation?.isFullscreen !== false) }))

  // 记下界面画过的行：提问行用来对号，回复和工具调用的行在往上翻找时当落脚点
  on('ui.render', { component: 'UserMessage' }, ($, e, next) => {
    rows.user(e.requestId, e.props.text, e.props.onScreen, Date.now())
    return next(e)
  })

  on('ui.render', { component: 'AssistantMessage' }, ($, e, next) => {
    rows.other(e.requestId, [keyOf(e.props.text)], e.props.onScreen, Date.now())
    return next(e)
  })

  // 工具调用那一行的 id 就是 tool_use_id；折起来的一组按组里的调用
  on('ui.render', { component: 'ToolUse' }, ($, e, next) => {
    rows.other(e.requestId, [e.requestId], e.props.onScreen, Date.now())
    return next(e)
  })

  on('ui.render', { component: 'ToolGroup' }, ($, e, next) => {
    const ids = e.props.calls.flatMap(c => (c.tool_use_id ? [c.tool_use_id] : []))
    rows.other(e.requestId, ids, e.props.onScreen, Date.now())
    return next(e)
  })

  // 目录列表由插件自己翻（收藏固定在顶上，不能跟着滚走）：滚轮、翻页键只改列表最上面是第几项，引擎的窗口不动
  on('ui.scroll', { requestId: PANE }, async ($, e) => {
    if (!layout) return {}
    const v = await read($, listView)
    const top = v.follow ? lastTop(layout.heights, layout.room) : v.top
    const moved = scrolled(layout.heights, layout.room, top, e.by)
    if (moved.top !== v.top || moved.follow !== v.follow) await update($, listView, () => moved)
    return {}
  }).catch(() => ({}))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const list = await read($, turns)
    const sums = await read($, summaries)
    const isRunning = await read($, running)
    const isOn = await read($, useModel)
    const favs = await read($, favorites)
    const v = await read($, listView)
    const maxLines = await read($, promptLines)
    const width = Math.max(16, e.props.bodyColumns)
    const room = Math.max(8, e.props.scroll.bodyRows)
    const view = e.props.view
    // 不在全屏界面时目录放在输入框上方，点击和翻动对话都用不了
    const isDocked = e.props.placement === 'dock'
    const favOf = matchFavorites(list, favs)
    const turnOf = new Map([...favOf].map(([i, j]) => [j, i]))
    const numWidth = String(Math.max(1, list.length)).length
    // 每一项：☆（两格）、序号、提问；摘要缩进到提问下面
    const inner = width - 2 - (numWidth + 1)
    const pad = ' '.repeat(numWidth + 1)
    const isLive = (i: number) => isRunning && i === list.length - 1
    const textOf = (t: IxTurn, i: number) => summaryOf(t, sums[t.hash], isLive(i), isOn)
    const num = (i: number | undefined) => `${(i === undefined ? '-' : String(i + 1)).padStart(numWidth)} `
    // 提问折成最多 maxLines 行：第一行跟在序号后面，后面几行缩进到和它对齐
    const promptOf = (text: string) => {
      const q = wrapLines(text, inner, maxLines)
      return q.length ? q : ['']
    }
    const promptRows = (i: number | undefined, q: string[]) =>
      q.flatMap((line, k) => [
        ...(k ? ['\n'] : []),
        <Text dimColor hover={HOVER}>
          {k ? pad : num(i)}
        </Text>,
        <Text weight="bold" hover={HOVER}>
          {line}
        </Text>,
      ])

    // 最上面：说明
    const header = !list.length ? '还没有对话' : isDocked ? `共 ${list.length} 轮 · 点一项跳过去，点 ${NO_STAR} 收藏` : `共 ${list.length} 轮`
    const head = [<Text dimColor>{fit(header, width)}</Text>]
    if (!isDocked) head.push(<Text dimColor>{fit('全屏界面（/tui fullscreen）里才能点击跳转', width)}</Text>)

    // 收藏栏：固定在顶上，按在对话里的先后（压缩时去掉的排最前），每条是提问几行加摘要一行，最多占目录的 40%
    const order = favs.map((_, j) => j).sort((a, b) => (turnOf.get(a) ?? -1) - (turnOf.get(b) ?? -1))
    const favPrompts = new Map(order.map(j => [j, promptOf(favs[j]!.prompt)]))
    const shown: number[] = []
    let favRows = 0
    for (const j of order) {
      const h = favPrompts.get(j)!.length + 1
      if (shown.length && favRows + h > room * PINNED_SHARE - 2) break
      shown.push(j)
      favRows += h
    }
    const pinned = !favs.length
      ? []
      : [
          <Text color={STAR_COLOR}>{fit(`${STAR} 收藏 ${favs.length} 轮`, width)}</Text>,
          ...shown.map(j => {
            const f = favs[j]!
            const i = turnOf.get(j)
            const s = sums[f.hash]
            const brief =
              isOn && s?.status === 'done' ? s.text : (isOn && f.summary) || f.head || (f.hash ? '（没有文字回复）' : '⋯ 回答中')
            return (
              <Box key={`favrow-${j}`} flexDirection="row">
                <Button key={`fav-star-${j}`} label="取消收藏" plain onPress={() => unstar($, j, f.key)}>
                  <Text color={STAR_COLOR}>{`${STAR} `}</Text>
                </Button>
                <Button key={`fav-${j}`} plain onPress={press => jumpFavorite($, j, f.key, view, press.surface)}>
                  {promptRows(i, favPrompts.get(j)!)}
                  {'\n'}
                  <Text dimColor hover={HOVER}>
                    {pad + fit(i === undefined ? `已压缩 · ${brief}` : brief, inner)}
                  </Text>
                </Button>
              </Box>
            )
          }),
          ...(order.length > shown.length ? [<Text dimColor>{fit(`… 还有 ${order.length - shown.length} 轮，在下面的列表里标着 ${STAR}`, width)}</Text>] : []),
          <Text dimColor>{'─'.repeat(width)}</Text>,
        ]

    // 列表：放得下就全画；放不下就只画从 top 开始的几项，上下各一行说还有几轮
    const prompts = list.map(t => promptOf(t.prompt))
    const lines = list.map((t, i) => wrapLines(textOf(t, i), inner, SUMMARY_LINES))
    // 每一项：上面空一行，提问几行，摘要几行
    const heights = lines.map((l, i) => 1 + prompts[i]!.length + l.length)
    let listRoom = Math.max(3, room - head.length - pinned.length)
    let first = 0
    let count = list.length
    const isCut = heights.reduce((a, b) => a + b, 0) > listRoom
    if (isCut) {
      listRoom = Math.max(3, listRoom - 2)
      const max = lastTop(heights, listRoom)
      first = v.follow ? max : Math.min(v.top, max)
      count = fitCount(heights, listRoom, first)
    }
    layout = { heights, room: listRoom }
    const more = (n: number, where: string) => <Text dimColor>{n ? fit(`${where}还有 ${n} 轮（滚动目录翻看）`, width) : ' '}</Text>

    return (
      <Box flexDirection="column">
        {head}
        {pinned}
        {isCut && more(first, '↑ 上面')}
        {list.slice(first, first + count).map((t, k) => {
          const i = first + k
          const isFav = favOf.has(i)
          return (
            <Box key={`row-${i}`} flexDirection="row" marginTop={1}>
              <Button key={`star-${i}`} label={isFav ? '取消收藏' : '收藏'} plain onPress={() => star($, i, t.key)}>
                <Text color={isFav ? STAR_COLOR : undefined} dimColor={!isFav}>{`${isFav ? STAR : NO_STAR} `}</Text>
              </Button>
              <Button key={`turn-${i}`} plain onPress={() => jump($, i, t.key, view)}>
                {promptRows(i, prompts[i]!)}
                {lines[i]!.map(line => [
                  '\n',
                  <Text dimColor hover={HOVER}>
                    {pad + line}
                  </Text>,
                ])}
              </Button>
            </Box>
          )
        })}
        {isCut && more(list.length - first - count, '↓ 下面')}
      </Box>
    )
  })
}
