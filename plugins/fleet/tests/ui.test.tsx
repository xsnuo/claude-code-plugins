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

test('the news area lists sessions that replied after entering; /clear starts it over', async ($, on) => {
  const w = world()
  engine(on, w)
  const clock = mock.clock(on, { now: T })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'fleet', args: '' } as any)
  await clock.settle()
  // 进入会话时（T）之前的回复不算
  let r = await rows($)
  expect(r.news).toEqual([])
  expect(r.notes).toEqual(['别的会话有新回复时会列在这里'])

  // 在跑的那个做完了：置顶，同时进最新消息区
  w.files[`${DIR}/jobs/bbbb2222/state.json`] = state({ state: 'done', name: '产品需求文档整理', lastTerminalAt: iso(T + 1000) })
  w.files[`${DIR}/sessions/100.json`] = JSON.stringify({ pid: 100, kind: 'bg', jobId: 'bbbb2222', sessionId: 'b', status: 'idle' })
  // 现在这个会话自己的回复不算
  w.files[`${DIR}/jobs/eeee5555/state.json`] = state({ state: 'done', name: '我的插件', resumeSessionId: 'sid-1', lastTerminalAt: iso(T + 1500) })
  await clock.advance(2000)
  r = await rows($)
  expect(r.ids.slice(0, 2)).toEqual(['eeee5555', 'bbbb2222'])
  expect(r.news).toEqual(['✻ 产品需求文档整理1s'])
  expect(r.notes).toEqual([])

  // 又有一个回复了：新的在上面；/clear 之后从头算
  w.files[`${DIR}/jobs/aaaa1111/state.json`] = state({ state: 'done', name: '🟢 发版', lastTerminalAt: iso(clock.now() + 500) })
  await clock.advance(2000)
  expect((await rows($)).news).toEqual(['✻ 🟢 发版1s', '✻ 产品需求文档整理3s'])
  await $.session.end({ sessionId: 'sid-1', reason: 'clear' } as any)
  await clock.settle()
  expect((await rows($)).news).toEqual([])
})

test('a short pane cuts the list and scrolls it; the news area stays', async ($, on) => {
  const w = world()
  engine(on, w)
  const clock = mock.clock(on, { now: T })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'fleet', args: '' } as any)
  await clock.settle()
  // 10 行：说明 1，最新消息区 5，列表 10 - 1 - 5 - 2 = 2 个
  let r = await rows($, 'terminal', 10)
  expect(r.ids).toEqual(['eeee5555', 'cccc3333'])
  expect(r.notes).toEqual(['↓ 下面还有 3 个（滚动列表翻看）', '别的会话有新回复时会列在这里'])
  await scroll($, 1)
  r = await rows($, 'terminal', 10)
  expect(r.ids).toEqual(['cccc3333', 'aaaa1111'])
  expect(r.notes).toEqual(['↑ 上面还有 1 个（滚动列表翻看）', '↓ 下面还有 2 个（滚动列表翻看）', '别的会话有新回复时会列在这里'])
  await scroll($, 99)
  expect((await rows($, 'terminal', 10)).ids).toEqual(['bbbb2222', 'dddd4444'])
  await scroll($, -99)
  expect((await rows($, 'terminal', 10)).ids).toEqual(['eeee5555', 'cccc3333'])
})

test('after a reload from a version without the news area, it counts from the reload, not from the start of time', async ($, on) => {
  const w = world()
  engine(on, w)
  // 旧版本已经进过会话（entered），但还没有 since
  on('state.get', ($: any, e: any, next: any) => (e.key === 'entered' ? { value: { value: true, version: 1 } } : next(e)))
  const clock = mock.clock(on, { now: T })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'fleet', args: '' } as any)
  await clock.settle()
  expect((await rows($)).news).toEqual([])
})

test('the news area keeps only the latest three', async ($, on) => {
  const w = world()
  engine(on, w)
  const clock = mock.clock(on, { now: T })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'fleet', args: '' } as any)
  await clock.settle()
  // 四个会话先后做完：a 最早，b、c、d 依次更晚
  const done = (id: string, name: string, at: number) => {
    w.files[`${DIR}/jobs/${id}/state.json`] = state({ state: 'done', name, lastTerminalAt: iso(at) })
  }
  done('aaaa1111', 'A', T + 100)
  done('bbbb2222', 'B', T + 200)
  done('cccc3333', 'C', T + 300)
  done('dddd4444', 'D', T + 400)
  w.files[`${DIR}/sessions/100.json`] = JSON.stringify({ pid: 100, kind: 'bg', jobId: 'bbbb2222', sessionId: 'b', status: 'idle' })
  w.files[`${DIR}/sessions/101.json`] = JSON.stringify({ pid: 101, kind: 'bg', jobId: 'cccc3333', sessionId: 'c', status: 'idle' })
  await clock.advance(2000)
  const ui = await mountPane($)
  const news = (await ui.findAll({ type: 'Box' })).filter((b: any) => String(b.key).startsWith('news-')).map((b: any) => String(b.key).slice(5))
  await ui.unmount()
  expect(news).toEqual(['dddd4444', 'cccc3333', 'bbbb2222'])
})

test('docked on the right, the news area sits on the bottom edge of the pane; above the prompt it follows the list', async ($, on) => {
  const w = world()
  engine(on, w)
  const clock = mock.clock(on, { now: T })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'fleet', args: '' } as any)
  await clock.settle()
  // 30 行：说明 1、5 个会话、最新消息区 5，空出来的 19 行在列表和最新消息区之间
  let ui = await mountPane($)
  expect((await ui.find({ key: 'gap' }))?.props.height).toBe(19)
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

test('opening any session from claude agents (an attach record appears) empties the news area from that moment', async ($, on) => {
  const w = world()
  // 之前打开过别的会话留下的记录，比进入会话早：不算
  w.files[`${DIR}/daemon/attach-journal/old.json`] = JSON.stringify({ gestureId: 'old', surface: 'fleet', startedAtEpochMs: T - 60_000 })
  engine(on, w)
  const clock = mock.clock(on, { now: T })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'fleet', args: '' } as any)
  await clock.settle()
  w.files[`${DIR}/jobs/aaaa1111/state.json`] = state({ state: 'done', name: '🟢 发版', lastTerminalAt: iso(T + 500) })
  await clock.advance(2000)
  expect((await rows($)).news).toEqual(['✻ 🟢 发版1s'])

  // 从 claude agents 打开了一个会话（不知道是哪个）：从那一刻算起，之前的回复不再算
  w.files[`${DIR}/daemon/attach-journal/g1.json`] = JSON.stringify({ gestureId: 'g1', surface: 'fleet', pid: 1, startedAtEpochMs: T + 3000 })
  await clock.advance(2000)
  expect((await rows($)).news).toEqual([])

  // 之后的回复照样列进来；打开记录被删掉也不会退回去
  w.files[`${DIR}/jobs/dddd4444/state.json`] = state({ state: 'done', name: '老会话', lastTerminalAt: iso(T + 4500) })
  delete w.files[`${DIR}/daemon/attach-journal/g1.json`]
  await clock.advance(2000)
  expect((await rows($)).news).toEqual(['✻ 老会话1s'])
})

// 扮演 index 插件：/idx 打开目录、/idx close 关掉；会话打开时目录开着，就和真的 index 一样先关掉目录、等会话打开后再打开
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
    on('ui.open', { id: 'fleet' }, async ($: any, e: any, next: any) => {
      if (e.focus || !(await $.ui.panes()).some((p: any) => p.id === 'index')) return next(e)
      await $.ui.close({ id: 'index' })
      try {
        return await next(e)
      } finally {
        await $.ui.open({ id: 'index', title: '目录', columns: 50 })
      }
    })
  },
}
const idx = ($: any, args = '') => $.command.run({ command: 'idx', args } as any)
const order = (w: World) => w.panes.map(p => p.id)

test('both open on entering: the sessions tab first and shown, whichever opens first', { plugins: [INDEX] }, async ($, on) => {
  // 先开会话、再开目录：目录显示在前面了，会话再抬到前面
  const w = world()
  engine(on, w)
  mock.store(on, { autoOpen: true })
  const clock = mock.clock(on, { now: T })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.settle()
  await idx($)
  await clock.settle()
  expect(order(w)).toEqual(['fleet', 'index'])
  expect(w.shownId).toBe('fleet')
  expect(w.opened.at(-1)).toEqual({ id: 'fleet', title: '会话', columns: 44, focus: true })
})

test('index already open when the sessions pane opens: index steps aside, the sessions tab comes first and shows', { plugins: [INDEX] }, async ($, on) => {
  const w = world()
  engine(on, w)
  const clock = mock.clock(on, { now: T })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.advance(25_000)
  await idx($)
  expect(order(w)).toEqual(['index'])
  // 你自己执行 /fleet：会话在前、显示会话
  expect((await $.command.run({ command: 'fleet', args: '' } as any)).text).toBe('会话总览已打开')
  await clock.settle()
  expect(order(w)).toEqual(['fleet', 'index'])
  expect(w.shownId).toBe('fleet')
  // 之后你自己关掉、再打开目录：显示目录，不再抢回来
  await idx($, 'close')
  await idx($)
  await clock.settle()
  expect(order(w)).toEqual(['fleet', 'index'])
  expect(w.shownId).toBe('index')
  // 会话藏在目录后面时执行 /fleet：抬到前面，不关
  expect((await $.command.run({ command: 'fleet', args: '' } as any)).text).toBe('会话总览已显示到前面')
  expect(w.shownId).toBe('fleet')
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
