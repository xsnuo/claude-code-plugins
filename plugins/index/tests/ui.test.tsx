import { expect, test } from 'claude-code/testing'

import { hashOf } from '../hooks/turns'

// 测试里没有真引擎：engine() 注册的钩子扮演引擎——对话记录、面板、模型、$.store 和提示。
// 翻动对话（$.ui.scroll 到某一行）在测试工具里没有可以扮演的钩子，跳转的逻辑在 jump.test.ts 里单独测。

const USAGE = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }

type World = {
  history: object[]
  panes: { id: string; title: string; isShown: boolean; isFocused: boolean; isPlaced: boolean }[]
  opened: object[]
  closed: string[]
  toasts: string[]
  views: object[]
  models: string[]
  prompts: string[]
  // 按模型给出的回答；没写的就答 SUMMARY
  answers: Record<string, 'throw' | object>
  store: Record<string, unknown>
}

const SUMMARY = '改用 haiku 写摘要，测试已通过'

function world(history: object[] = HISTORY): World {
  return { history, panes: [], opened: [], closed: [], toasts: [], views: [], models: [], prompts: [], answers: {}, store: {} }
}

const user = (text: string) => ({ role: 'user', text, toolUses: [] })
const bot = (text: string, toolUses: object[] = []) => ({ role: 'assistant', text, toolUses })

const HISTORY = [
  user('第一个问题：aload 能在 Windows 上用吗？'),
  bot('我先看看代码。', [{ tool_use_id: 't1', tool: 'Read', input: {} }]),
  { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 't1', text: 'ok' }] },
  bot('## 结论\n\n**不能**，路径写死了。'),
  user('<task-notification>\n<task-id>b1</task-id>\n</task-notification>'),
  bot('后台任务跑完了。'),
  user('继续'),
  bot('改好了，测试都通过。'),
]

function engine(on: any, w: World) {
  on('session.messages', () => ({ value: w.history }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('command.register', () => ({ value: undefined }))
  on('store.get', ($: any, e: any) => ({ value: w.store[e.key] }))
  on('store.set', ($: any, e: any) => {
    w.store[e.key] = JSON.parse(JSON.stringify(e.value))
    return { value: undefined }
  })
  on('ui.panes', () => ({ value: w.panes }))
  on('ui.open', ($: any, e: any) => {
    w.opened.push(e)
    w.panes = [{ id: e.id, title: e.title ?? e.id, isShown: true, isFocused: false, isPlaced: true }]
    return { value: { isPlaced: true } }
  })
  on('ui.close', ($: any, e: any) => {
    w.closed.push(e.id)
    w.panes = []
    return { value: undefined }
  })
  on('ui.toast', ($: any, e: any) => {
    w.toasts.push(e.text ?? String(e))
    return { value: undefined }
  })
  on('ui.view', ($: any, e: any) => {
    w.views.push(e)
    return { value: {} }
  })
  on('model.complete', ($: any, e: any) => {
    w.models.push(`${e.model} ${e.effort}`)
    w.prompts.push(e.prompt)
    const a = w.answers[e.model]
    if (a === 'throw') throw new Error(`model ${e.model} is not available`)
    return { value: a ?? { isAnswered: true, text: `摘要：${SUMMARY}。`, usage: USAGE } }
  })
  on('clock.sleep', () => ({ value: undefined }))
  // 引擎自己画的对话行
  on('ui.render', () => ({ type: 'engine', ref: 0 }))
  // 生命周期事件直接答结果，不像 $ 调用那样包在 value 里
  on('session.start', ($: any, e: any) => ({ cwd: e.cwd }))
  on('session.end', ($: any, e: any) => ({ sessionId: e.sessionId }))
  on('turn.start', ($: any, e: any) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
}

async function start($: any) {
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
}

// 插件在后台接着做的事（更新目录、写摘要）没有可以等的东西：反复画目录，直到画出来的不再变、也没有正在写的摘要
async function idle($: any) {
  let last = ''
  let still = 0
  for (let i = 0; i < 100 && still < 3; i++) {
    const ui = await mountPane($)
    const now = JSON.stringify(await ui.drawn())
    await ui.unmount()
    still = now === last && !/⋯ (?!回答中)/.test(now) ? still + 1 : 0
    last = now
  }
}

async function run($: any, args = '') {
  const res = await $.command.run({ command: 'index', args } as any)
  await idle($)
  return res
}

async function finish($: any, answer: string, turnId: string) {
  await $.turn.complete({ answer, reason: 'answer', durationMs: 1, isAborted: false, turnId } as any)
  await idle($)
}

function mountPane($: any, surface: 'terminal' | 'desktop' = 'terminal', placement: 'dock' | 'inline' = 'dock', view: object = {}) {
  return $.ui.mount({
    plugin: 'index',
    surface,
    component: 'Pane',
    requestId: 'index',
    props: { title: '目录', isFocused: false, bodyColumns: 60, placement, scroll: { offset: 0, bodyRows: 30 }, view },
  })
}

// 每一项（Button）上的文字，按行
async function entries(ui: any): Promise<string[][]> {
  const buttons = await ui.findAll({ type: 'Button' })
  return buttons.map((b: any) => String(b.props.label).split('\n').map((l: string) => l.trim()))
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`/index opens the pane: one entry per turn, its prompt and Claude's summary (${surface})`, async ($, on) => {
    const w = world()
    engine(on, w)
    await start($)
    const res = await run($)
    expect(res.text).toBe('目录已打开，点一项就跳到那次提问')
    expect(w.opened).toEqual([{ id: 'index', title: '目录', columns: 50 }])
    // 每轮写一次摘要：用 haiku，low 档位，新的先写；任务通知不算一轮
    expect(w.models).toEqual(['haiku low', 'haiku low'])
    expect(w.prompts[0]).toContain('<question>\n继续\n</question>')
    expect(w.prompts[1]).toContain('<reply>\n## 结论\n\n**不能**，路径写死了。\n</reply>')
    const ui = await mountPane($, surface)
    expect((await ui.find({ type: 'Text', text: /^共 2 轮/ }))?.text).toBe('共 2 轮 · 点一项跳到那次提问')
    expect(await entries(ui)).toEqual([
      ['1 第一个问题：aload 能在 Windows 上用吗？', SUMMARY],
      ['2 继续', SUMMARY],
    ])
    expect((await ui.find({ key: 'turn-0' }))?.type).toBe('Button')
    // 写好的摘要存进 $.store，下次会话不再写
    expect(Object.values(w.store.summaries as object)).toEqual([SUMMARY, SUMMARY])
    await ui.unmount()
  })
}

test('a long prompt is cut to one line, a long summary to two', async ($, on) => {
  const w = world([user(`很长的提问${'字'.repeat(80)}`), bot('好')])
  w.answers.haiku = { isAnswered: true, text: `很长的摘要${'句'.repeat(80)}`, usage: USAGE }
  engine(on, w)
  await start($)
  await run($)
  const ui = await mountPane($)
  const [prompt, ...summary] = (await entries(ui))[0]!
  expect(prompt!.endsWith('…')).toBe(true)
  expect(summary).toHaveLength(2)
  expect(summary[1]!.endsWith('…')).toBe(true)
  await ui.unmount()
})

test('summaries already in $.store are used without asking again', async ($, on) => {
  const w = world()
  w.store.summaries = { [hashOf('改好了，测试都通过。')]: '早就写好的摘要' }
  engine(on, w)
  await start($)
  await run($)
  expect(w.models).toEqual(['haiku low']) // 只写了第一轮
  const ui = await mountPane($)
  expect((await entries(ui))[1]).toEqual(['2 继续', '早就写好的摘要'])
  await ui.unmount()
})

test('a model that cannot answer is skipped; if none can, the reply’s first sentence is shown', async ($, on) => {
  const w = world([user('问题'), bot('## 结论\n\n**不能**，路径写死了。')])
  w.answers.haiku = 'throw'
  w.answers.sonnet = { isAnswered: false, reason: 'api-error', status: 529, usage: USAGE }
  engine(on, w)
  await start($)
  await run($)
  expect(w.models).toEqual(['haiku low', 'sonnet low', 'claude-opus-5-5 low'])
  let ui = await mountPane($)
  expect((await entries(ui))[0]).toEqual(['1 问题', SUMMARY])
  await ui.unmount()

  // 都答不了：显示回复的第一句；关掉再打开时再试
  w.answers['claude-opus-5-5'] = 'throw'
  w.history = [...w.history, user('第二个问题'), bot('第二个回答。')]
  await finish($, '第二个回答。', 't2')
  ui = await mountPane($)
  expect((await entries(ui))[1]).toEqual(['2 第二个问题', '第二个回答。'])
  await ui.unmount()
})

test('the turn being answered shows ⋯ 回答中 and is summarized once it ends', async ($, on) => {
  const w = world()
  engine(on, w)
  await start($)
  await run($)
  w.history = [...HISTORY, user('第三个问题')]
  await $.turn.start({ text: '第三个问题', turnId: 't3' } as any)
  await idle($)
  let ui = await mountPane($)
  expect((await entries(ui))[2]).toEqual(['3 第三个问题', '⋯ 回答中'])
  await ui.unmount()
  expect(w.models).toHaveLength(2)

  w.history = [...w.history, bot('第三个回答。')]
  await finish($, '第三个回答。', 't3')
  ui = await mountPane($)
  expect((await entries(ui))[2]).toEqual(['3 第三个问题', SUMMARY])
  expect(w.models).toHaveLength(3)
  await ui.unmount()
})

test('a turn started by a background task does not mark the last entry as answering', async ($, on) => {
  const w = world()
  engine(on, w)
  await start($)
  await run($)
  w.history = [...HISTORY, user('<task-notification>\n<task-id>b2</task-id>\n</task-notification>')]
  await $.turn.start({ text: '<task-notification>…', turnId: 't4' } as any)
  await idle($)
  const ui = await mountPane($)
  expect((await entries(ui))[1]).toEqual(['2 继续', SUMMARY])
  await ui.unmount()
})

test('/index summary off: no model calls, the first sentence of each reply instead', async ($, on) => {
  const w = world()
  engine(on, w)
  await start($)
  expect((await run($, 'summary off')).text).toBe('摘要不再请 Claude 写，改用回复的第一句')
  expect(w.store.useModel).toBe(false)
  await run($)
  expect(w.models).toEqual([])
  const ui = await mountPane($)
  expect(await entries(ui)).toEqual([
    ['1 第一个问题：aload 能在 Windows 上用吗？', '结论'],
    ['2 继续', '改好了，测试都通过。'],
  ])
  await ui.unmount()
  expect((await run($, 'summary on')).text).toBe('摘要改由 Claude 来写（用 haiku，一轮写一次）')
  expect(w.models).toHaveLength(2)
  expect((await run($, 'what')).text).toContain('/index summary off')
})

test('/index again closes the pane; nothing is summarized while it is closed', async ($, on) => {
  const w = world()
  engine(on, w)
  await start($)
  await run($)
  expect((await run($)).text).toBe('目录已关闭')
  expect(w.closed).toEqual(['index'])
  w.history = [...HISTORY, user('关着的时候问的'), bot('答了。')]
  await finish($, '答了。', 't5')
  expect(w.models).toHaveLength(2)
})

test('/clear empties the list', async ($, on) => {
  const w = world()
  engine(on, w)
  await start($)
  await run($)
  await $.session.end({ reason: 'clear', sessionId: 's1' } as any)
  await idle($)
  const ui = await mountPane($)
  expect(await ui.findAll({ type: 'Button' })).toEqual([])
  expect((await ui.find({ type: 'Text', text: /还没有对话/ }))?.text).toBe('还没有对话')
  await ui.unmount()
})

test('outside the fullscreen layout the pane says jumping needs it', async ($, on) => {
  const w = world()
  engine(on, w)
  await start($)
  const res = await $.command.run({ command: 'index', args: '', presentation: { isFullscreen: false, columns: 120 } } as any)
  await idle($)
  expect(res.text).toContain('/tui fullscreen')
  const ui = await mountPane($, 'terminal', 'inline')
  expect((await ui.find({ type: 'Text', text: /^共/ }))?.text).toBe('共 2 轮')
  expect(await ui.find({ type: 'Text', text: /全屏界面/ })).toBeDefined()
  await ui.unmount()
})

test('pressing an entry while a subagent’s transcript is shown goes back to the main one first', async ($, on) => {
  const w = world()
  engine(on, w)
  await start($)
  await run($)
  const ui = await mountPane($, 'terminal', 'dock', { agentId: 'a1' })
  // 接下来要翻动对话，测试工具里没法扮演那一步，所以这一下按不完
  await ui.press({ key: 'turn-0' }).catch(() => undefined)
  expect(w.views).toEqual([{}])
  await ui.unmount()
})
