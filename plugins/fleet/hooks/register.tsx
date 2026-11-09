import { atom, read, update } from 'claude-code'
import type { EngineInterface, FsEntry, Register, Timer } from 'claude-code'

import type { FlJob, FlStatus } from '../types'

import { ago, createdAt, fit, judgeOpening, lastReplyAt, nameOf, openingOf, replyFallback, replyOf, sortJobs, statusOf, widthOf, workersOf } from './jobs'
import type { Clue, JobState, Live, Worker } from './jobs'
import { NEWS_MAX, NEWS_ROWS, layout, scrolled } from './layout'

// fleet：/fleet 在右侧列出 claude agents 里的全部会话，不用回到 claude agents 也能看清各会话进行到哪了。
//
// - 每个会话一行：Claude 的菊花标 ✻（转动是运行中、黄色等你回复、绿色做完了）、名字、最近一次回复过了多久；
// - 最近回复过的排最上面：哪个会话一有新的回复，就跳到第一行；
// - 列表下面是未读消息区：上次打开之后又回复了的会话，一个会话一条，再回复就挪到最上面，不限条数，显示最近 6 条。
//   所有会话共用一份：$.store 是几个会话共用的，seen:<会话短 id> 是你最后一次打开着它的时间，各会话照它算出来的
//   是同一份（只是不列自己：你看得见这个面板，就是正打开着这个会话）。
//   打开是从 Claude Code 的打开记录认出来的（watchOpen；记录里没有会话 id，用几条线索交叉核对，jobs.ts 的
//   judgeOpening），宁可多留、不错删：线索打架就不认。认出来的写在 $.store（open:<记录文件名>），各会话照同一份来；
//   打开着的会话回复了不算新消息，打开、关掉的那一刻记下 seen，它就从各处移出去。在会话里打了字、远程界面连上来，
//   也算打开着；打字时只开着一个会话，就用它核对：没认出来的认成它，认错了的改回来；
// - 会话的状态从 Claude Code 自己的文件里读（jobs.ts 开头有说明），面板开着时每 2 秒读一次；
//   打开记录不管面板开没开，每 2 秒都看一次；
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
// 你最后一次打开着某个会话的时间：seen:<会话短 id> → 毫秒；几个会话共用
const STORE_SEEN = 'seen:'
// 未读消息从什么时候算起
const STORE_NEWS_SINCE = 'newsSince'
// 0.2.4 记的“你正在看的会话”，现在不用了，清掉
const STORE_OLD_CURRENT = 'current'
// 认出来的打开记录：open:<打开记录的文件名> → { id, at, prev, opened }。几个会话共用：先认出来的写下，别的会话照它来，
// 认错了改它。at 是记下“看过”的时刻，prev 是那之前的“看过”，认错时改回去；opened 是打开的时刻
const STORE_OPEN = 'open:'
const SIDEBAR_KEEP = 200
// 一条打开记录连着在这么久，就不再当成开着（Claude Code 改了行为、claude agents 异常退出时，免得那个会话的回复一直被吞掉）
const OPEN_MAX_MS = 12 * 3600_000
// 认出来的打开记录留多久（关掉时一般就删了，这是兜底）
const OPEN_KEEP_MS = 2 * 86400_000
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
// 未读消息区里的会话短 id，新的在前
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
// 正打开着的会话（短 id），watchOpen 每 2 秒认一遍
let openIds = new Set<string>()
// 认出来的打开记录：文件名（这次打开的 id）→ 会话短 id。记录还在，打开的就还是它
const opens = new Map<string, string>()
// 每条打开记录上次认的结果，变了才写日志
const lastWhy = new Map<string, string>()
// 认不出的打开记录下次什么时候再认：打开一分钟以后，碰过的痕迹不会再有了，只等消息数（比如撞了的那个会话歇下来），
// 不用每 2 秒把各会话的文件看一遍
const nextTry = new Map<string, number>()
const RETRY_LATE_MS = 30000
const LATE_MS = 60000
// roster.json 里的会话进程，连同文件的修改时间：没改过就不再读
let roster: { mtimeMs: number; workers: Worker[] } | undefined
// 现在这个会话的短 id（refresh 认出来的）
let selfId = ''
// 未读消息从这个时刻算起：第一次装上 fleet 的时候，免得把以前的回复全算成新消息
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

// 你最后一次打开着这个会话的时间（几个会话共用：一个会话一个键）
async function seenAt($: $, id: string): Promise<number> {
  try {
    return Number(await $.store.get(STORE_SEEN + id)) || 0
  } catch {
    return 0
  }
}

// 你在这个会话里打了字、远程界面连上来：你在看它，它从各处的未读消息区里移出去
async function markSeen($: $) {
  try {
    if (!selfId) await refresh($)
    if (selfId) await $.store.set(STORE_SEEN + selfId, await $.clock.now())
  } catch {
    // 存不住只是它在别处的未读消息区里多留一会儿
  }
}

async function mtimeOf($: $, path: string): Promise<number | undefined> {
  try {
    return (await $.fs.stat(path)).mtimeMs
  } catch {
    return undefined
  }
}

async function journals($: $, dir: string): Promise<FsEntry[]> {
  return (await list($, `${dir}/daemon/attach-journal`)).filter(f => f.kind === 'file' && f.name.endsWith('.json'))
}

type OpenRecord = { id: string; at: number; prev: number; opened: number }

async function loadRecord($: $, name: string): Promise<OpenRecord | undefined> {
  try {
    const d = (await $.store.get(STORE_OPEN + name)) as Partial<OpenRecord> | undefined
    if (!d || typeof d.id !== 'string' || !d.id) return undefined
    return { id: d.id, at: Number(d.at) || 0, prev: Number(d.prev) || 0, opened: Number(d.opened) || 0 }
  } catch {
    return undefined
  }
}

// roster.json 里的会话进程：按文件的修改时间缓存，没改过不重读
async function readRoster($: $, dir: string): Promise<Worker[]> {
  const path = `${dir}/daemon/roster.json`
  const at = await mtimeOf($, path)
  if (!roster || at === undefined || roster.mtimeMs !== at) {
    const version = str((await peek($, `${dir}/daemon.lock`))?.version)
    roster = { mtimeMs: at ?? -1, workers: workersOf(await peek($, path), version) }
  }
  return roster.workers
}

// 在跑的会话进程的线索（jobs.ts 里有说明）：有没有 state.json、recap.trigger 和目录的修改时间。没在跑的不可能是刚打开的
async function cluesOf($: $, dir: string, workers: Worker[]): Promise<Clue[]> {
  return Promise.all(
    workers.map(async worker => {
      const job = `${dir}/jobs/${worker.id}`
      const state = await mtimeOf($, `${job}/state.json`)
      const isJob = state !== undefined || (await peek($, `${job}/state.json`)) !== undefined
      return { id: worker.id, isJob, worker, state, trigger: await mtimeOf($, `${job}/recap.trigger`), dir: await mtimeOf($, job) }
    }),
  )
}

// 认一条打开记录是哪个会话。认出来了写下（别的会话照它来），同时记下那个会话看过了，把原来的“看过”留着，认错时改回去。
// taken 是别的打开记录已经认走的
async function resolveOpening($: $, dir: string, name: string, entry: JobState | undefined, taken: Set<string>): Promise<string | undefined> {
  const o = openingOf(entry)
  if (!o) return undefined
  const t0 = await $.clock.now()
  if ((nextTry.get(name) ?? 0) > t0) return undefined
  if (t0 - o.at > LATE_MS) nextTry.set(name, t0 + RETRY_LATE_MS)
  // 还没连上、还没画出来的，不用去看各会话的文件
  const isReady = o.mark !== undefined || o.marksExpected === false
  const verdict = judgeOpening(o, isReady ? await cluesOf($, dir, await readRoster($, dir)) : [], taken)
  if (lastWhy.get(name) !== verdict.why) {
    lastWhy.set(name, verdict.why)
    $.ui.log(`fleet: 打开记录 ${name.slice(0, 8)} → ${verdict.id ?? '先不认'}（${verdict.why}）`, { to: 'debug' })
  }
  if (!verdict.id) return undefined
  // 别的会话刚认过：照它的
  const rec = await loadRecord($, name)
  if (rec) return rec.id
  const t = await $.clock.now()
  const prev = await seenAt($, verdict.id)
  await $.store.set(STORE_OPEN + name, { id: verdict.id, at: t, prev, opened: o.at })
  await $.store.set(STORE_SEEN + verdict.id, t)
  return verdict.id
}

// 认出现在打开着哪些会话。打开着的会话回复了不算新消息（refresh 里跳过）；关掉的那一刻记下 seen:<id>，它就从各处的
// 未读消息区里移出去（几个会话都在看同一份打开记录，谁先看到谁记，刚记过的别的会话就不再记）。
// 认出来的写在 $.store 里（open:<文件名>），几个会话照同一份来；改认了（认错了被改过来）、开了太久不再信的，都不算关掉
async function watchOpen($: $) {
  const dir = await configDir($)
  if (!dir) return
  const path = `${dir}/daemon/attach-journal`
  const files = await journals($, dir)
  const t = await $.clock.now()
  const next = new Map<string, string>()
  for (const f of files) {
    const rec = await loadRecord($, f.name)
    let id = rec?.id
    if (rec) {
      if (rec.opened && t - rec.opened > OPEN_MAX_MS) continue
    } else {
      const entry = await peek($, `${path}/${f.name}`)
      const o = openingOf(entry)
      if (o && t - o.at > OPEN_MAX_MS) continue
      id = opens.get(f.name) ?? (await resolveOpening($, dir, f.name, entry, new Set(next.values())))
    }
    if (id) next.set(f.name, id)
  }
  const present = new Set(files.map(f => f.name))
  const closed: string[] = []
  for (const [name, id] of opens) {
    if (present.has(name)) continue
    closed.push(id)
    lastWhy.delete(name)
    nextTry.delete(name)
    await $.store.delete(STORE_OPEN + name).catch(() => undefined)
  }
  opens.clear()
  for (const [name, id] of next) opens.set(name, id)
  openIds = new Set(next.values())
  for (const id of closed) {
    if (openIds.has(id) || (await seenAt($, id)) >= t - POLL_MS) continue
    await $.store.set(STORE_SEEN + id, t).catch(() => undefined)
  }
}

// 你在这个会话里打了字。这时只开着一个会话（只有一条打开记录），开着的就是这个：
// - 那条记录被认成了别的会话，就是认错了：把那个会话的“看过”改回去（之后没人再记过的话），改认成这个；
// - 还没认出来，就认成这个
async function confirmOpen($: $) {
  try {
    if (!selfId) await refresh($)
    const dir = await configDir($)
    if (!selfId || !dir) return
    const files = await journals($, dir)
    if (files.length !== 1) return
    const name = files[0]!.name
    const rec = await loadRecord($, name)
    if (rec?.id === selfId) return
    if (rec && (await seenAt($, rec.id)) <= rec.at) await $.store.set(STORE_SEEN + rec.id, rec.prev)
    const t = await $.clock.now()
    const opened = rec?.opened || openingOf(await peek($, `${dir}/daemon/attach-journal/${name}`))?.at || t
    await $.store.set(STORE_OPEN + name, { id: selfId, at: t, prev: await seenAt($, selfId), opened })
    $.ui.log(`fleet: 打开记录 ${name.slice(0, 8)} → ${selfId}（在这里打了字${rec ? `，原来认成 ${rec.id}，改回来` : ''}）`, { to: 'debug' })
  } catch {
    // 改不了只是那个会话在未读消息里少一条或多一条
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
  // 未读消息：上次打开之后又回复了、现在没打开着的会话，按回复的时间新的在前（再回复就挪到最上面），
  // 显示 NEWS_MAX 条。所有会话算出来的是同一份，只是不列自己
  const fresh: string[] = []
  for (const j of next) {
    if (fresh.length >= NEWS_MAX) break
    if (j.isSelf || openIds.has(j.id) || j.doneAt === null || j.doneAt <= newsSince) continue
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

// 每 2 秒：认一遍打开着哪些会话；看面板还开着、显示着没有，显示着就重读一遍会话
async function poll($: $) {
  if (isPolling) return
  isPolling = true
  try {
    await watchOpen($).catch(() => undefined)
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

// 未读消息从什么时候算起：第一次用的时候记下，以后一直用它
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
    if (all.includes(STORE_OLD_CURRENT)) await $.store.delete(STORE_OLD_CURRENT)
    // 认出来的打开记录，关掉时没删掉的
    const t = await $.clock.now()
    for (const k of all.filter(k => k.startsWith(STORE_OPEN))) {
      const at = Number(((await $.store.get(k)) as { opened?: unknown } | undefined)?.opened) || 0
      if (t - at > OPEN_KEEP_MS) await $.store.delete(k)
    }
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
  '列表下面是未读消息：上次打开之后又回复了的会话，最近 6 条，所有会话里是同一份；打开那个会话，它就移出去',
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
  openIds = new Set()
  opens.clear()
  lastWhy.clear()
  nextTry.clear()
  roster = undefined
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
    // 未读消息从什么时候算起，要在第一次读会话之前定下来，不然以前的回复会闪一下
    await loadNewsSince($)
    poller?.cancel()
    poller = $.clock.every(POLL_MS, () => void poll($))
    void poll($)
    // 会话进程起来不算打开：不一定是你打开了它（比如 Claude Code 升级后重启后台会话）。真打开了有打开记录（watchOpen）
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

  // 远程的界面（手机、桌面端）连上来：你在看这个会话。claude attach、从 claude agents 打开不发这个事件
  on('session.attach', async ($, e, next) => {
    const attached = await next(e)
    void markSeen($)
    void poll($)
    return attached
  })

  // 你在这个会话里打了字（提问、斜杠命令）：你在看它
  on('prompt.submit', async ($, e, next) => {
    if (e.origin?.kind === 'composer') void confirmOpen($).then(() => markSeen($))
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

  // 列表由插件自己翻（未读消息区不能被滚走）：滚轮、翻页键只改列表从第几个画起，引擎的窗口不动
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
    // 未读消息（refresh 里挑好的），照会话现在的样子画
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
    // 停靠在右边时，未读消息区贴着面板底边，空着的地方留在列表下面；在输入框上方时面板按内容的高度来，不用补
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
        <Text weight="bold">未读消息</Text>
        {fresh.length ? fresh.map(j => row(j, `news-${j.id}`)) : dim('别的会话有新回复时会列在这里')}
        {/* 区域固定 NEWS_MAX 行高：不满时补空行，来了新消息列表也不跳 */}
        {Array.from({ length: NEWS_MAX - Math.max(1, fresh.length) }, () => dim(' '))}
      </Box>
    )
  })
}
