// 会话总览的纯逻辑：认状态、找上一次回复的时间、排序、显示用的时长和截断。不碰文件，不碰 $。
//
// 数据来自 Claude Code 未公开的内部文件（升级后可能变）：
// - <配置目录>/jobs/<id>/state.json：后台会话的状态，claude agents 列的就是这些；
// - <配置目录>/jobs/<id>/timeline.jsonl：状态的变化，一行一次 { at, state, detail, text }；
//   会话结束一轮（回复了）时记一行，带着回复的文字（text）；你发出提问时也记一行，text 是空的；
//   在跑的时候每隔一会儿记一行 working；
// - <配置目录>/sessions/<pid>.json：正在跑的会话进程，status 是 busy、idle、waiting（等你回答问题、批准工具），
//   statusUpdatedAt 是变成这个状态的时间。
// 状态文件里的 lastTerminalAt 是结束的时间，可一旦开始下一轮就删掉了；等你回答问题时状态文件里也没有时间，
// 所以“最近一次回复”要几处一起看（replyOf）。
// 认状态的规矩照着 claude agents 自己的写法（CC 2.1.309 读代码）。

import type { FlJob, FlStatus } from '../types'

export type JobState = Record<string, unknown>

// 会话结束后的 state：done 做完、failed 出错、stopped 被停掉
const ENDED: Record<string, FlStatus> = { done: 'done', failed: 'failed', stopped: 'stopped' }
// 新开、还没发过提问的会话，needs 是这句
const IDLE_NEEDS = 'send a prompt to start'
// 这几种 state 表示一轮做完了（blocked 是做完一轮、在等你回复）
const REPLIED = new Set(['done', 'blocked', 'failed', 'stopped'])

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

function timeOf(v: unknown): number | undefined {
  const t = typeof v === 'string' ? Date.parse(v) : NaN
  return Number.isFinite(t) ? t : undefined
}

// 定时自己醒来的会话（/loop、定时任务）：做完一轮也还算开着
function selfWakes(s: JobState): boolean {
  const kinds = (s.inFlight as { kinds?: unknown } | undefined)?.kinds
  return s.routine !== undefined || s.selfWake === true || (Array.isArray(kinds) && kinds.includes('session_cron'))
}

// 已经结束：state 是 done、failed、stopped，而且不在忙
export function hasEnded(s: JobState): boolean {
  return str(s.state) in ENDED && s.tempo !== 'active'
}

// 一个会话现在的状态。live 是会话进程的 status（进程不在就是 undefined）
export function statusOf(s: JobState, live?: string): FlStatus {
  if (live === 'busy' || live === 'shell') return 'running'
  if (hasEnded(s) && !(s.state === 'done' && selfWakes(s))) return ENDED[str(s.state)]!
  if (live === 'waiting') return 'needs'
  if (s.needs === IDLE_NEEDS) return 'idle'
  if (s.state === 'blocked' || (s.tempo === 'blocked' && str(s.needs))) return 'needs'
  // 主循环停着、后台任务还在跑的，也算运行中
  if (s.state === 'working' && s.tempo === 'active') return 'running'
  return 'idle'
}

// 已经结束的会话，最后一次做完的时间
export function endedAt(s: JobState): number | undefined {
  return timeOf(s.lastTerminalAt) ?? timeOf(s.firstTerminalAt) ?? timeOf(s.updatedAt)
}

type Row = { at: number; state: string; detail: string; text: string }

function rowOf(line: string): Row | undefined {
  if (!line.trim()) return undefined
  try {
    const d: unknown = JSON.parse(line)
    if (!d || typeof d !== 'object') return undefined
    const r = d as Record<string, unknown>
    const at = timeOf(r.at)
    return at === undefined || typeof r.state !== 'string' ? undefined : { at, state: r.state, detail: str(r.detail), text: str(r.text) }
  } catch {
    return undefined // 写到一半的行
  }
}

// 从 timeline.jsonl 找最近一次回复的时间：最后一行 done / blocked / failed / stopped、而且带着回复文字（text）的。
// - 不带文字的那种是你发出的提问（detail 是提问，state 还是上一轮的）；
// - 同一次回复有时会原样记好几行，取第一行的时间
export function lastReplyAt(timeline: string): number | undefined {
  const lines = timeline.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const row = rowOf(lines[i]!)
    if (!row || !REPLIED.has(row.state) || !row.text) continue
    let at = row.at
    for (let k = i - 1; k >= 0; k--) {
      const prev = rowOf(lines[k]!)
      if (!prev) continue
      if (prev.state !== row.state || prev.detail !== row.detail || prev.text !== row.text) break
      at = prev.at
    }
    return at
  }
  return undefined
}

// 会话进程报的状态：status 是 busy、idle、waiting，since 是变成这个状态的时间
export type Live = { status: string; since?: number }

// 最近一次回复的时间：at；要到 timeline.jsonl 里找的，给出 timeline（缓存用的 key：key 不变，找出来的时间也不变）。
// known 是之前记下的最近一次回复的时间
export type Reply = { at: number | undefined } | { timeline: string }

export function replyOf(s: JobState, live: Live | undefined, known: number | undefined): Reply {
  // 结束了：状态文件里记着结束的时间
  if (hasEnded(s)) return { at: endedAt(s) }
  // 在等你回答问题、批准工具：从开始等的那一刻算
  if (live?.status === 'waiting') return { at: live.since ?? timeOf(s.updatedAt) }
  if (s.state === 'working' && s.tempo === 'blocked' && str(s.needs) && s.needs !== IDLE_NEEDS) return { at: timeOf(s.updatedAt) }
  // 在跑：上一次回复的时间不会再变，记下过就用它
  if (s.state === 'working' && known !== undefined) return { at: known }
  // 其余的（做完一轮、在等你回复的 blocked；重新加载插件时正在跑的）：状态文件里没有这个时间
  return { timeline: s.state === 'working' ? 'working' : `${str(s.state)}|${str(s.tempo)}|${str(s.updatedAt)}` }
}

// timeline.jsonl 里没找到时（没有这个文件、超过 4 MiB 读不了）退而用的时间
export function replyFallback(s: JobState, known: number | undefined): number | undefined {
  return s.state === 'blocked' ? (timeOf(s.updatedAt) ?? known) : known
}

// ---------- 认出正打开着的会话 ----------
//
// claude agents、claude attach 每打开一个后台会话，就在 <配置目录>/daemon/attach-journal/ 下写一个打开记录，
// 关掉（回到列表、断开）时删掉（CC 2.1.318 读代码）。记录里不写是哪个会话，只能拿几条线索交叉核对（judgeOpening）：
// ① 消息数：记录里的 msgsLoaded、msgsInJsonl、msgsRenderedAtFirstPaint 是那个会话进程第一次画出来时的消息数（守护进程
//   重放给每个连上来的界面，界面写进记录），<配置目录>/daemon/roster.json 里每个会话进程的 firedInteractiveMarks
//   记着同样的数。会撞：两个会话正好一样多；
// ② 给不给消息数：记录里的 marksExpected。不给的是新建、还没重新打开过的会话（不是恢复出来的，也没画过），和跑着
//   跟守护进程（<配置目录>/daemon.lock 的 version）不一样版本的；
// ③④ 碰过的痕迹（CC 2.1.319 起，只有 claude agents 写）：打开时往 <配置目录>/jobs/<id>/recap.trigger 写一下（回来时
//   “离开期间的摘要”用），会话进程闲着时半秒内删掉。还在看它的修改时间；删掉了看 job 目录比 state.json 新出来的那一下；
// ⑤ 冷启动：打开一个歇下来的会话，会话进程（roster.json 的 startedAt）在打开之后几秒才起来；
// ⑦ 真会话：有 state.json、在 roster.json 里。预先起好、还没用上的 spare 没有 state.json。
// ①② 用来排除，③④⑤ 是正证据。只剩一个、或者只有一个有正证据才认；线索打架（别的会话刚被碰过、它却没有，
// 或者好几个都有正证据）就不认，宁可在未读消息里多留一会儿。

const MARK_KEYS = ['msgsLoaded', 'msgsInJsonl', 'msgsRenderedAtFirstPaint'] as const

// 三个消息数连成指纹；一个都没有（还没画出来）就是 undefined
export function markOf(v: unknown): string | undefined {
  if (!v || typeof v !== 'object') return undefined
  const r = v as Record<string, unknown>
  const nums = MARK_KEYS.map(k => {
    const n = r[k]
    return typeof n === 'number' && Number.isInteger(n) && n >= 0 ? String(n) : ''
  })
  return nums.some(Boolean) ? nums.join('|') : undefined
}

// roster.json 里的一个会话进程：mark 是第一次画出来时的消息数，gives 是打开它时 Claude Code 会不会给消息数，
// startedAt 是进程起来的时间
export type Worker = { id: string; mark?: string; gives: boolean; startedAt?: number }

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})

// roster.json 里的会话进程，只取认打开记录要用的（roster.json 里还有密钥，别的都不取）。version 是守护进程的版本
export function workersOf(roster: unknown, version = ''): Worker[] {
  return Object.entries(obj(obj(roster).workers)).map(([id, v]) => {
    const w = obj(v)
    const marks = Array.isArray(w.firedInteractiveMarks) ? w.firedInteractiveMarks : []
    const launch = obj(obj(w.dispatch).launch)
    const resumed = launch.mode !== 'exec' && (typeof launch.restoresTranscript === 'boolean' ? launch.restoresTranscript : launch.mode === 'resume')
    const stale = typeof w.cliVersion === 'string' && !!w.cliVersion && !!version && w.cliVersion !== version
    const startedAt = typeof w.startedAt === 'number' && Number.isFinite(w.startedAt) ? w.startedAt : undefined
    return { id, mark: markOf(marks.find(m => obj(m).kind === 'content_paint')), gives: !stale && (resumed || marks.length > 0), startedAt }
  })
}

// 一次打开：打开的时刻、消息数、给不给消息数、从哪儿打开的（fleet 是 claude agents，bg_cli 是 claude attach）
export type Opening = { at: number; mark?: string; marksExpected?: boolean; surface: string }

export function openingOf(entry: unknown): Opening | undefined {
  const r = obj(entry)
  const at = Number(r.startedAtEpochMs)
  if (!Number.isFinite(at) || at <= 0) return undefined
  const marksExpected = typeof r.marksExpected === 'boolean' ? r.marksExpected : undefined
  return { at, mark: markOf(r), marksExpected, surface: str(r.surface) }
}

// 一个会话被碰过的痕迹：recap.trigger 的修改时间；job 目录、state.json 的修改时间。
// state.json 是写好再改名换上的，目录只比它晚一点点（不到 1 毫秒），所以目录要新出 TOUCH_GAP 才算有文件增删
export type Touch = { trigger?: number; dir?: number; state?: number }
const TOUCH_GAP = 200

export function touchedAt(t: Touch): number[] {
  const out: number[] = []
  if (t.trigger !== undefined) out.push(t.trigger)
  if (t.dir !== undefined && t.state !== undefined && t.dir > t.state + TOUCH_GAP) out.push(t.dir)
  return out
}

// 一个会话的全部线索：isJob 是有 state.json，worker 是 roster.json 里它的进程（没在跑就没有）
export type Clue = Touch & { id: string; isJob: boolean; worker?: Worker }

// 打开后多久之内的痕迹算数：直接打开时几十毫秒内写、半秒内删；打开歇下来的会话要先把进程起起来，晚好几秒
const NEAR_BEFORE = 500
const NEAR_AFTER = 1500
const LATE_AFTER = 60000

// 正证据有多强：打开那一刻被碰过（2）、进程刚好在打开之后起来（2）、晚一些被碰过（1）
export function evidenceOf(o: Opening, c: Clue): number {
  let score = 0
  const touches = touchedAt(c)
  if (touches.some(t => t >= o.at - NEAR_BEFORE && t <= o.at + NEAR_AFTER)) score += 2
  else if (touches.some(t => t > o.at + NEAR_AFTER && t <= o.at + LATE_AFTER)) score += 1
  const started = c.worker?.startedAt
  if (started !== undefined && started >= o.at - NEAR_BEFORE && started <= o.at + LATE_AFTER) score += 2
  return score
}

// 认的结果：认出来了有 id；没有 id 就是先不认，why 说为什么
export type Verdict = { id?: string; why: string }

// 这次打开的是哪个会话。taken 是别的打开记录已经认走的会话（同时开着好几个终端时），它们刚被碰过不算打架
export function judgeOpening(o: Opening, clues: readonly Clue[], taken: ReadonlySet<string> = new Set()): Verdict {
  if (o.mark === undefined && o.marksExpected !== false) return { why: o.marksExpected === undefined ? '还没连上' : '还没画出来' }
  // ①②⑦ 排除
  const fits = (c: Clue) => {
    const w = c.worker
    if (!c.isJob || !w) return false
    return o.mark !== undefined ? w.gives && w.mark === o.mark : !w.gives
  }
  const all = clues.map(c => ({ c, fit: fits(c), score: evidenceOf(o, c) }))
  const fit = all.filter(x => x.fit)
  if (!fit.length) return { why: '对不上' }
  const elsewhere = all.some(x => !x.fit && x.c.isJob && !taken.has(x.c.id) && x.score >= 2)
  if (fit.length === 1) {
    const only = fit[0]!
    if (only.score === 0 && elsewhere) return { why: '线索打架：别的会话刚被打开过' }
    return { id: only.c.id, why: o.mark !== undefined ? '消息数' : '不给消息数的只有它' }
  }
  // 好几个都对得上：只有一个有正证据才认
  const positive = fit.filter(x => x.score > 0)
  if (positive.length === 1) return { id: positive[0]!.c.id, why: '刚被打开过' }
  return { why: positive.length ? '线索打架：好几个都刚被打开过' : '分不出：好几个都对得上' }
}

export function oneLine(s: string): string {
  return s.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()
}

// 显示的名字：会话进程里的名字、状态文件里的名字，都没有就用第一次提问
export function nameOf(s: JobState, liveName?: string): string {
  for (const v of [liveName, s.name, s.displayIntent, s.intent]) {
    const name = oneLine(str(v))
    if (name) return name.slice(0, 200)
  }
  return ''
}

// 最新回复的排最上面；还没回复过的按开始的时间
export function sortJobs(list: FlJob[]): FlJob[] {
  return [...list].sort((a, b) => b.sortAt - a.sortAt || a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
}

export function createdAt(s: JobState): number {
  return timeOf(s.createdAt) ?? timeOf(s.updatedAt) ?? 0
}

// 过了多久：不到一分钟 3s；满一分钟不显示秒，2m、10h 2m；满 24 小时是 24h+
export function ago(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s >= 86400) return '24h+'
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (h) return `${h}h ${m}m`
  if (m) return `${m}m`
  return `${s}s`
}

// 一个字在终端里占几格：汉字、全角符号、大部分 emoji 占两格；变体选择符、零宽连接符不占格
const WIDE: [number, number][] = [
  [0x1100, 0x115f], [0x231a, 0x231b], [0x23e9, 0x23ec], [0x23f0, 0x23f0], [0x23f3, 0x23f3],
  [0x25fd, 0x25fe], [0x2614, 0x2615], [0x2648, 0x2653], [0x267f, 0x267f], [0x2693, 0x2693],
  [0x26a1, 0x26a1], [0x26aa, 0x26ab], [0x26bd, 0x26be], [0x26c4, 0x26c5], [0x26ce, 0x26ce],
  [0x26d4, 0x26d4], [0x26ea, 0x26ea], [0x26f2, 0x26f3], [0x26f5, 0x26f5], [0x26fa, 0x26fa],
  [0x26fd, 0x26fd], [0x2705, 0x2705], [0x270a, 0x270b], [0x2728, 0x2728], [0x274c, 0x274c],
  [0x274e, 0x274e], [0x2753, 0x2755], [0x2757, 0x2757], [0x2795, 0x2797], [0x27b0, 0x27b0],
  [0x27bf, 0x27bf], [0x2b1b, 0x2b1c], [0x2b50, 0x2b50], [0x2b55, 0x2b55], [0x2e80, 0x303e],
  [0x3041, 0x33ff], [0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xa000, 0xa4cf], [0xac00, 0xd7a3],
  [0xf900, 0xfaff], [0xfe30, 0xfe4f], [0xff00, 0xff60], [0xffe0, 0xffe6], [0x1f004, 0x1f004],
  [0x1f0cf, 0x1f0cf], [0x1f18e, 0x1f18e], [0x1f191, 0x1f19a], [0x1f200, 0x1f2ff], [0x1f300, 0x1f64f],
  [0x1f680, 0x1f6ff], [0x1f7e0, 0x1f7eb], [0x1f900, 0x1f9ff], [0x1fa70, 0x1faff], [0x20000, 0x3fffd],
]

export function cellWidth(ch: string): number {
  const c = ch.codePointAt(0) ?? 0
  if (c === 0x200d || (c >= 0xfe00 && c <= 0xfe0f)) return 0
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
