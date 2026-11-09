import { expect, mock, test } from 'claude-code/testing'

// 测试里没有真引擎：engine() 注册的钩子扮演引擎——文件、面板、会话 id；时间用 mock.clock，由测试拨动。
// 文件按路径放在 w.files 里，扮演 <配置目录>/jobs、<配置目录>/sessions。

const HOME = '/home/u'
const DIR = `${HOME}/.claude`
const T = Date.parse('2026-10-23T16:00:00.000Z')
const iso = (ms: number) => new Date(ms).toISOString()
const H = 3600_000

type World = {
  files: Record<string, string>
  // $.fs.stat 答的修改时间，按路径（文件、目录都行）；不在这里的答“没有”
  mtimes: Record<string, number>
  reads: string[]
  panes: { id: string; title: string; isShown: boolean; isPlaced: boolean; isFocused: boolean }[]
  opened: object[]
  closed: string[]
  sid: string
  // 显示在前面的面板
  shownId?: string
}

const state = (o: object) => JSON.stringify({ tempo: 'idle', createdAt: iso(T - 48 * H), updatedAt: iso(T - 48 * H), ...o })
const line = (at: number, st: string, detail: string, text = '') => JSON.stringify({ at: iso(at), state: st, detail, text })

function world(): World {
  return {
    files: {
      // 做完了，3 小时前
      [`${DIR}/jobs/aaaa1111/state.json`]: state({ state: 'done', name: '🟢 发版', lastTerminalAt: iso(T - 3 * H - 2 * 60_000 - 1000) }),
      // 在跑，上一次回复在 10 小时前
      [`${DIR}/jobs/bbbb2222/state.json`]: state({ state: 'working', tempo: 'active', name: '产品需求文档整理', updatedAt: iso(T - 5000) }),
      [`${DIR}/jobs/bbbb2222/timeline.jsonl`]: [
        line(T - 11 * H, 'working', '读需求'),
        line(T - 10 * H - 2 * 60_000 - 3000, 'done', '需求理好了', '需求理好了，有三个问题要你定。'),
        line(T - 60_000, 'done', '接着做'),
        line(T - 30_000, 'working', '写文档'),
      ].join('\n'),
      // 问了你一个问题，1 分 5 秒前
      [`${DIR}/jobs/cccc3333/state.json`]: state({ state: 'working', tempo: 'blocked', needs: 'answer: 选哪个？', intent: '线上报错\n帮我查一下', updatedAt: iso(T - 65_000) }),
      // 两天前做完的
      [`${DIR}/jobs/dddd4444/state.json`]: state({ state: 'done', name: '老会话', lastTerminalAt: iso(T - 47 * H) }),
      // 现在这个会话，30 秒前回复的
      [`${DIR}/jobs/eeee5555/state.json`]: state({ state: 'done', name: '我的插件', sessionId: 'job-session', resumeSessionId: 'sid-1', lastTerminalAt: iso(T - 30_000) }),
      // 预先起好、还没用上的会话：没有状态文件
      [`${DIR}/jobs/ffff6666/tmp/x`]: '',
      [`${DIR}/sessions/100.json`]: JSON.stringify({ pid: 100, kind: 'bg', jobId: 'bbbb2222', sessionId: 'b', status: 'busy', name: '产品需求文档整理' }),
      [`${DIR}/sessions/101.json`]: JSON.stringify({ pid: 101, kind: 'bg', jobId: 'cccc3333', sessionId: 'c', status: 'waiting', statusUpdatedAt: T - 65_000 }),
      [`${DIR}/sessions/100.0123abcd.key`]: 'secret',
    },
    mtimes: {},
    reads: [],
    panes: [],
    opened: [],
    closed: [],
    sid: 'sid-1',
  }
}

function engine(on: any, w: World) {
  mock.env(on, { HOME })
  on('fs.list', ($: any, e: any) => {
    const prefix = `${e.path}/`
    const seen = new Map<string, 'file' | 'dir'>()
    for (const p of Object.keys(w.files)) {
      if (!p.startsWith(prefix)) continue
      const rest = p.slice(prefix.length)
      const name = rest.split('/')[0]!
      seen.set(name, rest.includes('/') ? 'dir' : 'file')
    }
    if (!seen.size) throw new Error(`ENOENT: ${e.path}`)
    return { value: [...seen].map(([name, kind]) => ({ name, kind, size: 0, mtimeMs: 0, isLink: false })) }
  })
  on('fs.read', ($: any, e: any) => {
    w.reads.push(e.path)
    if (!(e.path in w.files)) throw new Error(`ENOENT: ${e.path}`)
    return { value: w.files[e.path] }
  })
  on('fs.stat', ($: any, e: any) => {
    if (!(e.path in w.mtimes)) throw new Error(`ENOENT: ${e.path}`)
    return { value: { kind: e.path in w.files ? 'file' : 'dir', size: 0, mtimeMs: w.mtimes[e.path], isLink: false } }
  })
  on('session.id', () => ({ value: w.sid }))
  on('command.register', () => ({ value: undefined }))
  // 面板照引擎的规矩：标签按打开的先后排，新打开的显示在前面；已经开着的再打开，带 focus 才抬到前面
  const show = (id: string | undefined) => {
    w.shownId = id
    w.panes = w.panes.map(p => ({ ...p, isShown: p.id === id }))
  }
  on('ui.panes', () => ({ value: w.panes }))
  on('ui.open', ($: any, e: any) => {
    w.opened.push(e)
    const isFresh = !w.panes.some(p => p.id === e.id)
    if (isFresh) w.panes = [...w.panes, { id: e.id, title: e.title ?? e.id, isShown: false, isPlaced: true, isFocused: false }]
    if (isFresh || e.focus) show(e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.close', ($: any, e: any) => {
    w.closed.push(e.id)
    w.panes = w.panes.filter(p => p.id !== e.id)
    if (w.shownId === e.id) show(w.panes.at(-1)?.id)
    return { value: undefined }
  })
  on('ui.log', () => ({ value: undefined }))
  // 生命周期事件直接答结果，不像 $ 调用那样包在 value 里
  on('session.start', ($: any, e: any) => ({ cwd: e.cwd }))
  on('session.end', ($: any, e: any) => ({ sessionId: e.sessionId }))
}

function mountPane($: any, surface: 'terminal' | 'desktop' = 'terminal', bodyRows = 30) {
  return $.ui.mount({
    plugin: 'fleet',
    surface,
    component: 'Pane',
    requestId: 'fleet',
    props: { title: '会话', isFocused: false, bodyColumns: 40, placement: 'dock', scroll: { offset: 0, bodyRows }, view: {} },
  })
}

const scroll = ($: any, by: number) =>
  $.ui.scroll({ component: 'Pane', requestId: 'fleet', offset: 0, by, bodyRows: 8, contentRows: 8, origin: { kind: 'person' } } as any)

// 列表里的每一行：key 是 job-<id> 的 Box，读出它画的文字
async function rows($: any, surface: 'terminal' | 'desktop' = 'terminal', bodyRows = 30) {
  const ui = await mountPane($, surface, bodyRows)
  const all = await ui.findAll({ type: 'Box' })
  const boxes = all.filter((b: any) => String(b.key).startsWith('job-'))
  const news = all.filter((b: any) => String(b.key).startsWith('news-')).map((b: any) => b.text)
  const notes = (await ui.findAll({ type: 'Text' })).map((t: any) => t.text).filter((x: string) => /还有|列在这里/.test(x))
  const header = (await ui.find({ type: 'Text', text: /个会话|还没有会话/ }))?.text
  const marks = (await ui.findAll({ type: 'Text' })).filter((t: any) => /^[·✢✶✻] $/.test(t.text)).map((t: any) => `${t.text.trim()}${t.props.color ?? (t.props.dimColor ? 'dim' : '')}`)
  await ui.unmount()
  return { header, ids: boxes.map((b: any) => String(b.key).slice(4)), texts: boxes.map((b: any) => b.text), marks, news, notes }
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`/fleet lists every session of claude agents, the newest reply first (${surface})`, async ($, on) => {
    const w = world()
    engine(on, w)
    const clock = mock.clock(on, { now: T })
    await $.session.start({ cwd: '/', surface, isInteractive: true })
    const res = await $.command.run({ command: 'fleet', args: '' } as any)
    await clock.settle()
    expect(res.text).toBe('会话总览已打开')
    expect(w.opened).toEqual([{ id: 'fleet', title: '会话', columns: 44 }])
    const r = await rows($, surface)
    expect(r.header).toBe('5 个会话 · 1 运行中 · 1 等你回复')
    // 没有状态文件的不列；现在这个会话标着“当前”
    expect(r.ids).toEqual(['eeee5555', 'cccc3333', 'aaaa1111', 'bbbb2222', 'dddd4444'])
    expect(r.texts).toEqual(['✻ 我的插件 当前30s', '✻ 线上报错 帮我查一下1m', '✻ 🟢 发版3h 2m', '· 产品需求文档整理10h 2m', '✻ 老会话24h+'])
    // 跑着的是 Claude 的橙色，等你回复黄色，做完了绿色
    expect(r.marks).toEqual(['✻success', '✻warning', '✻success', '·claude', '✻success'])
    // 密钥文件不读
    expect(w.reads.some(p => p.endsWith('.key'))).toBe(false)
  })
}

test('the running mark turns and the times tick; a session that just replied jumps to the top', async ($, on) => {
  const w = world()
  engine(on, w)
  const clock = mock.clock(on, { now: T })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'fleet', args: '' } as any)
  await clock.settle()
  expect((await rows($)).marks[3]).toBe('·claude')
  await clock.advance(250)
  expect((await rows($)).marks[3]).toBe('✢claude')
  await clock.advance(500)
  expect((await rows($)).marks[3]).toBe('✻claude')
  // 时长跟着走
  expect((await rows($)).texts[0]).toBe('✻ 我的插件 当前30s')
  await clock.advance(1250)
  expect((await rows($)).texts[0]).toBe('✻ 我的插件 当前32s')

  // 在跑的那个做完了：下一次读文件（每 2 秒）时排到最上面
  w.files[`${DIR}/jobs/bbbb2222/state.json`] = state({ state: 'done', name: '产品需求文档整理', lastTerminalAt: iso(clock.now() + 1000) })
  w.files[`${DIR}/sessions/100.json`] = JSON.stringify({ pid: 100, kind: 'bg', jobId: 'bbbb2222', sessionId: 'b', status: 'idle' })
  await clock.advance(2000)
  const r = await rows($)
  expect(r.ids[0]).toBe('bbbb2222')
  expect(r.texts[0]).toBe('✻ 产品需求文档整理1s')
  expect(r.header).toBe('5 个会话 · 1 等你回复')

  // 它又开始跑：时长还是从上一次回复算
  w.files[`${DIR}/jobs/bbbb2222/state.json`] = state({ state: 'working', tempo: 'active', name: '产品需求文档整理' })
  w.files[`${DIR}/sessions/100.json`] = JSON.stringify({ pid: 100, kind: 'bg', jobId: 'bbbb2222', sessionId: 'b', status: 'busy' })
  await clock.advance(2000)
  expect((await rows($)).texts[0]).toBe('· 产品需求文档整理3s')
})

test('/fleet again closes it; no reading while it is closed', async ($, on) => {
  const w = world()
  engine(on, w)
  const clock = mock.clock(on, { now: T })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'fleet', args: '' } as any)
  await clock.settle()
  const res = await $.command.run({ command: 'fleet', args: '' } as any)
  expect(res.text).toBe('会话总览已关闭')
  expect(w.closed).toEqual(['fleet'])
  await clock.advance(2000)
  w.reads = []
  await clock.advance(10_000)
  expect(w.reads).toEqual([])
})

test('no sessions yet', async ($, on) => {
  const w = world()
  w.files = {}
  engine(on, w)
  const clock = mock.clock(on, { now: T })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'fleet', args: '' } as any)
  await clock.settle()
  const r = await rows($)
  expect(r.header).toBe('claude agents 里还没有会话')
  expect(r.ids).toEqual([])
})

test('/fleet auto on opens it on entering a session; the setting is kept', async ($, on) => {
  const w = world()
  engine(on, w)
  mock.store(on, {})
  const clock = mock.clock(on, { now: T })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.settle()
  expect(w.opened).toEqual([])
  expect((await $.command.run({ command: 'fleet', args: 'auto on' } as any)).text).toBe('以后进入会话时自动打开会话总览（启动、claude --resume、/clear 之后）')
  expect((await $.command.run({ command: 'fleet', args: 'help' } as any)).text).toContain('现在的设置：进入会话时自动打开：开')
  // /clear 之后也算进入会话
  await $.session.end({ sessionId: 'sid-1', reason: 'clear' } as any)
  await clock.settle()
  expect(w.opened).toEqual([{ id: 'fleet', title: '会话', columns: 44 }])
  expect((await rows($)).ids[0]).toBe('eeee5555')
})

test('a session opened with auto on saved shows the pane at once', async ($, on) => {
  const w = world()
  engine(on, w)
  mock.store(on, { autoOpen: true })
  const clock = mock.clock(on, { now: T })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.settle()
  expect(w.opened).toEqual([{ id: 'fleet', title: '会话', columns: 44 }])
  expect((await rows($)).ids).toHaveLength(5)
})

// 自己扮演 $.store（mock.store 存的是副本），好看、好改存进去的东西
function store(on: any, init: Record<string, unknown> = {}) {
  const st: Record<string, unknown> = { ...init }
  on('store.get', ($: any, e: any) => ({ value: st[e.key] }))
  on('store.set', ($: any, e: any) => {
    st[e.key] = JSON.parse(JSON.stringify(e.value))
    return { value: undefined }
  })
  on('store.keys', () => ({ value: Object.keys(st) }))
  on('store.delete', ($: any, e: any) => {
    delete st[e.key]
    return { value: undefined }
  })
  return st
}

test('the news area lists replies you have not been back to see; opening or /clear does not empty it', async ($, on) => {
  const w = world()
  engine(on, w)
  const st = store(on)
  const clock = mock.clock(on, { now: T })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'fleet', args: '' } as any)
  await clock.settle()
  // 第一次用 fleet：从这时算起，以前的回复不算。会话进程起来不算打开（不一定是你打开了它）
  expect(st.newsSince).toBe(T)
  expect(st['seen:eeee5555']).toBe(undefined)
  let r = await rows($)
  expect(r.news).toEqual([])
  expect(r.notes).toEqual(['别的会话有新回复时会列在这里'])

  // 在跑的那个做完了：置顶，同时进未读消息区；现在这个会话自己的回复不算
  w.files[`${DIR}/jobs/bbbb2222/state.json`] = state({ state: 'done', name: '产品需求文档整理', lastTerminalAt: iso(T + 1000) })
  w.files[`${DIR}/sessions/100.json`] = JSON.stringify({ pid: 100, kind: 'bg', jobId: 'bbbb2222', sessionId: 'b', status: 'idle' })
  w.files[`${DIR}/jobs/eeee5555/state.json`] = state({ state: 'done', name: '我的插件', resumeSessionId: 'sid-1', lastTerminalAt: iso(T + 1500) })
  await clock.advance(2000)
  r = await rows($)
  expect(r.ids.slice(0, 2)).toEqual(['eeee5555', 'bbbb2222'])
  expect(r.news).toEqual(['✻ 产品需求文档整理1s'])

  // 又有一个回复了：新的在上面；/clear 不清空
  w.files[`${DIR}/jobs/aaaa1111/state.json`] = state({ state: 'done', name: '🟢 发版', lastTerminalAt: iso(clock.now() + 500) })
  await clock.advance(2000)
  expect((await rows($)).news).toEqual(['✻ 🟢 发版1s', '✻ 产品需求文档整理3s'])
  await $.session.end({ sessionId: 'sid-1', reason: 'clear' } as any)
  await clock.settle()
  expect((await rows($)).news).toEqual(['✻ 🟢 发版1s', '✻ 产品需求文档整理3s'])

  // 你回到「产品需求文档整理」那个会话看过了（那边的 fleet 记下 seen）：从这里移出去，别的留着
  st['seen:bbbb2222'] = clock.now()
  await clock.advance(2000)
  expect((await rows($)).news).toEqual(['✻ 🟢 发版3s'])
})

test('a short pane cuts the list and scrolls it; the news area stays', async ($, on) => {
  const w = world()
  engine(on, w)
  const clock = mock.clock(on, { now: T })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'fleet', args: '' } as any)
  await clock.settle()
  // 13 行：说明 1，未读消息区 8，列表 13 - 1 - 8 - 2 = 2 个
  let r = await rows($, 'terminal', 13)
  expect(r.ids).toEqual(['eeee5555', 'cccc3333'])
  expect(r.notes).toEqual(['↓ 下面还有 3 个（滚动列表翻看）', '别的会话有新回复时会列在这里'])
  await scroll($, 1)
  r = await rows($, 'terminal', 13)
  expect(r.ids).toEqual(['cccc3333', 'aaaa1111'])
  expect(r.notes).toEqual(['↑ 上面还有 1 个（滚动列表翻看）', '↓ 下面还有 2 个（滚动列表翻看）', '别的会话有新回复时会列在这里'])
  await scroll($, 99)
  expect((await rows($, 'terminal', 13)).ids).toEqual(['bbbb2222', 'dddd4444'])
  await scroll($, -99)
  expect((await rows($, 'terminal', 13)).ids).toEqual(['eeee5555', 'cccc3333'])
})

test('the news area keeps only the latest six', async ($, on) => {
  const w = world()
  engine(on, w)
  const clock = mock.clock(on, { now: T })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'fleet', args: '' } as any)
  await clock.settle()
  // 七个会话先后做完，越往后越晚
  const ids = ['aaaa1111', 'bbbb2222', 'cccc3333', 'dddd4444', 'gggg0001', 'gggg0002', 'gggg0003']
  ids.forEach((id, i) => {
    w.files[`${DIR}/jobs/${id}/state.json`] = state({ state: 'done', name: id, lastTerminalAt: iso(T + 100 * (i + 1)) })
  })
  w.files[`${DIR}/sessions/100.json`] = JSON.stringify({ pid: 100, kind: 'bg', jobId: 'bbbb2222', sessionId: 'b', status: 'idle' })
  w.files[`${DIR}/sessions/101.json`] = JSON.stringify({ pid: 101, kind: 'bg', jobId: 'cccc3333', sessionId: 'c', status: 'idle' })
  await clock.advance(2000)
  const ui = await mountPane($)
  const news = (await ui.findAll({ type: 'Box' })).filter((b: any) => String(b.key).startsWith('news-')).map((b: any) => String(b.key).slice(5))
  await ui.unmount()
  expect(news).toEqual([...ids].reverse().slice(0, 6))
})

test('docked on the right, the news area sits on the bottom edge of the pane; above the prompt it follows the list', async ($, on) => {
  const w = world()
  engine(on, w)
  const clock = mock.clock(on, { now: T })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'fleet', args: '' } as any)
  await clock.settle()
  // 30 行：说明 1、5 个会话、未读消息区 8，空出来的 16 行在列表和未读消息区之间
  let ui = await mountPane($)
  expect((await ui.find({ key: 'gap' }))?.props.height).toBe(16)
  await ui.unmount()
  ui = await $.ui.mount({
    plugin: 'fleet',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'fleet',
    props: { title: '会话', isFocused: false, bodyColumns: 40, placement: 'inline', scroll: { offset: 0, bodyRows: 30 }, view: {} },
  })
  expect(await ui.find({ key: 'gap' })).toBe(undefined)
  await ui.unmount()
})

// 扮演 index 插件：/idx 打开目录、/idx close 关掉
const INDEX = {
  name: 'index-stub',
  register(on: any) {
    on('session.start', async ($: any, e: any, next: any) => {
      const started = await next(e)
      await $.command.register({ name: 'idx', description: 'stub', immediate: true })
      return started
    })
    on('command.run', { command: 'idx' }, async ($: any, e: any) => {
      if (e.args === 'close') await $.ui.close({ id: 'index' })
      else await $.ui.open({ id: 'index', title: '目录', columns: 50 })
      return { text: 'ok' }
    })
  },
}
const idx = ($: any, args = '') => $.command.run({ command: 'idx', args } as any)
const order = (w: World) => w.panes.map(p => p.id)

test('both open on entering: the overview is shown, and the cursor stays in the prompt (no focus)', { plugins: [INDEX] }, async ($, on) => {
  // 先开会话总览、再开目录：目录显示在前面了，会话总览关掉再打开一次，排到最后、显示出来
  const w = world()
  engine(on, w)
  mock.store(on, { autoOpen: true })
  const clock = mock.clock(on, { now: T })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.settle()
  await idx($)
  await clock.settle()
  expect(order(w)).toEqual(['index', 'fleet'])
  expect(w.shownId).toBe('fleet')
  expect(w.closed).toEqual(['fleet'])
  // 不带 focus 打开：带了面板会拿走键盘，打字进不了输入框
  expect(w.opened.some((o: any) => o.focus)).toBe(false)
})

test('/fleet shows the overview; /index shows the index; /fleet again brings the hidden overview back to the front', { plugins: [INDEX] }, async ($, on) => {
  const w = world()
  engine(on, w)
  const clock = mock.clock(on, { now: T })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.advance(25_000)
  await idx($)
  expect((await $.command.run({ command: 'fleet', args: '' } as any)).text).toBe('会话总览已打开')
  await clock.settle()
  expect(order(w)).toEqual(['index', 'fleet'])
  expect(w.shownId).toBe('fleet')
  // 你自己关掉、再打开目录：显示目录，不抢回来
  await idx($, 'close')
  await idx($)
  await clock.settle()
  expect(order(w)).toEqual(['fleet', 'index'])
  expect(w.shownId).toBe('index')
  // 会话总览藏在目录后面时执行 /fleet：挪到最后显示出来，不关
  expect((await $.command.run({ command: 'fleet', args: '' } as any)).text).toBe('会话总览已显示到前面')
  expect(order(w)).toEqual(['index', 'fleet'])
  expect(w.shownId).toBe('fleet')
  expect(w.opened.some((o: any) => o.focus)).toBe(false)
})

test('each conversation remembers its sidebar: open or not, and whether the sessions tab was shown', { plugins: [INDEX] }, async ($, on) => {
  const w = world()
  engine(on, w)
  // mock.store 存的是一份副本，这里自己扮演，好看存进去的东西
  const store: Record<string, unknown> = { autoOpen: true, 'sidebar:sid-1': { open: true, shown: false, at: 1 } }
  on('store.get', ($: any, e: any) => ({ value: store[e.key] }))
  on('store.set', ($: any, e: any) => {
    store[e.key] = JSON.parse(JSON.stringify(e.value))
    return { value: undefined }
  })
  on('store.keys', () => ({ value: Object.keys(store) }))
  const clock = mock.clock(on, { now: T })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.settle()
  await idx($)
  await clock.settle()
  // 上次显示的是目录：照旧
  expect(order(w)).toEqual(['fleet', 'index'])
  expect(w.shownId).toBe('index')
  // 定时记下现在的样子；关掉会话总览也记下
  await clock.advance(2000)
  expect(store['sidebar:sid-1']).toEqual(expect.objectContaining({ open: true, shown: false }))
  await idx($, 'close')
  await clock.advance(2000)
  expect(store['sidebar:sid-1']).toEqual(expect.objectContaining({ open: true, shown: true }))
  expect((await $.command.run({ command: 'fleet', args: '' } as any)).text).toBe('会话总览已关闭')
  expect(store['sidebar:sid-1']).toEqual(expect.objectContaining({ open: false }))
})

test('a conversation whose sidebar was closed stays closed on entering, even with auto on', async ($, on) => {
  const w = world()
  engine(on, w)
  mock.store(on, { autoOpen: true, 'sidebar:sid-1': { open: false, shown: false, at: 1 } })
  const clock = mock.clock(on, { now: T })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.advance(2000)
  expect(w.opened).toEqual([])
})

// claude agents 打开一个会话时写的打开记录，关掉时删掉。msgs 是那个会话进程第一次画出来时的消息数，没有就是还没画出来
const JOURNAL = `${DIR}/daemon/attach-journal`
// false：那个会话进程不给消息数（新建的会话）
function journal(w: World, name: string, msgs?: number | false) {
  const marks =
    msgs === undefined
      ? {}
      : msgs === false
        ? { marksExpected: false }
        : { marksExpected: true, interactiveReached: true, msgsLoaded: msgs, msgsInJsonl: msgs, msgsRenderedAtFirstPaint: msgs }
  w.files[`${JOURNAL}/${name}.json`] = JSON.stringify({ gestureId: name, surface: 'fleet', startedAtEpochMs: T, attempt: 1, pid: 9, ...marks })
}
// 守护进程的 roster.json：各会话进程第一次画出来时的消息数（旁边还有密钥）。'new' 是新建、还没重新打开过的会话，没有消息数；
// 'old' 是 Claude Code 升级以后还跑着旧版本的会话，有消息数但打开时不给
function roster(w: World, msgs: Record<string, number | 'new' | 'old'>) {
  const marksOf = (n: number | 'new') => ({
    dispatch: { launch: n === 'new' ? { mode: 'prompt', restoresTranscript: false } : { mode: 'resume', restoresTranscript: true } },
    firedInteractiveMarks: n === 'new' ? [] : [{ kind: 'content_paint', msgsLoaded: n, msgsInJsonl: n, msgsRenderedAtFirstPaint: n }, { kind: 'prompt_idle' }],
  })
  const worker = (v: number | 'new' | 'old') => ({
    pid: 1,
    rvAuth: 'secret',
    cliVersion: v === 'old' ? '2.1.300' : '2.1.318',
    ...marksOf(v === 'old' ? 77 : v),
  })
  w.files[`${DIR}/daemon/roster.json`] = JSON.stringify({ proto: 1, workers: Object.fromEntries(Object.entries(msgs).map(([id, n]) => [id, worker(n)])) })
  w.files[`${DIR}/daemon.lock`] = JSON.stringify({ pid: 1, version: '2.1.318' })
}
const replied = (w: World, id: string, name: string, at: number) => {
  w.files[`${DIR}/jobs/${id}/state.json`] = state({ state: 'done', name, lastTerminalAt: iso(at) })
}

test('opening a session from claude agents takes it out of the news, in every session; while it is open its replies are not news', async ($, on) => {
  const w = world()
  w.files[`${DIR}/sessions/100.json`] = JSON.stringify({ pid: 100, kind: 'bg', jobId: 'bbbb2222', sessionId: 'b', status: 'idle' })
  roster(w, { aaaa1111: 300, bbbb2222: 120, eeee5555: 40 })
  engine(on, w)
  const st = store(on)
  const clock = mock.clock(on, { now: T })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'fleet', args: '' } as any)
  await clock.settle()

  // 两个会话先后回复：都进未读消息区，新的在上面
  replied(w, 'bbbb2222', '产品需求文档整理', T + 500)
  replied(w, 'aaaa1111', '🟢 发版', T + 1000)
  await clock.advance(2000)
  expect((await rows($)).news).toEqual(['✻ 🟢 发版1s', '✻ 产品需求文档整理1s'])

  // 从 claude agents 打开「产品需求文档整理」：认出是它，记下打开的时间，它从未读消息区里移出去
  journal(w, 'g1', 120)
  await clock.advance(2000)
  expect(st['seen:bbbb2222']).toBe(T + 4000)
  expect((await rows($)).news).toEqual(['✻ 🟢 发版3s'])
  // 打开着的时候它又回复了：不算新消息
  replied(w, 'bbbb2222', '产品需求文档整理', T + 4500)
  await clock.advance(2000)
  expect((await rows($)).news).toEqual(['✻ 🟢 发版5s'])

  // 回到列表（打开记录删掉）：记下关掉的时间，它照样不在未读消息区里
  delete w.files[`${JOURNAL}/g1.json`]
  await clock.advance(2000)
  expect(st['seen:bbbb2222']).toBe(T + 8000)
  expect((await rows($)).news).toEqual(['✻ 🟢 发版7s'])

  // 之后它又回复了：这回是新消息，排到最上面
  replied(w, 'bbbb2222', '产品需求文档整理', T + 9000)
  await clock.advance(2000)
  expect((await rows($)).news).toEqual(['✻ 产品需求文档整理1s', '✻ 🟢 发版9s'])
})

test('the open record is watched even with the pane closed, and one record already noted is not written again', async ($, on) => {
  const w = world()
  roster(w, { aaaa1111: 300, bbbb2222: 120 })
  engine(on, w)
  const st = store(on)
  const clock = mock.clock(on, { now: T })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.settle()
  journal(w, 'g1', 300)
  await clock.advance(2000)
  expect(st['seen:aaaa1111']).toBe(T + 2000)
  // 别的会话的 fleet 刚记过（比如一秒前）：不再记
  delete w.files[`${JOURNAL}/g1.json`]
  st['seen:aaaa1111'] = T + 3500
  await clock.advance(2000)
  expect(st['seen:aaaa1111']).toBe(T + 3500)
  // 面板没开：不读各会话的文件，只读打开记录、roster.json，和对上的那个会话的状态文件（看它在不在 claude agents 里）
  expect(w.reads.filter(p => p.includes('/jobs/'))).toEqual([`${DIR}/jobs/aaaa1111/state.json`])
})

test('an open record that cannot be told apart changes nothing: not drawn yet, no match, or two sessions with the same counts', async ($, on) => {
  const w = world()
  // 「🟢 发版」和「线上报错」第一次画出来时消息数一样；「老会话」是新建的，没有消息数；ffff6666 是预先起好、还没用上的
  roster(w, { aaaa1111: 300, cccc3333: 300, dddd4444: 'new', ffff6666: 'new' })
  engine(on, w)
  const st = store(on)
  const clock = mock.clock(on, { now: T })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'fleet', args: '' } as any)
  await clock.settle()
  replied(w, 'aaaa1111', '🟢 发版', T + 1000)
  replied(w, 'dddd4444', '老会话', T + 1500)
  journal(w, 'g1')
  journal(w, 'g2', 300)
  journal(w, 'g3', 7)
  await clock.advance(2000)
  expect(Object.keys(st).filter(k => k.startsWith('seen:'))).toEqual([])
  expect((await rows($)).news).toEqual(['✻ 老会话0s', '✻ 🟢 发版1s'])

  // 第一条记录连上了：那个会话进程不给消息数。不给的只有「老会话」有状态文件，就是它
  journal(w, 'g1', false)
  await clock.advance(2000)
  expect(st['seen:dddd4444']).toBe(T + 4000)
  expect((await rows($)).news).toEqual(['✻ 🟢 发版3s'])

  // 又多了一个新建的会话：再有不给消息数的打开记录，就分不出是哪个
  roster(w, { aaaa1111: 300, cccc3333: 300, dddd4444: 'new', ffff6666: 'new', bbbb2222: 'new' })
  replied(w, 'bbbb2222', '产品需求文档整理', T + 4500)
  w.files[`${DIR}/sessions/100.json`] = JSON.stringify({ pid: 100, kind: 'bg', jobId: 'bbbb2222', sessionId: 'b', status: 'idle' })
  journal(w, 'g4', false)
  await clock.advance(2000)
  expect(st['seen:bbbb2222']).toBe(undefined)
  expect((await rows($)).news).toEqual(['✻ 产品需求文档整理1s', '✻ 🟢 发版5s'])
})

test('when the counts cannot tell, the session claude agents just touched is the one opened (recap.trigger, CC 2.1.319)', async ($, on) => {
  const w = world()
  // 「🟢 发版」和「线上报错」消息数一样；「老会话」是新建的、不给消息数，「产品需求文档整理」跑的是旧版本、也不给
  roster(w, { aaaa1111: 300, bbbb2222: 'old', cccc3333: 300, dddd4444: 'new' })
  w.files[`${DIR}/sessions/100.json`] = JSON.stringify({ pid: 100, kind: 'bg', jobId: 'bbbb2222', sessionId: 'b', status: 'idle' })
  engine(on, w)
  const st = store(on)
  const clock = mock.clock(on, { now: T })
  const job = (id: string) => `${DIR}/jobs/${id}`
  // 状态文件很久没改过
  for (const id of ['aaaa1111', 'bbbb2222', 'cccc3333', 'dddd4444']) {
    w.mtimes[`${job(id)}/state.json`] = T - H
    w.mtimes[job(id)] = T - H
  }
  // 「线上报错」很早以前打开过，那时在忙，recap.trigger 还留着：时间不对，不算
  w.mtimes[`${job('cccc3333')}/recap.trigger`] = T - H
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.settle()

  // 打开「🟢 发版」：消息数对上两个；它的 recap.trigger 刚写下（会话在忙，还没删）
  w.files[`${JOURNAL}/g1.json`] = JSON.stringify({ gestureId: 'g1', surface: 'fleet', startedAtEpochMs: T + 1000, marksExpected: true, msgsLoaded: 300, msgsInJsonl: 300, msgsRenderedAtFirstPaint: 300 })
  w.mtimes[`${job('aaaa1111')}/recap.trigger`] = T + 1020
  await clock.advance(2000)
  expect(st['seen:aaaa1111']).toBe(T + 2000)
  expect(st['seen:cccc3333']).toBe(undefined)

  // 回到列表，再打开「老会话」：不给消息数的有两个；它闲着，recap.trigger 半秒内就删了，job 目录比 state.json 新
  delete w.files[`${JOURNAL}/g1.json`]
  await clock.advance(2000)
  w.files[`${JOURNAL}/g2.json`] = JSON.stringify({ gestureId: 'g2', surface: 'fleet', startedAtEpochMs: T + 5000, marksExpected: false })
  w.mtimes[job('dddd4444')] = T + 5400
  // 「产品需求文档整理」这时只是更新了一下状态：目录只比 state.json 晚一点点，不算
  w.mtimes[`${job('bbbb2222')}/state.json`] = T + 5100
  w.mtimes[job('bbbb2222')] = T + 5100.5
  await clock.advance(2000)
  expect(st['seen:dddd4444']).toBe(T + 6000)
  expect(st['seen:bbbb2222']).toBe(undefined)
})
