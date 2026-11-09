import { expect, test } from 'claude-code/testing'

import { layout, scrolled } from '../hooks/layout'
import { ago, fit, lastReplyAt, markOf, nameOf, openCandidates, replyFallback, replyOf, sortJobs, statusOf, touchedJob, widthOf, workersOf } from '../hooks/jobs'
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

test('an opening record points at its session by the message counts of its first paint, or by being the one that gives none', async () => {
  const paint = (n: number) => ({ kind: 'content_paint', msgsLoaded: n, msgsInJsonl: n, msgsRenderedAtFirstPaint: n })
  const resumed = { launch: { mode: 'resume', restoresTranscript: true } }
  const roster = {
    proto: 1,
    workers: {
      aaaa1111: { cliVersion: '2.1.318', rvAuth: 'secret', dispatch: resumed, firedInteractiveMarks: [paint(350), { kind: 'prompt_idle' }] },
      bbbb2222: { cliVersion: '2.1.318', dispatch: resumed, firedInteractiveMarks: [paint(3)] },
      cccc3333: { cliVersion: '2.1.318', dispatch: resumed, firedInteractiveMarks: [paint(3)] },
      // 新建的会话：不是恢复出来的，没有消息数
      dddd4444: { cliVersion: '2.1.318', dispatch: { launch: { mode: 'prompt', restoresTranscript: false } }, firedInteractiveMarks: [] },
      // 恢复出来、还没画完：会给消息数
      eeee5555: { cliVersion: '2.1.318', dispatch: resumed },
      // 跑的是旧版本：不给消息数
      ffff6666: { cliVersion: '2.1.300', dispatch: resumed, firedInteractiveMarks: [paint(9)] },
    },
  }
  const workers = workersOf(roster, '2.1.318')
  expect(workers).toEqual([
    { id: 'aaaa1111', mark: '350|350|350', gives: true },
    { id: 'bbbb2222', mark: '3|3|3', gives: true },
    { id: 'cccc3333', mark: '3|3|3', gives: true },
    { id: 'dddd4444', mark: undefined, gives: false },
    { id: 'eeee5555', mark: undefined, gives: true },
    { id: 'ffff6666', mark: '9|9|9', gives: false },
  ])
  const entry = (o: object = {}) => ({ gestureId: 'g', surface: 'fleet', ...o })
  expect(openCandidates(entry(paint(350)), workers)).toEqual(['aaaa1111'])
  // 两个会话的数一样：两个都可能
  expect(openCandidates(entry(paint(3)), workers)).toEqual(['bbbb2222', 'cccc3333'])
  expect(openCandidates(entry(paint(7)), workers)).toEqual([])
  // 还没连上、还没画出来：先不认
  expect(openCandidates(entry(), workers)).toEqual([])
  expect(openCandidates(entry({ marksExpected: true }), workers)).toEqual([])
  // 这个会话进程不给消息数：不给的那几个
  expect(openCandidates(entry({ marksExpected: false }), workers)).toEqual(['dddd4444', 'ffff6666'])
  // 不知道守护进程的版本：版本不比
  expect(workersOf(roster).find(w => w.id === 'ffff6666')?.gives).toBe(true)
  // 只有一部分数的也能对
  expect(markOf({ msgsRenderedAtFirstPaint: 0 })).toBe('||0')
  expect(markOf({ msgsLoaded: 'x' })).toBe(undefined)
  expect(workersOf(null)).toEqual([])
})

test('the session touched just after an opening record was written is the one opened; plain state updates do not count', async () => {
  const T = 1_000_000
  // recap.trigger 还在：看它的时间
  expect(touchedJob([{ id: 'a', trigger: T + 20 }, { id: 'b', trigger: T - 5000 }], T)).toBe('a')
  // 删掉了：目录比 state.json 新出一截才算；只晚一点点是 state.json 改名换上的
  expect(touchedJob([{ id: 'a', dir: T + 400, state: T - 9000 }, { id: 'b', dir: T + 100.5, state: T + 100 }], T)).toBe('a')
  // 都碰过：取最早的（打开一个歇下来的会话要先起起来，晚几秒）
  expect(touchedJob([{ id: 'a', trigger: T + 8000 }, { id: 'b', dir: T + 300, state: T - 1 }], T)).toBe('b')
  // 太早、太晚、没碰过、没有开始时间：认不出
  expect(touchedJob([{ id: 'a', trigger: T - 2000 }, { id: 'b', trigger: T + 61_000 }, { id: 'c' }], T)).toBe(undefined)
  expect(touchedJob([{ id: 'a', trigger: T }], NaN)).toBe(undefined)
})
