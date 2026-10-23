import { expect, test } from 'claude-code/testing'

import { layout, scrolled } from '../hooks/layout'
import { ago, fit, lastReplyAt, nameOf, replyFallback, replyOf, sortJobs, statusOf, widthOf } from '../hooks/jobs'
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

test('the news area is three lines under the list; a list that does not fit is cut and scrolls', async () => {
  // 30 行：说明 1 行，最新消息区 分隔线、标题、3 行，列表 24 行正好放得下
  expect(layout(30, 24, 5)).toEqual({ top: 0, count: 24, isCut: false })
  // 20 行：放不下，上下各一行“还有几个”，列表画 20 - 1 - 5 - 2 = 12 个
  expect(layout(20, 24, 0)).toEqual({ top: 0, count: 12, isCut: true })
  expect(layout(20, 24, 99)).toEqual({ top: 12, count: 12, isCut: true })
  expect(scrolled(24, 12, 0, -1)).toBe(0)
  expect(scrolled(24, 12, 0, 3)).toBe(3)
  expect(scrolled(24, 12, 8, 20)).toBe(12)
})
