import { expect, test } from 'claude-code/testing'

import { layout, scrolled } from '../hooks/layout'
import { ago, evidenceOf, fit, judgeOpening, lastReplyAt, markOf, nameOf, openingOf, replyFallback, replyOf, sortJobs, statusOf, widthOf, workersOf } from '../hooks/jobs'
import type { Clue } from '../hooks/jobs'
import type { FlJob } from '../types'

const row = (at: string, state: string, detail = '', text = '') => JSON.stringify({ at, state, detail, text })

test('the status follows claude agents: the live process first, then the state file', async () => {
  const done = { state: 'done', tempo: 'idle' }
  expect(statusOf(done)).toBe('done')
  expect(statusOf(done, 'idle')).toBe('done')
  // 刚发出提问、状态文件还没改过来时，进程已经在忙了
  expect(statusOf(done, 'busy')).toBe('running')
  expect(statusOf({ state: 'failed', tempo: 'idle' })).toBe('failed')
  expect(statusOf({ state: 'stopped', tempo: 'idle' })).toBe('stopped')
  expect(statusOf({ state: 'working', tempo: 'active' }, 'busy')).toBe('running')
  // 主循环停着、后台任务还在跑
  expect(statusOf({ state: 'working', tempo: 'active' }, 'idle')).toBe('running')
  // 问了你一个问题（AskUserQuestion）、等你批准工具
  expect(statusOf({ state: 'working', tempo: 'blocked', needs: 'answer: 选哪个？' }, 'waiting')).toBe('needs')
  expect(statusOf({ state: 'working', tempo: 'active' }, 'waiting')).toBe('needs')
  // 一轮做完、最后问了你一句
  expect(statusOf({ state: 'blocked', tempo: 'blocked' }, 'idle')).toBe('needs')
  // 新开的、还没提问过的
  expect(statusOf({ state: 'blocked', tempo: 'blocked', needs: 'send a prompt to start' }, 'idle')).toBe('idle')
  // 定时醒来的会话做完一轮也还开着
  expect(statusOf({ state: 'done', tempo: 'idle', selfWake: true }, 'idle')).toBe('idle')
  expect(statusOf({ state: 'done', tempo: 'idle', inFlight: { kinds: ['session_cron'] } })).toBe('idle')
})

test('the last reply in a timeline: rows with the reply text, not the prompts you sent; repeats count once', async () => {
  const lines = [
    row('2026-10-23T08:00:00.000Z', 'working', '读代码'),
    row('2026-10-23T08:05:00.000Z', 'done', '改好了', '改好了，测试都通过。'),
    row('2026-10-23T08:07:00.000Z', 'done', '改好了', '改好了，测试都通过。'),
    // 你发出的下一次提问：state 还是 done，没有回复文字
    row('2026-10-23T09:00:00.000Z', 'done', '再看看 Windows'),
    row('2026-10-23T09:00:20.000Z', 'working', '查路径'),
    '{"at":"2026-10-23T09:01:00.000Z","state":"wor',
  ]
  expect(lastReplyAt(lines.join('\n'))).toBe(Date.parse('2026-10-23T08:05:00.000Z'))
  // 做完一轮、问了你一句：blocked 也是回复
  const asked = [...lines.slice(0, 5), row('2026-10-23T09:10:00.000Z', 'blocked', '要提交吗？', '改好了。要我提交吗？')]
  expect(lastReplyAt(asked.join('\n'))).toBe(Date.parse('2026-10-23T09:10:00.000Z'))
  // 两次不一样的回复挨着（后台任务的通知引起的那一轮），取后一次
  const twice = [...lines.slice(0, 2), row('2026-10-23T08:30:00.000Z', 'done', '子任务也回来了', '子任务的结果也回来了。')]
  expect(lastReplyAt(twice.join('\n'))).toBe(Date.parse('2026-10-23T08:30:00.000Z'))
  expect(lastReplyAt(row('2026-10-23T08:00:00.000Z', 'working'))).toBe(undefined)
  expect(lastReplyAt('')).toBe(undefined)
})

test('when the last reply came: ended, waiting on you, running, or from the timeline', async () => {
  const at = (s: string) => Date.parse(s)
  // 结束了：状态文件里的 lastTerminalAt
  expect(replyOf({ state: 'done', tempo: 'idle', lastTerminalAt: '2026-10-23T09:51:08.780Z', updatedAt: '2026-10-23T15:27:40.837Z' }, undefined, undefined)).toEqual({
    at: at('2026-10-23T09:51:08.780Z'),
  })
  expect(replyOf({ state: 'done', tempo: 'idle', firstTerminalAt: '2026-10-22T00:00:00.000Z' }, undefined, undefined)).toEqual({ at: at('2026-10-22T00:00:00.000Z') })
  // 在等你回答问题：从开始等的那一刻
  const asking = { state: 'working', tempo: 'blocked', needs: 'answer: 选哪个？', updatedAt: '2026-10-23T15:44:22.432Z' }
  expect(replyOf(asking, { status: 'waiting', since: 1792770262446 }, 5)).toEqual({ at: 1792770262446 })
  expect(replyOf(asking, undefined, 5)).toEqual({ at: at('2026-10-23T15:44:22.432Z') })
  // 在跑：用记下的上一次回复
  const working = { state: 'working', tempo: 'active', updatedAt: '2026-10-23T15:50:00.000Z' }
  expect(replyOf(working, { status: 'busy' }, 1234)).toEqual({ at: 1234 })
  // 没记下过（刚重新加载插件）、做完一轮在等你回复：去 timeline.jsonl 里找
  expect(replyOf(working, { status: 'busy' }, undefined)).toEqual({ timeline: 'working' })
  const blocked = { state: 'blocked', tempo: 'blocked', updatedAt: '2026-10-23T09:10:00.000Z' }
  expect(replyOf(blocked, { status: 'idle' }, 1234)).toEqual({ timeline: 'blocked|blocked|2026-10-23T09:10:00.000Z' })
  // timeline.jsonl 读不了时
  expect(replyFallback(blocked, 1234)).toBe(at('2026-10-23T09:10:00.000Z'))
  expect(replyFallback(working, 1234)).toBe(1234)
  expect(replyFallback(working, undefined)).toBe(undefined)
})

test('how long ago: 3s under a minute, no seconds from a minute on (2m, 10h 2m), 24h+ from a day', async () => {
  expect(ago(0)).toBe('0s')
  expect(ago(-5000)).toBe('0s')
  expect(ago(3999)).toBe('3s')
  expect(ago(59_999)).toBe('59s')
  expect(ago(63_000)).toBe('1m')
  expect(ago((10 * 3600 + 2 * 60 + 3) * 1000)).toBe('10h 2m')
  expect(ago(3599_000)).toBe('59m')
  expect(ago(3600_000)).toBe('1h 0m')
  expect(ago(86_399_000)).toBe('23h 59m')
  expect(ago(86_400_000)).toBe('24h+')
  expect(ago(30 * 86_400_000)).toBe('24h+')
})

test('newest reply first; the name falls back to the first prompt', async () => {
  const job = (id: string, sortAt: number): FlJob => ({ id, name: id, status: 'done', doneAt: sortAt, sortAt, isSelf: false })
  expect(sortJobs([job('a', 1), job('b', 3), job('c', 2)]).map(j => j.id)).toEqual(['b', 'c', 'a'])
  expect(nameOf({ name: '🟢 发版' }, '')).toBe('🟢 发版')
  expect(nameOf({ name: '旧名字' }, '新名字')).toBe('新名字')
  expect(nameOf({ intent: '查看一下：\n线上接口报错\t怎么回事' })).toBe('查看一下： 线上接口报错 怎么回事')
  expect(nameOf({})).toBe('')
})

test('widths: Chinese and emoji take two cells, the variation selector none', async () => {
  expect(widthOf('🟢 发版')).toBe(7)
  expect(widthOf('⚪️ Ab1')).toBe(6)
  expect(widthOf('📦 我的插件')).toBe(11)
  expect(fit('产品需求文档整理', 9)).toBe('产品需求…')
  expect(fit('abc', 3)).toBe('abc')
})

test('the news area is six lines under the list; a list that does not fit is cut and scrolls', async () => {
  // 40 行：说明 1 行，未读消息区 分隔线、标题、6 行，列表 31 行放得下
  expect(layout(40, 24, 5)).toEqual({ top: 0, count: 24, isCut: false })
  // 20 行：放不下，上下各一行“还有几个”，列表画 20 - 1 - 8 - 2 = 9 个
  expect(layout(20, 24, 0)).toEqual({ top: 0, count: 9, isCut: true })
  expect(layout(20, 24, 99)).toEqual({ top: 15, count: 9, isCut: true })
  expect(scrolled(24, 9, 0, -1)).toBe(0)
  expect(scrolled(24, 9, 0, 3)).toBe(3)
  expect(scrolled(24, 9, 8, 20)).toBe(15)
})

test('roster.json: message counts of the first paint, whether opening gives them, when the process started', async () => {
  const paint = (n: number) => ({ kind: 'content_paint', msgsLoaded: n, msgsInJsonl: n, msgsRenderedAtFirstPaint: n })
  const resumed = { launch: { mode: 'resume', restoresTranscript: true } }
  const roster = {
    proto: 1,
    workers: {
      aaaa1111: { cliVersion: '2.1.319', rvAuth: 'secret', startedAt: 5, dispatch: resumed, firedInteractiveMarks: [paint(350), { kind: 'prompt_idle' }] },
      // 新建的会话：不是恢复出来的，没有消息数
      dddd4444: { cliVersion: '2.1.319', dispatch: { launch: { mode: 'prompt', restoresTranscript: false } }, firedInteractiveMarks: [] },
      // 恢复出来、还没画完：会给消息数
      eeee5555: { cliVersion: '2.1.319', dispatch: resumed },
      // 跑的是旧版本：不给消息数
      ffff6666: { cliVersion: '2.1.318', dispatch: resumed, firedInteractiveMarks: [paint(9)] },
    },
  }
  expect(workersOf(roster, '2.1.319')).toEqual([
    { id: 'aaaa1111', mark: '350|350|350', gives: true, startedAt: 5 },
    { id: 'dddd4444', mark: undefined, gives: false, startedAt: undefined },
    { id: 'eeee5555', mark: undefined, gives: true, startedAt: undefined },
    { id: 'ffff6666', mark: '9|9|9', gives: false, startedAt: undefined },
  ])
  // 不知道守护进程的版本：版本不比
  expect(workersOf(roster).find(w => w.id === 'ffff6666')?.gives).toBe(true)
  expect(workersOf(null)).toEqual([])
  // 只有一部分数的也能对
  expect(markOf({ msgsRenderedAtFirstPaint: 0 })).toBe('||0')
  expect(markOf({ msgsLoaded: 'x' })).toBe(undefined)
  expect(openingOf({ startedAtEpochMs: 7, surface: 'fleet', marksExpected: true, msgsLoaded: 3, msgsInJsonl: 3, msgsRenderedAtFirstPaint: 3 })).toEqual({
    at: 7,
    mark: '3|3|3',
    marksExpected: true,
    surface: 'fleet',
  })
  expect(openingOf({ surface: 'fleet' })).toBe(undefined)
})

// 一个会话的线索：mark 是消息数（undefined 是不给），touch 是被碰过的痕迹
const T = 1_000_000
function clue(id: string, o: { mark?: string; gives?: boolean; isJob?: boolean; running?: boolean; startedAt?: number; trigger?: number; dir?: number; state?: number } = {}): Clue {
  const worker = o.running === false ? undefined : { id, mark: o.mark, gives: o.gives ?? o.mark !== undefined, startedAt: o.startedAt ?? T - 3600_000 }
  return { id, isJob: o.isJob ?? true, worker, trigger: o.trigger, dir: o.dir ?? T - 3600_000, state: o.state ?? T - 3600_000 }
}
const opening = (o: { mark?: string; marksExpected?: boolean } = {}) => ({ at: T, surface: 'fleet', marksExpected: o.mark ? true : o.marksExpected, mark: o.mark })

test('evidence: touched at the moment of opening, the process started just after, or touched a little later', async () => {
  const o = opening({ mark: '3|3|3' })
  expect(evidenceOf(o, clue('a', { trigger: T + 20 }))).toBe(2)
  // recap.trigger 删掉了：目录比 state.json 新出一截才算；只晚一点点是 state.json 改名换上的
  expect(evidenceOf(o, clue('a', { dir: T + 400, state: T - 9000 }))).toBe(2)
  expect(evidenceOf(o, clue('a', { dir: T + 100.5, state: T + 100 }))).toBe(0)
  // 打开一个歇下来的会话：进程几秒后起来，recap.trigger 也晚几秒写
  expect(evidenceOf(o, clue('a', { startedAt: T + 3000, trigger: T + 6000 }))).toBe(3)
  // 太早、太晚
  expect(evidenceOf(o, clue('a', { trigger: T - 2000 }))).toBe(0)
  expect(evidenceOf(o, clue('a', { trigger: T + 61_000 }))).toBe(0)
})

test('judging an opening: rule out by counts, then believe only a single fit or a single one with evidence', async () => {
  // 还没连上、还没画出来：先不认
  expect(judgeOpening({ at: T, surface: 'fleet' }, [clue('a', { mark: '3|3|3' })])).toEqual({ why: '还没连上' })
  expect(judgeOpening({ at: T, surface: 'fleet', marksExpected: true }, [clue('a', { mark: '3|3|3' })])).toEqual({ why: '还没画出来' })
  // 消息数只对上一个
  expect(judgeOpening(opening({ mark: '3|3|3' }), [clue('a', { mark: '3|3|3' }), clue('b', { mark: '5|5|5' })])).toEqual({ id: 'a', why: '消息数' })
  // 对上了也要不是备用进程、在跑
  expect(judgeOpening(opening({ mark: '3|3|3' }), [clue('a', { mark: '3|3|3', isJob: false }), clue('b', { mark: '3|3|3', running: false })])).toEqual({
    why: '对不上',
  })
  // 只对上一个，可别的会话刚被打开过、它却没有：线索打架，不认
  expect(judgeOpening(opening({ mark: '3|3|3' }), [clue('a', { mark: '3|3|3' }), clue('b', { mark: '5|5|5', trigger: T + 20 })])).toEqual({
    why: '线索打架：别的会话刚被打开过',
  })
  // 别的会话是另一个终端开着的（另一条打开记录已经认走了）：不算打架
  expect(judgeOpening(opening({ mark: '3|3|3' }), [clue('a', { mark: '3|3|3' }), clue('b', { mark: '5|5|5', trigger: T + 20 })], new Set(['b']))).toEqual({
    id: 'a',
    why: '消息数',
  })
  // 它自己也被碰过：照认
  expect(judgeOpening(opening({ mark: '3|3|3' }), [clue('a', { mark: '3|3|3', trigger: T + 30 }), clue('b', { mark: '5|5|5', trigger: T + 20 })])).toEqual({
    id: 'a',
    why: '消息数',
  })
  // 消息数撞了：只有一个刚被打开过
  const twins = [clue('a', { mark: '326|326|326' }), clue('b', { mark: '326|326|326', dir: T + 300, state: T - 5000 })]
  expect(judgeOpening(opening({ mark: '326|326|326' }), twins)).toEqual({ id: 'b', why: '刚被打开过' })
  // 两个都刚被碰过，或者都没碰过：不认
  expect(judgeOpening(opening({ mark: '326|326|326' }), [twins[0]!, twins[1]!, clue('c', { mark: '326|326|326', trigger: T + 10 })])).toEqual({
    why: '线索打架：好几个都刚被打开过',
  })
  expect(judgeOpening(opening({ mark: '326|326|326' }), [clue('a', { mark: '326|326|326' }), clue('b', { mark: '326|326|326' })])).toEqual({
    why: '分不出：好几个都对得上',
  })
  // 不给消息数：只在不给的里面找
  const quiet = [clue('a', { mark: '3|3|3' }), clue('n1', { gives: false }), clue('n2', { gives: false, startedAt: T + 4000 })]
  expect(judgeOpening(opening({ marksExpected: false }), quiet)).toEqual({ id: 'n2', why: '刚被打开过' })
  expect(judgeOpening(opening({ marksExpected: false }), [clue('a', { mark: '3|3|3' }), clue('n1', { gives: false })])).toEqual({
    id: 'n1',
    why: '不给消息数的只有它',
  })
})
