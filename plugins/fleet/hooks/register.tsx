import { atom, read, update } from 'claude-code'
import type { EngineInterface, FsEntry, Register, Timer } from 'claude-code'

import type { FlJob, FlStatus } from '../types'

import { ago, createdAt, fit, lastReplyAt, nameOf, replyFallback, replyOf, sortJobs, statusOf, widthOf } from './jobs'
import type { JobState, Live } from './jobs'
import { NEWS_MAX, NEWS_ROWS, layout, scrolled } from './layout'

// fleet：/fleet 在右侧列出 claude agents 里的全部会话，不用回到 claude agents 也能看清各会话进行到哪了。
//
// - 每个会话一行：Claude 的菊花标 ✻（转动是运行中、黄色等你回复、绿色做完了）、名字、最近一次回复过了多久；
// - 最近回复过的排最上面：哪个会话一有新的回复，就跳到第一行；
// - 列表下面是最新消息区：别的会话有了新回复、你还没回去看过的，最近 6 条。所有会话共用一份“看过”的记录（$.store 里
//   seen:<会话短 id>）：你在哪个会话里打了字（或者那个会话刚启动），就记那个会话看过了，它从各处的最新消息区里移出去。
//   从 claude agents 打开一个还在跑的会话，插件看不出打开的是哪个（不发任何事件），所以只是打开、不打字，它还留着；
// - 会话的状态从 Claude Code 自己的文件里读（jobs.ts 开头有说明），面板开着时每 2 秒读一次；
// - 和 index 的目录一起停靠在右侧时，引擎把标签按打开的先后排，显示最后打开的那个。进入会话时两个都自动打开的，
//   默认显示会话：目录在会话之后打开，会话就关掉再打开一次，排到最后、显示出来。不用 focus 抬：
//   那样面板会拿走键盘，进入会话后打字没反应（用户实测）。
//   每段对话的右侧栏（开没开、显示哪个）记在本机，重新打开这段对话时照原样恢复（index 记它自己开没开）；
// - 读写都走插件接口，不调系统命令，所以 macOS、Windows、Linux 是同一套代码。

type $ = EngineInterface
type Seen = Live & { name: string; sessionId: string }

const PANE = 'fleet'
const TITLE = '会话'
// 停靠在右边时想要的宽度（用户拖动过的宽度优先）
const PANE_COLUMNS = 44
// 面板开着时多久重读一次会话
const POLL_MS = 2000
// 有会话在跑时菊花标每 250ms 换一帧；都没在跑时只让时长每秒走一下
const FRAME_MS = 250
const SECOND_MS = 1000
// 跑着的菊花标来回转，和 Claude Code 自己的转圈差不多。不用 ✳：有的字体会把它画成 emoji；
// 不用最大的 ✽：有的字体里它比一格宽，转到它时这一行会错位
const FRAMES = ['·', '✢', '✶', '✻', '✶', '✢']
const MARK = '✻'
const LOOK: Record<FlStatus, { color?: string; dim?: boolean }> = {
  running: { color: 'claude' },
  needs: { color: 'warning' },
  done: { color: 'success' },
  failed: { color: 'error' },
  stopped: { dim: true },
  idle: { dim: true },
}
const STORE_AUTO_OPEN = 'autoOpen'
// 每段对话的右侧栏状态：sidebar:<会话 id> → { open, shown, at }。一段对话一个键，几个会话同时写也不互相覆盖
const STORE_SIDEBAR = 'sidebar:'
// 你最后一次看某个会话的时间：seen:<会话短 id> → 毫秒；几个会话共用
const STORE_SEEN = 'seen:'
// 最新消息从什么时候算起
const STORE_NEWS_SINCE = 'newsSince'
const SIDEBAR_KEEP = 200
// index 的目录面板
const INDEX_PANE = 'index'
// 进入会话后多久之内目录打开，还算“一起自动打开”
const ENTRY_MS = 20000

// 会话级状态：写入会让读它的地方重画
const jobs = atom({ plugin: 'fleet', key: 'jobs' } as const, [])
const now = atom({ plugin: 'fleet', key: 'now' } as const, 0)
const autoOpen = atom({ plugin: 'fleet', key: 'autoOpen' } as const, false)
// 这个进程已经进过会话了：重新加载插件时 session.start 会再来一次，那时不再自动打开
const entered = atom({ plugin: 'fleet', key: 'entered' } as const, false)
// 最新消息区里的会话短 id，新的在前
const news = atom({ plugin: 'fleet', key: 'news' } as const, [])
const listTop = atom({ plugin: 'fleet', key: 'top' } as const, 0)

let poller: Timer | undefined
let ticker: Timer | undefined
let tickMs = 0
let isPolling = false
// 面板开着、正显示在屏幕上：只有这时才读文件、走动画
let isShown = false
let isAnyRunning = false
// 上一次画面板时列表的排版：翻动列表（ui.scroll）时按它算
let shape: { list: number; count: number } | undefined
// 上一次读成功的 state.json：碰上会话进程正在写、读到半截时用它
const lastGood = new Map<string, JobState>()
// 最近一次回复的时间。做完时状态文件里有；开始下一轮后状态文件里就删了，从这里接着用
const known = new Map<string, number>()
// 从 timeline.jsonl 读出来的时间，连同读的时候的状态：状态没变就不再读
const fromTimeline = new Map<string, { key: string; at: number | undefined }>()
// 现在这个会话的短 id（refresh 认出来的）
let selfId = ''
// 最新消息从这个时刻算起：第一次装上 fleet 的时候，免得把以前的回复全算成新消息
let newsSince = 0
// 正在关掉再打开会话面板，让它排到最后、显示出来：这一下不记右侧栏状态
let isMoving = false
// 进入会话时：这个时刻之前目录被自动打开，要不要把会话挪到最后显示出来（照上次的样子，没记过就挪）
let entryUntil = 0
let showAtEntry = true
// 上次记下的右侧栏状态，没变就不再写
let lastSidebar = ''

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

// ---------- 读会话 ----------

// Claude Code 的配置目录：设了 CLAUDE_CONFIG_DIR 就用它，否则是用户目录下的 .claude
async function configDir($: $): Promise<string | undefined> {
  const custom = await $.env.get('CLAUDE_CONFIG_DIR')
  if (custom) return custom.replace(/[\\/]+$/, '')
  // Windows 上 HOME 可能是 Git Bash 的写法（/c/Users/...），所以先用 USERPROFILE
  const isWindows = (await $.env.get('OS')) === 'Windows_NT'
  const home = isWindows
    ? (await $.env.get('USERPROFILE')) || (await $.env.get('HOME'))
    : (await $.env.get('HOME')) || (await $.env.get('USERPROFILE'))
  return home ? `${home.replace(/[\\/]+$/, '')}/.claude` : undefined
}

async function peek($: $, path: string): Promise<JobState | undefined> {
  try {
    const d: unknown = JSON.parse(await $.fs.read(path))
    return d && typeof d === 'object' && !Array.isArray(d) ? (d as JobState) : undefined
  } catch {
    return undefined
  }
}

async function list($: $, path: string): Promise<FsEntry[]> {
  try {
    return await $.fs.list(path)
  } catch {
    return []
  }
}

// 正在跑的后台会话进程：sessions/<pid>.json，按会话的短 id。只读 .json（旁边的 .key 是密钥，不碰）
async function readLive($: $, dir: string): Promise<Map<string, Seen>> {
  const live = new Map<string, Seen>()
  const files = (await list($, `${dir}/sessions`)).filter(f => f.kind === 'file' && f.name.endsWith('.json'))
  await Promise.all(
    files.map(async f => {
      const d = await peek($, `${dir}/sessions/${f.name}`)
      if (d?.kind !== 'bg' || !str(d.jobId)) return
      const since = typeof d.statusUpdatedAt === 'number' ? d.statusUpdatedAt : undefined
      live.set(str(d.jobId), { status: str(d.status), since, name: str(d.name), sessionId: str(d.sessionId) })
    }),
  )
  return live
}

// 最近一次回复的时间
async function doneAtOf($: $, dir: string, id: string, s: JobState, l: Live | undefined): Promise<number | undefined> {
  const reply = replyOf(s, l, known.get(id))
  let at: number | undefined
  if ('at' in reply) at = reply.at
  else {
    let cached = fromTimeline.get(id)
    if (cached?.key !== reply.timeline) {
      let found: number | undefined
      try {
        found = lastReplyAt(await $.fs.read(`${dir}/jobs/${id}/timeline.jsonl`))
      } catch {
        found = undefined // 没有这个文件，或者超过 4 MiB 读不了
      }
      cached = { key: reply.timeline, at: found }
      fromTimeline.set(id, cached)
    }
    at = cached.at ?? replyFallback(s, known.get(id))
  }
  if (at !== undefined) known.set(id, at)
  return at
}

// 你最后一次看这个会话的时间（几个会话共用：一个会话一个键，各写各的）
async function seenAt($: $, id: string): Promise<number> {
  try {
    return Number(await $.store.get(STORE_SEEN + id)) || 0
  } catch {
    return 0
  }
}

// 记下现在这个会话你看过了：它从各处的最新消息区里移出去
async function markSeen($: $) {
  try {
    if (!selfId) await refresh($)
    if (selfId) await $.store.set(STORE_SEEN + selfId, await $.clock.now())
  } catch {
    // 存不住只是它在别处的最新消息区里多留一会儿
  }
}

async function refresh($: $) {
  const dir = await configDir($)
  const sid = await $.session.id().catch(() => '')
  // 在后台会话里，CLAUDE_JOB_DIR 的最后一段就是自己的短 id；拿不到 session id 时用它认自己
  const jobDir = (await $.env.get('CLAUDE_JOB_DIR')) ?? ''
  const selfJob = jobDir.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? ''
  const entries = dir ? (await list($, `${dir}/jobs`)).filter(e => e.kind === 'dir') : []
  const live = dir ? await readLive($, dir) : new Map<string, Seen>()
  const rows = await Promise.all(
    entries.map(async (e): Promise<FlJob | undefined> => {
      const id = e.name
      const s = (await peek($, `${dir}/jobs/${id}/state.json`)) ?? lastGood.get(id)
      // 没有状态文件的（预先起好、还没用上的会话）claude agents 也不列
      if (!s) return undefined
      lastGood.set(id, s)
      const l = live.get(id)
      const doneAt = (await doneAtOf($, dir!, id, s, l)) ?? null
      const isSelf = sid ? [s.sessionId, s.resumeSessionId, l?.sessionId].includes(sid) : id === selfJob
      if (isSelf) selfId = id
      return { id, name: nameOf(s, l?.name), status: statusOf(s, l?.status), doneAt, sortAt: doneAt ?? createdAt(s), isSelf }
    }),
  )
  const next = sortJobs(rows.filter((r): r is FlJob => r !== undefined))
  isAnyRunning = next.some(j => j.status === 'running')
  const t = await $.clock.now()
  // 最新消息：别的会话在你上次看过它之后的回复，新的在前，最多 NEWS_MAX 条
  const fresh: string[] = []
  for (const j of next) {
    if (fresh.length >= NEWS_MAX) break
    if (j.isSelf || j.doneAt === null || j.doneAt <= newsSince) continue
    if (j.doneAt > (await seenAt($, j.id))) fresh.push(j.id)
  }
  await update($, now, () => t)
  if (JSON.stringify(await read($, jobs)) !== JSON.stringify(next)) await update($, jobs, () => next)
  if (JSON.stringify(await read($, news)) !== JSON.stringify(fresh)) await update($, news, () => fresh)
}

// ---------- 定时 ----------

// 画面多久动一次：有会话在跑时 250ms（菊花标转动），没有时 1 秒（时长走字），面板没显示时不动
function pace($: $) {
  const ms = !isShown ? 0 : isAnyRunning ? FRAME_MS : SECOND_MS
  if (ms === tickMs) return
  ticker?.cancel()
  ticker = undefined
  tickMs = ms
  if (ms) ticker = $.clock.every(ms, () => void tick($))
}

async function tick($: $) {
  if (!isShown) return
  try {
    const t = await $.clock.now()
    await update($, now, () => t)
  } catch {
    // 插件正在卸载、重新加载：下一下再说
  }
}

// 每 2 秒：看面板还开着、显示着没有；显示着就重读一遍会话
async function poll($: $) {
  if (isPolling) return
  isPolling = true
  try {
    const pane = (await $.ui.panes().catch(() => [])).find(p => p.id === PANE)
    isShown = !!pane?.isShown && !!pane.isPlaced
    if (isShown) await refresh($)
    pace($)
    // 打开会话面板、目录换位置的那一下不记，等稳定了再记
    if (!isMoving) await saveSidebar($, { open: !!pane, shown: !!pane?.isShown })
  } catch {
    // 插件正在卸载、重新加载，或者读文件出了错：下一次再读
  } finally {
    isPolling = false
  }
}

// 最新消息从什么时候算起：第一次用的时候记下，以后一直用它
async function loadNewsSince($: $) {
  try {
    const v = Number(await $.store.get(STORE_NEWS_SINCE))
    if (v > 0) newsSince = v
    else {
      newsSince = await $.clock.now()
      await $.store.set(STORE_NEWS_SINCE, newsSince)
    }
  } catch {
    newsSince = newsSince || (await $.clock.now())
  }
}

// ---------- 右侧栏 ----------

type Sidebar = { open: boolean; shown: boolean }

async function loadSidebar($: $): Promise<Sidebar | undefined> {
  try {
    const d = await $.store.get(STORE_SIDEBAR + (await $.session.id()))
    if (!d || typeof d !== 'object') return undefined
    const r = d as Record<string, unknown>
    return typeof r.open === 'boolean' ? { open: r.open, shown: r.shown !== false } : undefined
  } catch {
    return undefined
  }
}

async function saveSidebar($: $, v: Sidebar) {
  try {
    const key = STORE_SIDEBAR + (await $.session.id())
    const text = `${key} ${v.open} ${v.shown}`
    if (text === lastSidebar) return
    lastSidebar = text
    await $.store.set(key, { ...v, at: await $.clock.now() })
  } catch {
    // 存不住只影响下次打开这段对话
  }
}

// 右侧栏状态、看过的记录，各只留最近 SIDEBAR_KEEP 个
async function pruneSidebars($: $) {
  try {
    const all = await $.store.keys()
    for (const prefix of [STORE_SIDEBAR, STORE_SEEN]) {
      const keys = all.filter(k => k.startsWith(prefix))
      if (keys.length <= SIDEBAR_KEEP) continue
      const atOf = (v: unknown) => (typeof v === 'number' ? v : Number((v as { at?: unknown } | undefined)?.at) || 0)
      const ats = await Promise.all(keys.map(async k => ({ k, at: atOf(await $.store.get(k)) })))
      for (const { k } of ats.sort((a, b) => a.at - b.at).slice(0, keys.length - SIDEBAR_KEEP)) await $.store.delete(k)
    }
  } catch {
    // 清不掉也不要紧
  }
}

function openSelf($: $) {
  return $.ui.open({ id: PANE, title: TITLE, columns: PANE_COLUMNS })
}

// 把开着的会话面板显示到前面：引擎显示最后打开的那个，已经开着的再打开不会抬上来，带 focus 抬又会拿走键盘，
// 所以关掉再打开一次，排到最后一个标签
async function moveToFront($: $) {
  isMoving = true
  try {
    await $.ui.close({ id: PANE })
    return await openSelf($)
  } finally {
    isMoving = false
  }
}

// ---------- 命令 ----------

const USAGE = [
  '/fleet            打开或关闭会话总览',
  '/fleet auto on    进入会话时自动打开（启动、claude --resume、/clear 之后）',
  '/fleet auto off   不自动打开，要看时执行 /fleet（默认）',
  `列表里：转动的 ${MARK} 运行中，黄色 ${MARK} 等你回复，绿色 ${MARK} 做完了，红色 ${MARK} 出错了，灰色 ${MARK} 停掉了或空闲；`,
  '右边是最近一次回复过了多久，最近回复过的排最上面；',
  '列表下面是最新消息：进入这个会话以后，别的会话有了新回复，也列在这里（每次进入会话重新算）',
].join('\n')

async function saveSetting($: $, key: string, value: unknown) {
  try {
    await $.store.set(key, value)
  } catch {
    // 存不住只影响下次会话
  }
}

async function loadStore($: $) {
  try {
    const auto = await $.store.get(STORE_AUTO_OPEN)
    if (typeof auto === 'boolean') await update($, autoOpen, () => auto)
  } catch {
    // 读不到就用默认
  }
}

// 进入会话时自动打开（/fleet auto on）；这段对话记过右侧栏状态的，照记下的来（没开就不开）。
// 不是用户自己执行的，终端不够宽（144 列，用户用 /fleet 打开过的是 110 列）时引擎先不画，
// 拉宽终端或执行 /fleet 才出来；后台会话还没有界面连上时也先不画
async function openOnEnter($: $, saved?: Sidebar) {
  if (!(saved ? saved.open : await read($, autoOpen))) return
  if ((await $.ui.panes().catch(() => [])).some(p => p.id === PANE)) return
  await refresh($)
  const opened = await openSelf($).catch(() => undefined)
  if (opened && !opened.isPlaced) $.ui.log(`fleet: 会话总览先不显示（${opened.reason}）`, { to: 'debug' })
  void poll($)
}

async function toggle($: $, isFullscreen: boolean): Promise<string> {
  const pane = (await $.ui.panes().catch(() => [])).find(p => p.id === PANE)
  // 自动打开时没画出来的（终端不够宽）：这次是用户自己要的，再开一次就显示出来了
  if (pane?.isShown && pane.isPlaced) {
    await $.ui.close({ id: PANE })
    isShown = false
    pace($)
    await saveSidebar($, { open: false, shown: false })
    return '会话总览已关闭'
  }
  await refresh($)
  // 藏在别的面板后面的：挪到最后一个标签，显示出来
  if (pane?.isPlaced) {
    await moveToFront($)
    void poll($)
    return '会话总览已显示到前面'
  }
  const opened = await openSelf($)
  void poll($)
  if (!opened.isPlaced) return `会话总览已打开，但还没显示出来：${opened.reason}`
  return isFullscreen ? '会话总览已打开' : '会话总览已打开。现在不是全屏界面，它显示在输入框上方；执行 /tui fullscreen 可以停靠在右侧'
}

async function command($: $, args: string, isFullscreen: boolean): Promise<string> {
  const [first = '', second = ''] = args.trim().split(/\s+/).filter(Boolean)
  if (!first) return toggle($, isFullscreen)
  if (first === 'auto' && (second === 'on' || second === 'off')) {
    const isOn = second === 'on'
    await update($, autoOpen, () => isOn)
    await saveSetting($, STORE_AUTO_OPEN, isOn)
    return isOn ? '以后进入会话时自动打开会话总览（启动、claude --resume、/clear 之后）' : '以后进入会话时不再自动打开会话总览，要看时执行 /fleet'
  }
  return `${USAGE}\n\n现在的设置：进入会话时自动打开：${(await read($, autoOpen)) ? '开' : '关'}`
}

// ---------- 注册 ----------

export const register: Register = on => {
  // 每次加载从头来（测试里一个文件的几个测试共用这个模块）
  isMoving = false
  selfId = ''
  newsSince = 0
  entryUntil = 0
  showAtEntry = true
  lastSidebar = ''
  isPolling = false
  isShown = false
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await loadStore($)
    await $.command.register({
      name: 'fleet',
      description: '会话总览：在右侧打开或关闭 claude agents 里全部会话的状态列表',
      argumentHint: '[auto on|off]',
      immediate: true,
    })
    // 进程里第一次进会话（启动、--resume、后台会话）才自动打开；重新加载插件不算。
    // 记下的右侧栏状态要在定时器开始记新的之前读出来
    const isEntering = !(await read($, entered))
    const saved = isEntering ? await loadSidebar($) : undefined
    poller?.cancel()
    poller = $.clock.every(POLL_MS, () => void poll($))
    void poll($)
    await loadNewsSince($)
    if (isEntering) {
      // 会话刚启动（打开一个歇下来的会话、--resume）：你在看它
      void markSeen($)
      await update($, entered, () => true)
      showAtEntry = saved?.shown ?? true
      entryUntil = (await $.clock.now()) + ENTRY_MS
      // 不等它：这时界面可能还没起来，等着会拖住启动
      void openOnEnter($, saved).catch(() => undefined)
      void pruneSidebars($)
    }
    return started
  })

  // 远程的界面（手机、桌面端）连上来：你在看这个会话。claude attach、从 claude agents 打开不发这个事件
  on('session.attach', async ($, e, next) => {
    const attached = await next(e)
    void markSeen($)
    void poll($)
    return attached
  })

  // 你在这个会话里打了字（提问、斜杠命令）：你在看它
  on('prompt.submit', async ($, e, next) => {
    if (e.origin?.kind === 'composer') void markSeen($)
    return next(e)
  }).catch(($, e, next) => next(e))

  // /clear 之后是新的对话，也算进入会话：面板被关掉了就再打开
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') void openOnEnter($).catch(() => undefined)
    return next(e)
  })

  // 目录打开了：进入会话时和目录一起自动打开的，照上次的样子（没记过就显示会话）把会话挪到最后显示出来；
  // 别的时候是你自己打开的目录，就显示目录
  on('ui.open', { id: INDEX_PANE }, async ($, e, next) => {
    const opened = await next(e)
    const isEntry = entryUntil > 0 && (await $.clock.now()) < entryUntil
    if (isEntry) {
      entryUntil = 0
      const mine = (await $.ui.panes().catch(() => [])).find(p => p.id === PANE)
      if (mine?.isPlaced && !mine.isShown && showAtEntry) await moveToFront($)
    }
    return opened
  }).catch(($, e, next) => next(e))

  // 列表由插件自己翻（最新消息区不能被滚走）：滚轮、翻页键只改列表从第几个画起，引擎的窗口不动
  on('ui.scroll', { requestId: PANE }, async ($, e) => {
    if (!shape) return {}
    const top = await read($, listTop)
    const moved = scrolled(shape.list, shape.count, top, e.by)
    if (moved !== top) await update($, listTop, () => moved)
    return {}
  }).catch(() => ({}))

  // presentation 是引擎填的；没填（比如测试里）就当是全屏
  on('command.run', { command: 'fleet' }, async ($, e) => ({ text: await command($, e.args, e.presentation?.isFullscreen !== false) }))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const all = await read($, jobs)
    const t = await read($, now)
    const newsIds = await read($, news)
    const width = Math.max(20, e.props.bodyColumns)
    const room = Math.max(8, e.props.scroll.bodyRows)
    const frame = FRAMES[Math.floor(t / FRAME_MS) % FRAMES.length]!
    const count = (s: FlStatus) => all.filter(j => j.status === s).length
    const parts = [`${all.length} 个会话`]
    if (count('running')) parts.push(`${count('running')} 运行中`)
    if (count('needs')) parts.push(`${count('needs')} 等你回复`)
    // 最新消息（refresh 里挑好的），照会话现在的样子画
    const fresh = newsIds.flatMap(id => all.filter(j => j.id === id))
    const plan = layout(room, all.length, await read($, listTop))
    shape = { list: all.length, count: plan.count }
    const dim = (text: string) => <Text dimColor>{fit(text, width)}</Text>

    // 一行：菊花标和空格两格，名字，至少空一格，时长靠右
    const row = (j: FlJob, key: string) => {
      const look = LOOK[j.status]
      const time = j.doneAt === null ? '-' : ago(t - j.doneAt)
      const self = j.isSelf ? ' 当前' : ''
      const nameRoom = Math.max(4, width - 2 - widthOf(self) - 1 - widthOf(time))
      return (
        <Box key={key} flexDirection="row" justifyContent="space-between">
          <Text wrap="truncate-end">
            <Text color={look.color} dimColor={look.dim}>{`${j.status === 'running' ? frame : MARK} `}</Text>
            {fit(j.name || '（未命名）', nameRoom)}
            {self && <Text dimColor>{self}</Text>}
          </Text>
          <Text dimColor>{time}</Text>
        </Box>
      )
    }
    const more = (n: number, where: string) => dim(n ? `${where}还有 ${n} 个（滚动列表翻看）` : ' ')
    // 停靠在右边时，最新消息区贴着面板底边，空着的地方留在列表下面；在输入框上方时面板按内容的高度来，不用补
    const used = 1 + plan.count + (plan.isCut ? 2 : 0) + NEWS_ROWS
    const gap = e.props.placement === 'dock' ? Math.max(0, room - used) : 0

    return (
      <Box flexDirection="column">
        {dim(all.length ? parts.join(' · ') : 'claude agents 里还没有会话')}
        {plan.isCut && more(plan.top, '↑ 上面')}
        {all.slice(plan.top, plan.top + plan.count).map(j => row(j, `job-${j.id}`))}
        {plan.isCut && more(all.length - plan.top - plan.count, '↓ 下面')}
        {gap > 0 && <Box key="gap" height={gap} />}
        {dim('─'.repeat(width))}
        <Text weight="bold">最新消息</Text>
        {fresh.length ? fresh.map(j => row(j, `news-${j.id}`)) : dim('别的会话有新回复时会列在这里')}
        {/* 区域固定 NEWS_MAX 行高：不满时补空行，来了新消息列表也不跳 */}
        {Array.from({ length: NEWS_MAX - Math.max(1, fresh.length) }, () => dim(' '))}
      </Box>
    )
  })
}
