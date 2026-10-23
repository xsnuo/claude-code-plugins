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
// - 列表下面是最新消息区：进入这个会话以后，别的会话有了新回复，也列在这里。
//   从 claude agents 打开一个会话（或 claude attach）不发任何事件，但 Claude Code 每打开一次会话都会在
//   <配置目录>/daemon/attach-journal/ 记一个文件（不写是哪个会话）。人一次只看着一个会话，所以不管打开的是哪个，
//   都从那一刻重新算：打开的就是你现在看着的这个。会话进程启动、/clear 之后也重新算，也可以点标题清空；
// - 会话的状态从 Claude Code 自己的文件里读（jobs.ts 开头有说明），面板开着时每 2 秒读一次；
// - 和 index 的目录一起停靠在右侧时：会话的标签在前；进入会话时两个都自动打开，默认显示会话；
//   每段对话的右侧栏（开没开、显示哪个）记在本机，重新打开这段对话时照原样恢复（index 记它自己开没开）。
//   引擎把标签按打开的先后排，最后打开的那个显示在前面；目录在会话之后重新打开时，会话用 focus 重新打开一次抬到前面，
//   这样不改顺序（打字照样进输入框，CC 2.1.309 实测）。会话打开时目录已经开着，由 index 先关掉自己、等会话打开后再打开；
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
// 跑着的菊花标来回转，和 Claude Code 自己的转圈一样（不用 ✳：有的字体会把它画成 emoji）
const FRAMES = ['·', '✢', '✶', '✻', '✽', '✻', '✶', '✢']
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
const since = atom({ plugin: 'fleet', key: 'since' } as const, 0)
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
// 读过的打开记录：文件名 → 打开的时间（文件名就是这次打开的 id，内容不会再变）
const attaches = new Map<string, number | undefined>()
// 正在打开会话面板；这期间目录被重新打开过（index 为了让会话的标签排在前面，先关掉、再打开自己）
let isOpeningSelf = false
let indexReopened = false
// 进入会话时：这个时刻之前目录被自动打开，要不要把会话抬到前面（照上次的样子，没记过就抬）
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

// 最近一次打开会话（从 claude agents 打开、claude attach）的时间。打开记录是 Claude Code 未公开的内部文件，
// 一次打开一个文件，里面的 startedAtEpochMs 是打开的时间；结束后 Claude Code 会删掉一些，所以只往后挪
async function lastAttach($: $, dir: string): Promise<number | undefined> {
  const path = `${dir}/daemon/attach-journal`
  const files = (await list($, path)).filter(f => f.kind === 'file' && f.name.endsWith('.json'))
  let latest: number | undefined
  for (const f of files) {
    if (!attaches.has(f.name)) {
      const at = (await peek($, `${path}/${f.name}`))?.startedAtEpochMs
      attaches.set(f.name, typeof at === 'number' && Number.isFinite(at) ? at : undefined)
    }
    const at = attaches.get(f.name)
    if (at !== undefined && (latest === undefined || at > latest)) latest = at
  }
  return latest
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
      return { id, name: nameOf(s, l?.name), status: statusOf(s, l?.status), doneAt, sortAt: doneAt ?? createdAt(s), isSelf }
    }),
  )
  const next = sortJobs(rows.filter((r): r is FlJob => r !== undefined))
  isAnyRunning = next.some(j => j.status === 'running')
  const t = await $.clock.now()
  // 刚打开了一个会话：最新消息区从那一刻算起（不会算到将来去）
  const attachedAt = dir ? await lastAttach($, dir) : undefined
  if (attachedAt !== undefined && attachedAt > (await read($, since))) await update($, since, () => Math.min(attachedAt, t))
  await update($, now, () => t)
  if (JSON.stringify(await read($, jobs)) !== JSON.stringify(next)) await update($, jobs, () => next)
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
    if (!isOpeningSelf) await saveSidebar($, { open: !!pane, shown: !!pane?.isShown })
  } catch {
    // 插件正在卸载、重新加载，或者读文件出了错：下一次再读
  } finally {
    isPolling = false
  }
}

// 最新消息区从现在算起：进入会话时、/clear 之后、点了清空
async function resetNews($: $) {
  const t = await $.clock.now()
  await update($, since, () => t)
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

// 只留最近 SIDEBAR_KEEP 段对话的右侧栏状态
async function pruneSidebars($: $) {
  try {
    const keys = (await $.store.keys()).filter(k => k.startsWith(STORE_SIDEBAR))
    if (keys.length <= SIDEBAR_KEEP) return
    const ats = await Promise.all(keys.map(async k => ({ k, at: Number(((await $.store.get(k)) as { at?: unknown } | undefined)?.at) || 0 })))
    for (const { k } of ats.sort((a, b) => a.at - b.at).slice(0, keys.length - SIDEBAR_KEEP)) await $.store.delete(k)
  } catch {
    // 清不掉也不要紧
  }
}

// 把会话面板抬到前面：已经开着的再打开一次，带上 focus。标签顺序不变；输入框里有字、有对话框时引擎不抬，
// 刚启动时界面可能还没起来，所以看一眼抬上去没有，没有就隔一会儿再试
async function raise($: $) {
  for (let i = 0; i < 5; i++) {
    await $.ui.open({ id: PANE, title: TITLE, columns: PANE_COLUMNS, focus: true }).catch(() => undefined)
    const pane = (await $.ui.panes().catch(() => [])).find(p => p.id === PANE)
    if (!pane || pane.isShown) return
    await $.clock.sleep(400)
  }
}

// 打开会话面板。打开时目录开着的话，index 会先关掉目录、等这边打开后再打开它，标签就是会话在前，
// 但显示的成了目录：wantShown 时再把会话抬到前面
async function openSelf($: $, wantShown: boolean) {
  isOpeningSelf = true
  indexReopened = false
  let opened
  try {
    opened = await $.ui.open({ id: PANE, title: TITLE, columns: PANE_COLUMNS })
  } finally {
    isOpeningSelf = false
  }
  if (indexReopened && wantShown) await raise($)
  return opened
}

// ---------- 命令 ----------

const USAGE = [
  '/fleet            打开或关闭会话总览',
  '/fleet auto on    进入会话时自动打开（启动、claude --resume、/clear 之后）',
  '/fleet auto off   不自动打开，要看时执行 /fleet（默认）',
  `列表里：转动的 ${MARK} 运行中，黄色 ${MARK} 等你回复，绿色 ${MARK} 做完了，红色 ${MARK} 出错了，灰色 ${MARK} 停掉了或空闲；`,
  '右边是最近一次回复过了多久，最近回复过的排最上面；',
  '列表下面是最新消息：进入这个会话以后，别的会话有了新回复，也列在这里（点标题清空）',
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
  const opened = await openSelf($, showAtEntry).catch(() => undefined)
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
  // 藏在别的面板后面的：抬到前面
  if (pane?.isPlaced) {
    await raise($)
    void poll($)
    return '会话总览已显示到前面'
  }
  const opened = await openSelf($, true)
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
  isOpeningSelf = false
  indexReopened = false
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
    // 最新消息区从进入会话算起；从没算过的（比如从旧版本热重载过来）也从现在算
    if (isEntering || !(await read($, since))) await resetNews($)
    if (isEntering) {
      await update($, entered, () => true)
      showAtEntry = saved?.shown ?? true
      entryUntil = (await $.clock.now()) + ENTRY_MS
      // 不等它：这时界面可能还没起来，等着会拖住启动
      void openOnEnter($, saved).catch(() => undefined)
      void pruneSidebars($)
    }
    return started
  })

  // 远程的界面（手机、桌面端）连上来，也算打开了这个会话。claude attach、从 claude agents 打开不发这个事件
  on('session.attach', async ($, e, next) => {
    const attached = await next(e)
    await resetNews($)
    void poll($)
    return attached
  })

  // /clear 之后是新的对话，也算进入会话：最新消息区清空，面板被关掉了就再打开
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      await resetNews($)
      void openOnEnter($).catch(() => undefined)
    }
    return next(e)
  })

  // 目录打开了：会话面板正在打开（index 在给标签换位置），等会话打开完再决定显示哪个；
  // 进入会话时和目录一起自动打开的，照上次的样子（没记过就显示会话）把会话抬到前面；别的时候是你自己打开的目录，就显示目录
  on('ui.open', { id: INDEX_PANE }, async ($, e, next) => {
    const opened = await next(e)
    if (isOpeningSelf) {
      indexReopened = true
      return opened
    }
    const isEntry = entryUntil > 0 && (await $.clock.now()) < entryUntil
    if (isEntry && !e.focus) {
      entryUntil = 0
      const mine = (await $.ui.panes().catch(() => [])).find(p => p.id === PANE)
      if (mine && showAtEntry) await raise($)
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
    const { Box, Button, Text } = $.ui.resolve(e)
    const all = await read($, jobs)
    const t = await read($, now)
    const from = await read($, since)
    const width = Math.max(20, e.props.bodyColumns)
    const room = Math.max(8, e.props.scroll.bodyRows)
    const frame = FRAMES[Math.floor(t / FRAME_MS) % FRAMES.length]!
    const count = (s: FlStatus) => all.filter(j => j.status === s).length
    const parts = [`${all.length} 个会话`]
    if (count('running')) parts.push(`${count('running')} 运行中`)
    if (count('needs')) parts.push(`${count('needs')} 等你回复`)
    // 最新消息：别的会话在 since 之后的回复，只留最近 3 条（列表本来就按回复排，取出来的就是新的在上面）
    const news = all.filter(j => !j.isSelf && j.doneAt !== null && j.doneAt > from).slice(0, NEWS_MAX)
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
        {news.length ? (
          <Button key="news-clear" label="清空最新消息" plain onPress={() => resetNews($)}>
            <Text weight="bold">最新消息</Text>
            <Text dimColor>{fit(' · 点这里清空', width - 8)}</Text>
          </Button>
        ) : (
          <Text weight="bold">最新消息</Text>
        )}
        {news.length ? news.map(j => row(j, `news-${j.id}`)) : dim('别的会话有新回复时会列在这里')}
        {/* 区域固定 3 行高：不满 3 条时补空行，来了新消息列表也不跳 */}
        {Array.from({ length: NEWS_MAX - Math.max(1, news.length) }, () => dim(' '))}
      </Box>
    )
  })
}
