import { expect, test } from 'claude-code/testing'

import { Rows } from '../hooks/rows'
import { assignIds, cleanSummary, commandLine, endsWithTurn, fit, headOf, keyOf, placesOf, splitTurns, summaryPrompt, widthOf, wrapLines } from '../hooks/turns'
import type { Msg } from '../hooks/turns'

const user = (text: string, toolResults?: unknown[]): Msg => ({ role: 'user', text, toolResults })
const bot = (text: string): Msg => ({ role: 'assistant', text })

test('each prompt starts a turn whose answer is the last text before the next prompt', async () => {
  const turns = splitTurns([
    user('第一个问题'),
    bot('我先看看。'),
    bot(''), // 只有工具调用的回复
    user('', [{ tool_use_id: 't1' }]),
    user('tool output', [{ tool_use_id: 't2' }]),
    bot('结论：可以。'),
    user('[Request interrupted by user]'),
    user('第二个问题'),
    bot('好的'),
  ])
  expect(turns).toEqual([
    { key: '第一个问题', prompt: '第一个问题', answer: '结论：可以。', at: 0 },
    { key: '第二个问题', prompt: '第二个问题', answer: '好的', at: 7 },
  ])
})

test('notifications and other senders end a turn without opening one', async () => {
  const turns = splitTurns([
    user('跑一下测试'),
    bot('在后台跑了。'),
    user('<task-notification>\n<task-id>b1</task-id>\n</task-notification>'),
    bot('测试通过了。'), // 回应任务通知，不算上一轮的回复
    user('Another Claude session sent a message: hi'),
    bot('收到。'),
    user('<div>一段 HTML</div> 帮我看看'), // 自己贴的 HTML 不是引擎插的消息
    bot('看过了。'),
  ])
  expect(turns.map(t => [t.prompt, t.answer])).toEqual([
    ['跑一下测试', '在后台跑了。'],
    ['<div>一段 HTML</div> 帮我看看', '看过了。'],
  ])
})

test('a slash command is a turn only when Claude answered it', async () => {
  const skill = '<command-message>review</command-message>\n<command-name>/review</command-name>\n<command-args>PR 12</command-args>'
  const local = '<command-name>/reload-plugins</command-name>\n<command-message>reload-plugins</command-message>\n<command-args></command-args>'
  expect(commandLine(skill)).toBe('/review PR 12')
  expect(commandLine(local)).toBe('/reload-plugins')
  expect(commandLine('普通的话')).toBeUndefined()
  const rows = [user(local), user(skill), bot('看完了，没问题。'), user(local)]
  expect(splitTurns(rows).map(t => t.prompt)).toEqual(['/review PR 12'])
  // 还在回答的最后一条命令先留着
  expect(splitTurns([user(skill)], true).map(t => t.prompt)).toEqual(['/review PR 12'])
  expect(splitTurns([user(skill)], false)).toEqual([])
})

test('headOf takes the first real sentence without markdown or code', async () => {
  expect(headOf('## 结论\n\n**可以做**，见 [文档](https://x.y)。')).toBe('结论')
  expect(headOf('```\nnpm test\n```\n\n- 测试 `全部` 通过')).toBe('测试 全部 通过')
  expect(headOf('| a | b |\n|---|---|\n第二行')).toBe('第二行')
  expect(headOf('')).toBe('')
})

test('widths count Chinese as two cells; fit and wrap keep within the width', async () => {
  expect(widthOf('ab中文')).toBe(6)
  expect(fit('中文中文中文', 7)).toBe('中文中…')
  expect(widthOf(fit('中文中文中文', 7))).toBeLessThanOrEqual(7)
  expect(fit('short', 10)).toBe('short')
  expect(wrapLines('一二三四五六七八九十', 8, 2)).toEqual(['一二三四', '五六七…'])
  // 英文单词和版本号不从中间拆开
  expect(wrapLines('aload 升到 v0.6.1 了', 13, 3)).toEqual(['aload 升到', 'v0.6.1 了'])
  expect(wrapLines('已推送；aload 升级', 12, 2)).toEqual(['已推送；', 'aload 升级'])
  expect(wrapLines('', 10, 2)).toEqual([])
})

test('the summary prompt carries the question and reply; long replies are cut in the middle', async () => {
  const prompt = summaryPrompt('问什么', `开头${'字'.repeat(9000)}结尾`)
  expect(prompt).toContain('<question>\n问什么\n</question>')
  expect(prompt).toContain('开头')
  expect(prompt).toContain('结尾')
  expect(prompt).toContain('……')
  expect(prompt.length).toBeLessThan(9000)
})

test('cleanSummary drops prefaces, quotes and the final full stop', async () => {
  expect(cleanSummary('摘要：改用 haiku 写摘要。')).toBe('改用 haiku 写摘要')
  expect(cleanSummary('需要概括这一轮的结果：aload 只能在 Mac 上用')).toBe('aload 只能在 Mac 上用')
  expect(cleanSummary('结论：tag 能跨平台')).toBe('tag 能跨平台')
  expect(cleanSummary('这一轮的结论是推荐用 fork')).toBe('推荐用 fork')
  expect(cleanSummary('用户的回复已完成开发')).toBe('已完成开发')
  expect(cleanSummary('“测试都通过了”')).toBe('测试都通过了')
  expect(cleanSummary('**Tests pass**, not committed.\n\nmore')).toBe('Tests pass, not committed')
  expect(cleanSummary('')).toBe('')
})

test('assignIds matches by text; same prompts pair from the end', async () => {
  const keys = ['问A', '继续', '问B', '继续'].map(keyOf)
  // 只画了最近几行：最后一次“继续”和问B
  expect(assignIds(keys, [{ id: 'b', key: '问B' }, { id: 'c2', key: '继续' }])).toEqual([undefined, undefined, 'b', 'c2'])
  // 都画了
  const all = [
    { id: 'a', key: '问A' },
    { id: 'c1', key: '继续' },
    { id: 'b', key: '问B' },
    { id: 'c2', key: '继续' },
  ]
  expect(assignIds(keys, all)).toEqual(['a', 'c1', 'b', 'c2'])
  // 文字只出现一次的，先后排错了也对得上
  expect(assignIds(keys, [{ id: 'b', key: '问B' }, ...all.filter(r => r.id !== 'b')])).toEqual(['a', 'c1', 'b', 'c2'])
  // 很长的提问只比前 20 个字（界面上的写法偶尔和记录里不同）
  const long = keyOf('这是一个很长很长的提问，后面还带着一张图片的说明文字')
  expect(assignIds([long], [{ id: 'x', key: keyOf('这是一个很长很长的提问，后面还带着一张图片的说明文字[Image #1]') }])).toEqual(['x'])
})

test('rows keep transcript order: first batch top-down, older rows in front, new prompts at the end', async () => {
  const rows = new Rows()
  // 打开时画出最下面几行（同一批，从上往下）
  rows.user('p3', '问三', null, 1000)
  rows.other('a3', ['答三'], null, 1000)
  rows.user('p4', '问四', { first: 0, last: 1, of: 2 }, 1001)
  expect(rows.order.map(r => r.id)).toEqual(['p3', 'p4'])
  // 往上翻，又画出更早的一批
  rows.user('p1', '问一', null, 2000)
  rows.user('p2', '问二', null, 2001)
  expect(rows.order.map(r => r.id)).toEqual(['p1', 'p2', 'p3', 'p4'])
  // 新提问先以 placeholder 画，再换成真 id：接在最后
  rows.user('placeholder', '问五', null, 3000)
  rows.user('p5', '问五', null, 3010)
  expect(rows.order.map(r => r.id).at(-1)).toBe('p5')
  // 没见到 placeholder 的新提问被放到了最前面，这一轮开始时挪回最后
  rows.user('p6', '问六', null, 5000)
  expect(rows.order[0]!.id).toBe('p6')
  rows.started('问六', 5050)
  expect(rows.order.map(r => r.id)).toEqual(['p1', 'p2', 'p3', 'p4', 'p5', 'p6'])
  // 这一轮先开始、那一行后画出来，也接在最后
  rows.started('问七', 6000)
  rows.user('p7', '问七', null, 6100)
  expect(rows.order.at(-1)!.id).toBe('p7')
  rows.forget('p3')
  expect(rows.order.map(r => r.id)).not.toContain('p3')
})

test('rows remember where replies and tool calls can be found, and what is on screen', async () => {
  const rows = new Rows()
  rows.user('p9', '问九', { first: 0, last: 1, of: 2 }, 0)
  rows.other('toolu_1', ['toolu_1'], { first: 3, last: 9, of: 10 }, 0)
  rows.other('a9', [keyOf('答九')], null, 0)
  rows.other('nothing', [], undefined, 0)
  expect([...rows.marked()]).toEqual([
    ['toolu_1', ['toolu_1']],
    ['a9', ['答九']],
  ])
  expect(rows.size).toBe(4)
  expect(rows.isTopShown('p9')).toBe(true)
  expect(rows.isTopShown('toolu_1')).toBe(false)
  expect(rows.isTopShown('a9')).toBe(false)
  expect(rows.isTopShown('never')).toBeUndefined()
  rows.forget('toolu_1')
  expect([...rows.marked()].map(([id]) => id)).toEqual(['a9'])
})

test('placesOf finds tool calls by id and replies by text, leaving out repeated texts', async () => {
  const places = placesOf([
    { role: 'user', text: '问一' },
    { role: 'assistant', text: '先看看', toolUses: [{ tool_use_id: 't1' }, { tool_use_id: 't2' }] },
    { role: 'user', text: '', toolResults: [{}] },
    { role: 'assistant', text: '好的' },
    { role: 'user', text: '问二' },
    { role: 'assistant', text: '好的' },
  ])
  expect(places.tools.get('t1')).toBeGreaterThan(1)
  expect(places.tools.get('t2')).toBeGreaterThan(places.tools.get('t1')!)
  expect(places.tools.get('t2')).toBeLessThan(2)
  expect(places.texts.get(keyOf('先看看'))).toBe(1)
  expect(places.texts.has(keyOf('好的'))).toBe(false)
  expect(splitTurns([{ role: 'user', text: '问一' }, { role: 'user', text: '问二' }]).map(t => t.at)).toEqual([0, 1])
  // 本地命令那一行也能按文字找到
  expect(placesOf([user('<command-name>/reload-plugins</command-name>')]).texts.get(keyOf('/reload-plugins'))).toBe(0)
})

test('endsWithTurn tells a prompt being answered from a notification being answered', async () => {
  expect(endsWithTurn([user('问题'), bot('回答中'), user('', [{}])])).toBe(true)
  expect(endsWithTurn([user('问题'), bot('好'), user('<task-notification>x</task-notification>')])).toBe(false)
  expect(endsWithTurn([user('问题'), user('<command-name>/review</command-name>')])).toBe(true)
  expect(endsWithTurn([])).toBe(false)
})
