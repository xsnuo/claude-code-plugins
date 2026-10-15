import { expect, test } from 'claude-code/testing'

// 测试里没有真引擎：engine() 注册的钩子扮演引擎——把一块回复画成一行文字、回答 aload.py 的调用、
// 给出鼠标选中的文字、记下打开和关上的面板

const STATUS = {
  ok: true,
  provider: 'azure',
  icon: 'reply',
  voices: { azure: 'zh-CN-XiaoxiaoNeural', doubao: 'zh_female_zhixingnv_uranus_bigtts' },
  keys: { azure: { set: false }, doubao: { set: true, masked: '…abcd' } },
}
const WITH_KEY = { ...STATUS, keys: { ...STATUS.keys, azure: { set: true, masked: '…wxyz' } } }

const REPLY = ['第一段。', '', '- 条目一', '- 条目二', '', '```', 'code', '```', '', '最后一段。'].join('\n')
const READ = 'https://aload.invalid/read'

type Log = {
  runs: string[][]
  spawns: unknown[]
  opened: string[]
  closed?: string[]
  status?: object
  setkey?: object
  spawnOut?: string
  selection?: { text: string; requestId?: string }
}

type Found = { key: string | undefined; text: string; props: Record<string, unknown> }

function newLog(status?: object): Log {
  return { runs: [], spawns: [], opened: [], status }
}

function engine(on: any, log: Log) {
  on('ui.render', { component: 'AssistantMessage' }, ($: any, e: any) => {
    const { Text } = $.ui.resolve(e)
    return <Text>{`[engine${e.props.isFirstOfReply ? ' first' : ''}] ${e.props.text}`}</Text>
  })
  on('process.run', async ($: any, e: any) => {
    log.runs.push([...e.argv.slice(2)])
    const sub = e.argv[2]
    const base = log.status ?? STATUS
    const status =
      sub === 'use' ? { ...base, provider: e.argv[3] } : sub === 'icon' ? { ...base, icon: e.argv[3] } : sub === 'setkey' && log.setkey ? log.setkey : base
    return { value: { exitCode: 0, stdout: JSON.stringify(status) + '\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('process.spawn', async function* ($: any, e: any) {
    log.spawns.push(JSON.parse(e.input).segments)
    yield { stream: 'stdout', text: log.spawnOut ?? 'HB\nPLAYING\nSEGMENT 0\nDONE\n' }
    return { value: { code: 0, signal: null } }
  })
  on('ui.selection', () => ({ value: log.selection }))
  on('ui.open', async ($: any, e: any) => {
    log.opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.close', ($: any, e: any) => {
    ;(log.closed ??= []).push(e.id)
    return { value: undefined }
  })
  on('ui.toast', () => ({ value: undefined }))
  on('turn.complete', () => ({ text: '' })) // 生命周期事件直接答结果，不像 $ 调用那样包在 value 里
}

// 一轮结束，这条回复成了最终回复
async function finish($: any, answer: string) {
  await $.turn.complete({ answer, reason: 'answer', durationMs: 1, isAborted: false, turnId: `t-${answer.length}` })
}

function mountReply($: any, requestId: string, text = REPLY, surface: 'terminal' | 'desktop' = 'terminal') {
  return $.ui.mount({ plugin: 'aload', surface, component: 'AssistantMessage', requestId, props: { text, isFirstOfReply: true } })
}

// ---------- 默认：每条最终回复末尾一个 read aload ----------

for (const surface of ['terminal', 'desktop'] as const) {
  test(`a final reply ends with 🔊 read aload and its text is left as drawn (${surface})`, async ($, on) => {
    engine(on, newLog())
    const before = await mountReply($, 'msg-1', REPLY, surface)
    expect(await before.find({ key: 'aload-read' })).toBeUndefined() // 还不是最终回复（过程中的说明文字）
    await before.unmount()
    await finish($, REPLY)
    const ui = await mountReply($, 'msg-1', REPLY, surface)
    expect((await ui.findAll({ type: 'Text' })).map((t: Found) => t.text)).toEqual([`[engine first] ${REPLY}`]) // 正文原样，圆点还在
    expect((await ui.find({ key: 'aload-read' }))?.props.text).toBe(`[🔊 read aload](${READ})`)
    expect(await ui.findAll({ type: 'Button' })).toHaveLength(0) // 段落旁边没有图标
    await ui.unmount()
  })
}

test('read aload reads the whole reply in one go, skipping code', async ($, on) => {
  const log = newLog(WITH_KEY)
  engine(on, log)
  await finish($, REPLY)
  const ui = await mountReply($, 'msg-2')
  await ui.press({ key: 'aload-read', link: { href: READ } } as any)
  expect(log.spawns).toEqual([['第一段。', '条目一', '条目二', '最后一段。']])
  await ui.unmount()
})

test('with text selected, it reads from the selection to the end', async ($, on) => {
  const log = newLog(WITH_KEY)
  log.selection = { text: '条目二', requestId: 'msg-3' }
  engine(on, log)
  await finish($, REPLY)
  const ui = await mountReply($, 'msg-3')
  await ui.press({ key: 'aload-read', link: { href: READ } } as any)
  expect(log.spawns).toEqual([['条目二', '最后一段。']])
  log.selection = { text: '第一段。\n\n- 条目一', requestId: undefined } // 跨了几行：靠文字找位置
  await ui.press({ key: 'aload-read', link: { href: READ } } as any)
  expect(log.spawns[1]).toEqual(['第一段。', '条目一', '条目二', '最后一段。'])
  log.selection = { text: '别的消息里的字', requestId: 'other' } // 选的不是这条回复：从头念
  await ui.press({ key: 'aload-read', link: { href: READ } } as any)
  expect(log.spawns[2]).toEqual(['第一段。', '条目一', '条目二', '最后一段。'])
  await ui.unmount()
})

test('a final reply split into blocks gets the button on its last block and reads all of it', async ($, on) => {
  const log = newLog(WITH_KEY)
  engine(on, log)
  await finish($, `前面一块。\n\n${REPLY}`)
  const head = await mountReply($, 'msg-4a', '前面一块。')
  expect(await head.find({ key: 'aload-read' })).toBeUndefined()
  const tail = await mountReply($, 'msg-4b', REPLY)
  await tail.press({ key: 'aload-read', link: { href: READ } } as any)
  expect(log.spawns).toEqual([['前面一块。', '第一段。', '条目一', '条目二', '最后一段。']])
  await head.unmount()
  await tail.unmount()
})

test('without a key, read aload opens the key pane instead of reading', async ($, on) => {
  const log = newLog()
  engine(on, log)
  await finish($, REPLY)
  const ui = await mountReply($, 'msg-5')
  await ui.press({ key: 'aload-read', link: { href: READ } } as any)
  expect(log.spawns).toEqual([])
  expect(log.opened).toEqual(['aload-key'])
  const pane = await $.ui.mount({ plugin: 'aload', surface: 'terminal', component: 'Pane', requestId: 'aload-key', props: {} as any })
  expect((await pane.find({ type: 'Text', text: /还没有Azure 语音的 Key/ }))?.text).toBeDefined()
  expect((await pane.find({ key: 'aload-extra' }))?.props.value).toBe('eastasia')
  await pane.unmount()
  await ui.unmount()
})

test('a key rejected while reading reopens the pane', async ($, on) => {
  const log = newLog(WITH_KEY)
  log.spawnOut = 'HB\nERROR auth azure Azure 拒绝了这个 Key（HTTP 401）\n'
  engine(on, log)
  await finish($, REPLY)
  const ui = await mountReply($, 'msg-6')
  await ui.press({ key: 'aload-read', link: { href: READ } } as any)
  expect(log.spawns).toHaveLength(1)
  expect(log.opened).toEqual(['aload-key'])
  await ui.unmount()
})

test('a summary block is left to the engine', async ($, on) => {
  engine(on, newLog())
  await finish($, '查了几个文件')
  const ui = await $.ui.mount({
    plugin: 'aload',
    surface: 'terminal',
    component: 'AssistantMessage',
    props: { text: '查了几个文件', isFirstOfReply: true, isSummary: true },
  })
  expect(await ui.find({ key: 'aload-read' })).toBeUndefined()
  await ui.unmount()
})

// ---------- 可选：每段一个 🔊 ----------

test('/aload icon paragraph puts a 🔊 on every chunk; one reads from there to the end', async ($, on) => {
  const log = newLog(WITH_KEY)
  engine(on, log)
  const set = await $.command.run({ command: 'aload', args: 'icon paragraph' } as any)
  expect(set.text).toContain('每段一个（常显）')
  const ui = await mountReply($, 'msg-7')
  const buttons = await ui.findAll({ type: 'Button' })
  expect(buttons.map((b: Found) => b.key)).toEqual(['aload-0', 'aload-1', 'aload-2', 'aload-4']) // 代码块没有
  expect((await ui.findAll({ type: 'Markdown' })).map((m: Found) => m.props.text)).toEqual(['- 条目一', '- 条目二', '```\ncode\n```', '最后一段。'])
  await ui.press({ key: 'aload-1' })
  expect(log.spawns).toEqual([['条目一', '条目二', '最后一段。']])
  await ui.unmount()
})

// ---------- Key 面板、命令 ----------

test('a valid Doubao key without the service enabled is saved and the pane says why', async ($, on) => {
  const log = newLog()
  log.setkey = {
    ...STATUS,
    provider: 'doubao',
    keys: { ...STATUS.keys, doubao: { set: true, masked: '…9f3a' } },
    saved: 'doubao',
    warning: '这个 Key 有效，但还没有豆包语音合成的使用权限：请在火山引擎控制台开通「豆包语音合成模型 2.0」',
  }
  engine(on, log)
  await $.command.run({ command: 'aload', args: 'key doubao' } as any)
  const pane = await $.ui.mount({ plugin: 'aload', surface: 'terminal', component: 'Pane', requestId: 'aload-key', props: {} as any })
  await pane.input({ key: 'aload-key', text: 'real-key-9f3a', kind: 'change' } as any)
  await pane.press({ key: 'aload-save' })
  expect(log.runs.find(r => r[0] === 'setkey')).toBeDefined()
  expect(log.closed ?? []).toEqual([]) // 面板留着
  expect((await pane.find({ type: 'Text', text: /Key 有效，已保存（…9f3a）/ }))?.text).toContain('开通「豆包语音合成模型 2.0」')
  expect(log.spawns).toEqual([]) // 不去念
  await pane.unmount()
})

test('/aload doubao switches; /aload azure without a key opens the pane', async ($, on) => {
  const log = newLog()
  engine(on, log)
  const doubao = await $.command.run({ command: 'aload', args: 'doubao' } as any)
  expect(doubao.text).toContain('已切换到豆包语音 2.0（Key …abcd')
  const azure = await $.command.run({ command: 'aload', args: 'azure' } as any)
  expect(azure.text).toContain('还没有 Key')
  expect(log.opened).toEqual(['aload-key'])
  const help = await $.command.run({ command: 'aload', args: '' } as any)
  expect(help.text).toContain('按钮：每条回复末尾一个')
  expect(help.text).toContain('▶ Azure 语音：未设置 Key')
})
