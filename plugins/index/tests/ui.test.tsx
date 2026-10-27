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
  sid: string
  copied: string[]
  // 设了就扮演“开了但没画出来”（终端不够宽、后台会话还没有界面连上），值是原因
  unplaced?: string
}

const SUMMARY = '改用 haiku 写摘要，测试已通过'

function world(history: object[] = HISTORY): World {
  return { history, panes: [], opened: [], closed: [], toasts: [], views: [], models: [], prompts: [], answers: {}, store: {}, sid: 'sid-1', copied: [] }
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
  // 面板照引擎的规矩：标签按打开的先后排，新打开的显示在前面；已经开着的再打开，带 focus 才抬到前面
  on('ui.open', ($: any, e: any) => {
    w.opened.push(e)
    const isPlaced = !w.unplaced
    const had = w.panes.find(p => p.id === e.id)
    const shows = had ? (had.isPlaced ? had.isShown || !!e.focus : isPlaced) : isPlaced
    const pane = { id: e.id, title: e.title ?? e.id, isShown: shows, isFocused: false, isPlaced: had?.isPlaced || isPlaced }
    const rest = (p: World['panes'][number]) => (shows ? { ...p, isShown: false } : p)
    w.panes = had ? w.panes.map(p => (p.id === e.id ? pane : rest(p))) : [...w.panes.map(rest), pane]
    return { value: isPlaced ? { isPlaced } : { isPlaced, reason: w.unplaced } }
  })
  on('ui.close', ($: any, e: any) => {
    w.closed.push(e.id)
    const wasShown = w.panes.find(p => p.id === e.id)?.isShown
    w.panes = w.panes.filter(p => p.id !== e.id)
    if (wasShown && w.panes.length) w.panes = w.panes.map((p, i) => ({ ...p, isShown: i === w.panes.length - 1 }))
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
  on('session.id', () => ({ value: w.sid }))
  on('ui.copy', ($: any, e: any) => {
    w.copied.push(e.text)
    return { value: { isCopied: true } }
  })
  // 引擎自己画的对话行
  on('ui.render', () => ({ type: 'engine', ref: 0 }))
  // 生命周期事件直接答结果，不像 $ 调用那样包在 value 里
  on('session.start', ($: any, e: any) => ({ cwd: e.cwd }))
  on('session.end', ($: any, e: any) => ({ sessionId: e.sessionId }))
  on('session.attach', ($: any, e: any) => ({ clientId: e.clientId }))
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

function mountPane($: any, surface: 'terminal' | 'desktop' = 'terminal', placement: 'dock' | 'inline' = 'dock', view: object = {}, bodyRows = 30) {
  return $.ui.mount({
    plugin: 'index',
    surface,
    component: 'Pane',
    requestId: 'index',
    props: { title: '目录', isFocused: false, bodyColumns: 60, placement, scroll: { offset: 0, bodyRows }, view },
  })
}

// 目录列表里每一项（key 以 prefix 开头的 Button）上的文字，按行；收藏栏里的一项用 prefix 'fav-'
async function entries(ui: any, prefix = 'turn-'): Promise<string[][]> {
  const buttons = await ui.findAll({ type: 'Button' })
  return buttons
    .filter((b: any) => String(b.key).startsWith(prefix) && !String(b.key).startsWith('fav-star'))
    .map((b: any) => String(b.props.label).split('\n').map((l: string) => l.trim()))
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
    expect((await ui.find({ type: 'Text', text: /^共 2 轮/ }))?.text).toBe('共 2 轮 · 点一项跳过去，点 ☆ 收藏')
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

test('a long prompt wraps to two lines by default, a long summary to two; /index lines sets the prompt’s', async ($, on) => {
  // 提问 170 格，每行 56 格：折成四行正好放下
  const w = world([user(`很长的提问${'字'.repeat(80)}`), bot('好')])
  w.answers.haiku = { isAnswered: true, text: `很长的摘要${'句'.repeat(80)}`, usage: USAGE }
  engine(on, w)
  await start($)
  await run($)
  let ui = await mountPane($)
  let entry = (await entries(ui))[0]!
  expect(entry).toHaveLength(4)
  expect(entry[0]).toBe(`1 很长的提问${'字'.repeat(23)}`)
  expect(entry[1]!.endsWith('…')).toBe(true)
  expect(entry[3]!.endsWith('…')).toBe(true)
  await ui.unmount()

  expect((await run($, 'lines 4')).text).toBe('提问最多折成 4 行，放不下的截掉')
  expect(w.store.promptLines).toBe(4)
  ui = await mountPane($)
  entry = (await entries(ui))[0]!
  expect(entry.slice(0, 4)).toEqual([`1 很长的提问${'字'.repeat(23)}`, '字'.repeat(28), '字'.repeat(28), '字'])
  expect(entry).toHaveLength(6)
  await ui.unmount()

  expect((await run($, 'lines 1')).text).toBe('提问只显示一行，放不下的截掉')
  ui = await mountPane($)
  entry = (await entries(ui))[0]!
  expect(entry).toHaveLength(3)
  expect(entry[0]!.endsWith('…')).toBe(true)
  await ui.unmount()

  for (const bad of ['0', '6', '2.5', 'abc']) expect((await run($, `lines ${bad}`)).text).toBe('行数要是 1 到 5 的整数，比如 /index lines 2')
  expect(w.store.promptLines).toBe(1)
})

test('the prompt line setting is kept for the next session; favorites wrap the same way', async ($, on) => {
  const w = world([user(`很长的提问${'字'.repeat(80)}`), bot('好')])
  w.store.promptLines = 3
  engine(on, w)
  await start($)
  await run($, 'summary off')
  await run($)
  let ui = await mountPane($)
  expect((await entries(ui))[0]).toHaveLength(4)
  await ui.press({ key: 'star-0' })
  await ui.unmount()
  ui = await mountPane($)
  const fav = (await entries(ui, 'fav-'))[0]!
  expect(fav).toHaveLength(4)
  expect(fav[2]!.endsWith('…')).toBe(true)
  expect(fav[3]).toBe('好')
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
  const help = (await run($, 'what')).text
  expect(help).toContain('/index summary off')
  expect(help).toContain('/index auto on')
  expect(help).toContain('现在的设置：摘要：Claude 写 · 进入会话时自动打开：关 · 提问最多 2 行')
})

// ---------- 进入会话时自动打开 ----------

test('by default the pane is not opened on entering a session', async ($, on) => {
  const w = world()
  engine(on, w)
  await start($)
  await idle($)
  expect(w.opened).toEqual([])
  expect(w.models).toEqual([])
})

test('/index auto on is saved and takes effect from the next session', async ($, on) => {
  const w = world()
  engine(on, w)
  await start($)
  expect((await run($, 'auto on')).text).toBe('以后进入会话时自动打开目录（启动、claude --resume、/clear 之后）')
  expect(w.store.autoOpen).toBe(true)
  // 这次进程里已经进过会话了：设置只管以后
  expect(w.opened).toEqual([])
})

test('with auto on the pane opens at session start and the summaries are written', async ($, on) => {
  const w = world()
  w.store.autoOpen = true
  engine(on, w)
  await start($)
  await idle($)
  expect(w.opened).toEqual([{ id: 'index', title: '目录', columns: 50 }])
  expect(w.models).toEqual(['haiku low', 'haiku low'])
  const ui = await mountPane($)
  expect(await entries(ui)).toEqual([
    ['1 第一个问题：aload 能在 Windows 上用吗？', SUMMARY],
    ['2 继续', SUMMARY],
  ])
  await ui.unmount()

  // 用户关掉了：重新加载插件（session.start 再来一次）不再打开
  expect((await run($)).text).toBe('目录已关闭')
  await start($)
  await idle($)
  expect(w.opened).toHaveLength(1)

  // /clear 是新的对话：再打开
  await $.session.end({ reason: 'clear', sessionId: 'sid-1' } as any)
  await idle($)
  expect(w.opened).toHaveLength(2)

  // 关掉自动打开
  expect((await run($, 'auto off')).text).toBe('以后进入会话时不再自动打开目录，要看时执行 /index')
  await run($)
  await $.session.end({ reason: 'clear', sessionId: 'sid-2' } as any)
  await idle($)
  expect(w.opened).toHaveLength(2)
})

test('a pane opened at start that is not drawn yet writes no summaries until a surface attaches; /index draws it', async ($, on) => {
  const w = world()
  w.store.autoOpen = true
  w.unplaced = 'no-surface'
  engine(on, w)
  await start($)
  await idle($)
  expect(w.opened).toHaveLength(1)
  expect(w.models).toEqual([])

  // 后台会话：claude attach 连上以后画出来，这时写摘要
  w.panes = [{ ...w.panes[0]!, isShown: true, isPlaced: true }]
  await $.session.attach({ surface: 'terminal', clientId: 'terminal:default' } as any)
  await idle($)
  expect(w.models).toEqual(['haiku low', 'haiku low'])

  // 终端不够宽、还没画出来时执行 /index：是打开，不是关掉
  w.panes = [{ ...w.panes[0]!, isShown: false, isPlaced: false }]
  w.unplaced = undefined
  expect((await run($)).text).toBe('目录已打开，点一项就跳到那次提问')
  expect(w.closed).toEqual([])
  expect(w.opened).toHaveLength(2)
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

// ---------- 收藏 ----------

const pinned = async (ui: any) => (await ui.find({ type: 'Text', text: /^★ 收藏/ }))?.text

test('☆ stars a turn: it is pinned on top, marked ★ in the list and kept for this session', async ($, on) => {
  const w = world()
  engine(on, w)
  await start($)
  await run($)
  let ui = await mountPane($)
  expect(await pinned(ui)).toBeUndefined()
  expect((await ui.find({ key: 'star-0' }))?.props.label).toBe('收藏')
  await ui.press({ key: 'star-0' })
  await ui.unmount()

  ui = await mountPane($)
  expect(await pinned(ui)).toBe('★ 收藏 1 轮')
  expect(await entries(ui, 'fav-')).toEqual([['1 第一个问题：aload 能在 Windows 上用吗？', SUMMARY]])
  expect((await ui.find({ key: 'star-0' }))?.props.label).toBe('取消收藏')
  expect((await ui.find({ key: 'star-1' }))?.props.label).toBe('收藏')
  // 缓存着提问和回答，按会话 id 存进 $.store
  const saved = (w.store.favorites as any)['sid-1'].items
  expect(saved).toHaveLength(1)
  expect(saved[0]).toEqual(expect.objectContaining({ prompt: '第一个问题：aload 能在 Windows 上用吗？', answer: '## 结论\n\n**不能**，路径写死了。', summary: SUMMARY }))

  // 收藏栏里的 ★ 取消
  await ui.press({ key: 'fav-star-0' })
  await ui.unmount()
  ui = await mountPane($)
  expect(await pinned(ui)).toBeUndefined()
  expect((await ui.find({ key: 'star-0' }))?.props.label).toBe('收藏')
  expect(w.store.favorites).toEqual({})
  await ui.unmount()
})

test('a starred turn that compaction removed stays pinned; clicking it copies the cached prompt and answer', async ($, on) => {
  const w = world()
  engine(on, w)
  await start($)
  await run($)
  let ui = await mountPane($)
  await ui.press({ key: 'star-0' })
  await ui.unmount()
  // 压缩对话：前面的轮次不在了
  w.history = [user('压缩后的新问题'), bot('新回答。')]
  await finish($, '新回答。', 't9')
  ui = await mountPane($)
  expect(await entries(ui)).toEqual([['1 压缩后的新问题', SUMMARY]])
  expect(await entries(ui, 'fav-')).toEqual([['- 第一个问题：aload 能在 Windows 上用吗？', `已压缩 · ${SUMMARY}`]])
  await ui.press({ key: 'fav-0' })
  expect(w.copied).toEqual(['第一个问题：aload 能在 Windows 上用吗？\n\n## 结论\n\n**不能**，路径写死了。'])
  expect(w.toasts.at(-1)).toContain('已复制到剪贴板')
  await ui.unmount()
})

test('favorites come back when the session is resumed, and /clear drops them', async ($, on) => {
  const w = world()
  w.store.favorites = {
    'sid-1': { at: 1, items: [{ key: '继续', hash: hashOf('改好了，测试都通过。'), nth: 0, prompt: '继续', answer: '改好了，测试都通过。', head: '改好了，测试都通过。', summary: '早就写好的摘要' }] },
    'sid-other': { at: 2, items: [{ key: '别的会话', hash: 'x', nth: 0, prompt: '别的会话', answer: '', head: '', summary: '' }] },
  }
  engine(on, w)
  await start($)
  await run($)
  let ui = await mountPane($)
  expect(await entries(ui, 'fav-')).toEqual([['2 继续', '早就写好的摘要']])
  expect((await ui.find({ key: 'star-1' }))?.props.label).toBe('取消收藏')
  await ui.unmount()

  await $.session.end({ reason: 'clear', sessionId: 'sid-1' } as any)
  await idle($)
  ui = await mountPane($)
  expect(await pinned(ui)).toBeUndefined()
  await ui.unmount()
  expect(Object.keys(w.store.favorites as object)).toEqual(['sid-other'])
})

test('a turn starred while it is being answered gets its answer once done', async ($, on) => {
  const w = world()
  engine(on, w)
  await start($)
  await run($)
  w.history = [...HISTORY, user('第三个问题')]
  await $.turn.start({ text: '第三个问题', turnId: 't3' } as any)
  await idle($)
  let ui = await mountPane($)
  await ui.press({ key: 'star-2' })
  await ui.unmount()
  ui = await mountPane($)
  expect(await entries(ui, 'fav-')).toEqual([['3 第三个问题', '⋯ 回答中']])
  await ui.unmount()

  w.history = [...w.history, bot('第三个回答。')]
  await finish($, '第三个回答。', 't3')
  ui = await mountPane($)
  expect(await entries(ui, 'fav-')).toEqual([['3 第三个问题', SUMMARY]])
  await ui.unmount()
  expect((w.store.favorites as any)['sid-1'].items[0]).toEqual(expect.objectContaining({ hash: hashOf('第三个回答。'), answer: '第三个回答。' }))
})

test('a long list scrolls by itself under the pinned favorites, which never scroll away', async ($, on) => {
  const many: object[] = []
  for (let i = 1; i <= 12; i++) many.push(user(`第 ${i} 个问题`), bot(`第 ${i} 个回答。`))
  const w = world(many)
  engine(on, w)
  await start($)
  await run($, 'summary off')
  await run($)
  let ui = await mountPane($, 'terminal', 'dock', {}, 20)
  await ui.press({ key: 'star-11' })
  await ui.unmount()

  const scroll = (by: number) => $.ui.scroll({ component: 'Pane', requestId: 'index', offset: 0, by, bodyRows: 20, contentRows: 20, origin: { kind: 'person' } } as any)
  // 面板 20 行：说明 1 行、收藏栏 4 行、列表上下的提示各 1 行，列表区 13 行，每项 3 行，放得下 4 项
  ui = await mountPane($, 'terminal', 'dock', {}, 20)
  // 打开时停在最后几轮；放不下的说一声
  expect((await entries(ui)).map(e => e[0])).toEqual(['9 第 9 个问题', '10 第 10 个问题', '11 第 11 个问题', '12 第 12 个问题'])
  expect((await ui.find({ type: 'Text', text: /上面还有/ }))?.text).toBe('↑ 上面还有 8 轮（滚动目录翻看）')
  await ui.unmount()

  await scroll(-1) // 一格滚轮，往上翻一项
  ui = await mountPane($, 'terminal', 'dock', {}, 20)
  expect((await entries(ui)).map(e => e[0])).toEqual(['8 第 8 个问题', '9 第 9 个问题', '10 第 10 个问题', '11 第 11 个问题'])
  await ui.unmount()

  await scroll(-100) // 翻到顶：收藏还在最上面
  ui = await mountPane($, 'terminal', 'dock', {}, 20)
  expect((await entries(ui))[0]![0]).toBe('1 第 1 个问题')
  expect(await pinned(ui)).toBe('★ 收藏 1 轮')
  expect(await entries(ui, 'fav-')).toEqual([['12 第 12 个问题', '第 12 个回答。']])
  expect((await ui.find({ type: 'Text', text: /下面还有/ }))?.text).toBe('↓ 下面还有 8 轮（滚动目录翻看）')
  await ui.unmount()

  await scroll(100) // 翻到底：又跟着最后，新的一轮会显示出来
  w.history = [...many, user('第 13 个问题'), bot('第 13 个回答。')]
  await finish($, '第 13 个回答。', 't13')
  ui = await mountPane($, 'terminal', 'dock', {}, 20)
  expect((await entries(ui)).at(-1)![0]).toBe('13 第 13 个问题')
  await ui.unmount()
})

test('at most 30 favorites', async ($, on) => {
  const many: object[] = []
  for (let i = 1; i <= 31; i++) many.push(user(`问题 ${i}`), bot(`回答 ${i}。`))
  const w = world(many)
  engine(on, w)
  await start($)
  await run($, 'summary off')
  await run($)
  for (let i = 0; i < 31; i++) {
    // 放不下的项要先翻出来才能点：直接用够高的面板
    const ui = await mountPane($, 'terminal', 'dock', {}, 400)
    await ui.press({ key: `star-${i}` })
    await ui.unmount()
  }
  expect((w.store.favorites as any)['sid-1'].items).toHaveLength(30)
  expect(w.toasts.at(-1)).toBe('最多收藏 30 轮，先取消几个')
})

test('each conversation remembers whether its index was open, over auto open', async ($, on) => {
  // 这段对话上次关着目录：自动打开也不开
  let w = world()
  w.store.autoOpen = true
  w.store['pane:sid-1'] = { open: false, at: 1 }
  engine(on, w)
  await start($)
  await idle($)
  expect(w.opened).toEqual([])
  // 打开、关掉都记下来
  await run($)
  expect(w.store['pane:sid-1']).toEqual(expect.objectContaining({ open: true }))
  await run($)
  expect(w.store['pane:sid-1']).toEqual(expect.objectContaining({ open: false }))
})

test('a conversation whose index was open opens it again on entering, even with auto off', async ($, on) => {
  const w = world()
  w.store['pane:sid-1'] = { open: true, at: 1 }
  engine(on, w)
  await start($)
  await idle($)
  expect(w.opened).toEqual([{ id: 'index', title: '目录', columns: 50 }])
})
