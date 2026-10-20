import { expect, test } from 'claude-code/testing'

// 测试里没有真引擎：engine() 注册的钩子扮演引擎——像真引擎一样把回复正文画成一个 { type: 'engine' } 节点、
// 回答 aload.py 的调用、给出鼠标选中的文字、记下打开和关上的面板。
// keyPoints 为 'link' 时，它还扮演装在里层的 key-points：整条回复下面加一行 key points；
// 为 'marked' 时扮演正在标重点的 key-points：整条回复由它自己画（树里没有引擎节点了）

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
const USAGE = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }

type Log = {
  runs: string[][]
  spawns: unknown[]
  // 每次朗读交给 aload.py 的厂家（没说就是 undefined）
  providers: unknown[]
  opened: string[]
  closed?: string[]
  status?: object
  setkey?: object
  spawnOut?: string
  selection?: { text: string; requestId?: string }
  checks: { prompt: string; effort?: string; model: string }[]
  checkAnswer?: object
  // 按模型给不同的回答；'throw' 表示这个模型用不了（比如账号没有权限）
  checkBy?: Record<string, object | 'throw'>
  toasts: string[]
}

type Found = { key: string | undefined; text: string; props: Record<string, unknown> }

function newLog(status?: object): Log {
  return { runs: [], spawns: [], providers: [], opened: [], status, checks: [], toasts: [] }
}

const KEY_POINTS = 'https://key-points.invalid/toggle'

const ENGINE = { type: 'engine', ref: 0 }

function engine(on: any, log: Log, keyPoints: 'none' | 'link' | 'marked' = 'none') {
  on('ui.render', { component: 'AssistantMessage' }, ($: any, e: any) => {
    const { Box, Text, Markdown } = $.ui.resolve(e)
    if (keyPoints === 'none' || e.props.text !== REPLY) return ENGINE
    return (
      <Box flexDirection="column">
        {keyPoints === 'marked' ? <Text color="warning">{REPLY}</Text> : ENGINE}
        <Box paddingLeft={2}>
          <Markdown key="key-points-link" text={`[📌 key points](${KEY_POINTS})`} onLinkPress={() => undefined} />
        </Box>
      </Box>
    )
  })
  on('process.run', async ($: any, e: any) => {
    // 插件先试出 Python 在哪：第一个就答应
    if (e.argv[1] === '-c') return { value: { exitCode: 0, stdout: '3\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    log.runs.push([...e.argv.slice(2)])
    const sub = e.argv[2]
    const base = log.status ?? STATUS
    const status =
      sub === 'use' ? { ...base, provider: e.argv[3] } : sub === 'icon' ? { ...base, icon: e.argv[3] } : sub === 'setkey' && log.setkey ? log.setkey : base
    return { value: { exitCode: 0, stdout: JSON.stringify(status) + '\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('process.spawn', async function* ($: any, e: any) {
    log.spawns.push(JSON.parse(e.input).segments)
    log.providers.push(JSON.parse(e.input).provider)
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
  on('ui.toast', ($: any, e: any) => {
    log.toasts.push(e.text ?? String(e))
    return { value: undefined }
  })
  // 朗读前的敏感信息检查：默认答“没有”
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('model.complete', ($: any, e: any) => {
    log.checks.push({ prompt: e.prompt, effort: e.effort, model: e.model })
    const by = log.checkBy?.[e.model]
    if (by === 'throw') throw new Error(`model ${e.model} is not available`)
    return { value: by ?? log.checkAnswer ?? { isAnswered: true, text: '[]', usage: USAGE } }
  })
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
    expect(JSON.stringify(await ui.drawn())).toContain('"type":"engine"') // 正文原样，还是引擎画的
    expect(await ui.findAll({ type: 'Text' })).toHaveLength(0)
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

test('with key-points beneath: its link keeps its own line and read aload goes on the next one', async ($, on) => {
  engine(on, newLog(), 'link')
  await finish($, REPLY)
  const ui = await mountReply($, 'msg-kp')
  const drawn: any = await ui.drawn()
  const last = drawn.children.at(-1)
  expect(last.children.map((c: any) => c.props.key)).toEqual(['aload-read']) // 最后一行只有 read aload
  expect(JSON.stringify(drawn.children[0])).toContain('key-points-link') // key points 在里层画的那一块里，原样留着
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

test('in paragraph mode what plugins beneath add under the reply shows once, after the last chunk', async ($, on) => {
  engine(on, newLog(WITH_KEY), 'link')
  await $.command.run({ command: 'aload', args: 'icon paragraph' } as any)
  await finish($, REPLY)
  const ui = await mountReply($, 'msg-kp2')
  expect(await ui.findAll({ key: 'key-points-link' })).toHaveLength(1)
  const drawn: any = await ui.drawn()
  expect(JSON.stringify(drawn.children.at(-1))).toContain('key-points-link') // 接在最后一段后面
  expect(await ui.find({ key: 'aload-read' })).toBeUndefined()
  expect(await ui.findAll({ type: 'Button' })).toHaveLength(4) // 每段的 🔊 照旧
  await ui.unmount()
})

test('in paragraph mode a plugin beneath that redraws the whole reply wins', async ($, on) => {
  engine(on, newLog(WITH_KEY), 'marked')
  await $.command.run({ command: 'aload', args: 'icon paragraph' } as any)
  await finish($, REPLY)
  const ui = await mountReply($, 'msg-kp3')
  expect(await ui.findAll({ type: 'Button' })).toHaveLength(0)
  expect((await ui.findAll({ type: 'Text' })).map((t: Found) => t.text)).toEqual([REPLY]) // 正文只出现一次
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

// ---------- 朗读前屏蔽敏感信息 ----------

const SECRET = ['把这个 Key 填进去：ak-live-7f3a9c，账号 UID 是 10086。', '', '然后重启。'].join('\n')

test('before anything leaves for the TTS service, a fast Claude model (medium effort) points out what to mask', async ($, on) => {
  const log = newLog(WITH_KEY)
  log.checkAnswer = {
    isAnswered: true,
    text: '[{"text":"ak-live-7f3a9c","label":"密钥"},{"text":"10086","label":"UID"}]',
    usage: USAGE,
  }
  engine(on, log)
  await finish($, SECRET)
  const ui = await mountReply($, 'msg-s1', SECRET)
  await ui.press({ key: 'aload-read', link: { href: READ } } as any)
  expect(log.spawns).toEqual([['把这个 Key 填进去：【密钥】，账号 UID 是 【UID】。', '然后重启。']])
  expect(log.checks).toHaveLength(1)
  expect(log.checks[0]!.effort).toBe('medium')
  expect(log.checks[0]!.model).toBe('haiku') // 只写模型名，不写版本号
  expect(log.checks[0]!.prompt).toContain('ak-live-7f3a9c')
  await ui.press({ key: 'aload-read', link: { href: READ } } as any) // 同一段再念：用记下的结果，不再问
  expect(log.checks).toHaveLength(1)
  expect(log.spawns[1]).toEqual(log.spawns[0])
  await ui.unmount()
})

test('a model the account cannot use is skipped, and later checks start from the one that worked', async ($, on) => {
  const log = newLog(WITH_KEY)
  const spans = { isAnswered: true, text: '[{"text":"ak-live-7f3a9c","label":"密钥"}]', usage: USAGE }
  log.checkBy = {
    haiku: 'throw',
    sonnet: { isAnswered: false, reason: 'api-error', status: 404, error: 'invalid_request', usage: USAGE },
    opus: spans,
  }
  engine(on, log)
  await finish($, SECRET)
  const ui = await mountReply($, 'msg-s3', SECRET)
  await ui.press({ key: 'aload-read', link: { href: READ } } as any)
  expect(log.checks.map(c => c.model)).toEqual(['haiku', 'sonnet', 'opus'])
  expect((log.spawns[0] as string[])[0]).toContain('【密钥】')
  await ui.unmount()
  const other = '另一条：ak-live-7f3a9c 还是那个 Key。'
  await finish($, other)
  const next = await mountReply($, 'msg-s4', other)
  await next.press({ key: 'aload-read', link: { href: READ } } as any)
  expect(log.checks.map(c => c.model)).toEqual(['haiku', 'sonnet', 'opus', 'opus']) // 直接从能用的那个开始
  await next.unmount()
})

test('when every model fails, local rules still mask common keys, and a toast says so', async ($, on) => {
  const log = newLog(WITH_KEY)
  log.checkAnswer = { isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded', usage: USAGE }
  engine(on, log)
  const text = '用 sk-ant-api03-abcdefghijklmnop1234 调接口，password: hunter22 别外传。'
  await finish($, text)
  const ui = await mountReply($, 'msg-s2', text)
  await ui.press({ key: 'aload-read', link: { href: READ } } as any)
  expect(log.spawns).toEqual([['用 【密钥】 调接口，password: 【密码】 别外传。']])
  expect(log.toasts.some(t => t.includes('只按本地规则屏蔽'))).toBe(true)
  expect(log.checks.map(c => c.model)).toEqual(['haiku', 'sonnet', 'opus', 'claude-opus-5-5']) // 最后才用当前会话的模型
  await ui.unmount()
})

// ---------- 本机朗读 ----------

// 一台 Mac：aload.py 说本机朗读叫 macos，而且正在用它
const ON_MAC = {
  ...WITH_KEY,
  provider: 'macos',
  local: 'macos',
  voices: { ...WITH_KEY.voices, macos: '' },
  keys: { ...WITH_KEY.keys, macos: { set: true } },
}

test('reading with macOS system speech skips the sensitive-data check and says which provider to use', async ($, on) => {
  const log = newLog(ON_MAC)
  engine(on, log)
  await finish($, SECRET)
  const ui = await mountReply($, 'msg-mac', SECRET)
  await ui.press({ key: 'aload-read', link: { href: READ } } as any)
  expect(log.checks).toEqual([]) // 不问 Claude
  expect(log.spawns).toEqual([['把这个 Key 填进去：ak-live-7f3a9c，账号 UID 是 10086。', '然后重启。']]) // 原样，不出这台电脑
  expect(log.providers).toEqual(['macos'])
  await ui.unmount()
})

test('/aload lists macOS system speech only on a Mac; it needs no key', async ($, on) => {
  const log = newLog(ON_MAC)
  engine(on, log)
  const help = await $.command.run({ command: 'aload', args: '' } as any)
  expect(help.text).toContain('▶ macOS 系统朗读：不要 Key，不联网，音色 系统默认的声音')
  expect(help.text).toContain('/aload azure|doubao|macos')
  const use = await $.command.run({ command: 'aload', args: 'macos' } as any)
  expect(use.text).toBe('已切换到macOS 系统朗读（不要 Key、不联网，音色 系统默认的声音）。')
  expect(log.opened).toEqual([]) // 不弹 Key 输入框
  expect((await $.command.run({ command: 'aload', args: 'key macos' } as any)).text).toBe('macOS 系统朗读不需要 Key。')
  const voice = await $.command.run({ command: 'aload', args: 'voice Eddy (中文（中国大陆）)' } as any)
  expect(log.runs.at(-1)).toEqual(['voice', 'Eddy (中文（中国大陆）)']) // 名字里有空格也整个传过去
  expect(voice.text).toContain('音色已设为')
})

test('elsewhere (no local speech reported) /aload does not list it', async ($, on) => {
  engine(on, newLog(WITH_KEY))
  const help = await $.command.run({ command: 'aload', args: '' } as any)
  expect(help.text).not.toContain('系统朗读')
  expect(help.text).toContain('/aload azure|doubao ')
})

// ---------- 找 Python ----------

test('on Windows it finds Python through the py launcher and talks UTF-8 with it', async ($, on) => {
  const argvs: string[][] = []
  const envs: object[] = []
  on('process.run', async ($: any, e: any) => {
    argvs.push([...e.argv])
    envs.push(e.init?.env)
    if (e.argv[0] === '/usr/bin/python3') throw new Error('ENOENT')
    if (e.argv[0] === 'python3') return { value: { exitCode: 9009, stdout: '', stderr: 'Python was not found; run without arguments to install from the Microsoft Store', isStdoutTruncated: false, isStderrTruncated: false } }
    const out = e.argv.includes('-c') ? '3\n' : JSON.stringify(STATUS) + '\n'
    return { value: { exitCode: 0, stdout: out, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  const first = await $.command.run({ command: 'aload', args: '' } as any)
  expect(first.text).toContain('当前厂家：Azure 语音')
  await $.command.run({ command: 'aload', args: '' } as any) // 第二次直接用记住的
  const used = argvs.filter(a => !a.includes('-c'))
  expect(used.map(a => a.slice(0, 2))).toEqual([['py', '-3'], ['py', '-3']])
  expect(used[0]![2]).toMatch(/bin\/aload\.py$/)
  expect(argvs.filter(a => a.includes('-c')).map(a => a[0])).toEqual(['/usr/bin/python3', 'python3', 'py'])
  expect(envs.every(env => (env as any)?.PYTHONUTF8 === '1')).toBe(true)
})

test('without any Python 3 it says how to get one', async ($, on) => {
  on('process.run', async () => {
    throw new Error('ENOENT')
  })
  const res = await $.command.run({ command: 'aload', args: '' } as any)
  expect(res.text).toContain('找不到 Python 3')
})
