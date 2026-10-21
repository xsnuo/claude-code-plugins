import { expect, test } from 'claude-code/testing'

// 测试里没有真引擎：engine() 注册的钩子扮演引擎——像真引擎一样把回复正文画成一个 { type: 'engine' } 节点、回答后台提问（$.model.fork）。
// layout 为 'aload' 时，它还扮演装在里层的 aload：回复下面一行 read aload；
// 为 'pieces' 时扮演 aload 的每段模式：第一段交给引擎，后面的段自己用 Markdown 画。

const LONG = '这一段是补充说明，故意写得长一些，让全文的篇幅大一点，免得两处重点加起来超过四分之一。'
const REPLY = ['结论：**可以做**，但要先改 aload。', '', '- 关注句用黄色字体', '- 关注词用荧光黄背景', '', '```', 'npm test', '```', '', LONG, '', '改完再发版。'].join('\n')
const USAGE = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
const ITEMS = [
  { type: 'sentence', text: '可以做，但要先改 aload。' },
  { type: 'word', text: '荧光黄' },
]

type Log = { prompts: string[]; answer?: object; completes: string[]; nothing?: boolean; store: Record<string, unknown>; history?: object[] }
type Found = { key: string | undefined; text: string; props: Record<string, unknown>; children: unknown[] }

function newLog(answer: object = { isAnswered: true, text: JSON.stringify(ITEMS), usage: USAGE }): Log {
  return { prompts: [], completes: [], answer, store: {} }
}

const ENGINE = { type: 'engine', ref: 0 }

function engine(on: any, log: Log, layout: 'plain' | 'aload' | 'pieces' = 'plain') {
  on('ui.render', { component: 'AssistantMessage' }, ($: any, e: any) => {
    const { Box, Button, Markdown } = $.ui.resolve(e)
    if (layout === 'aload') {
      return (
        <Box flexDirection="column">
          {ENGINE}
          <Box paddingLeft={2}>
            <Button key="aload-read" label="🔊 read aload" plain onPress={() => undefined} />
          </Box>
        </Box>
      )
    }
    if (layout === 'pieces') {
      const [, ...rest] = e.props.text.split('\n\n')
      return (
        <Box flexDirection="column">
          <Box>{ENGINE}</Box>
          {rest.map((md: string) => (
            <Box paddingLeft={2}>
              <Markdown text={md} />
            </Box>
          ))}
        </Box>
      )
    }
    return ENGINE
  })
  on('model.fork', ($: any, e: any) => {
    log.prompts.push(e.prompt)
    return { value: log.nothing ? { isAnswered: false, reason: 'nothing-to-fork' } : log.answer }
  })
  on('model.complete', ($: any, e: any) => {
    log.completes.push(`${e.model} ${e.effort}`)
    return { value: log.answer }
  })
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.messages', () => ({ value: log.history ?? [] }))
  on('command.register', () => ({ value: undefined }))
  on('store.get', ($: any, e: any) => ({ value: log.store[e.key] }))
  on('store.set', ($: any, e: any) => {
    log.store[e.key] = JSON.parse(JSON.stringify(e.value))
    return { value: undefined }
  })
  // 生命周期事件直接答结果，不像 $ 调用那样包在 value 里
  on('turn.complete', () => ({ text: '' }))
  on('session.start', ($: any, e: any) => ({ cwd: e.cwd }))
}

// 树里还有没有引擎画的正文
async function hasEngine(ui: any): Promise<boolean> {
  return JSON.stringify(await ui.drawn()).includes('"type":"engine"')
}

async function finish($: any, answer: string) {
  await $.turn.complete({ answer, reason: 'answer', durationMs: 1, isAborted: false, turnId: `t-${answer.length}` })
}

function mountReply($: any, requestId: string, text = REPLY, surface: 'terminal' | 'desktop' = 'terminal', isFirstOfReply = true) {
  return $.ui.mount({ plugin: 'key-points', surface, component: 'AssistantMessage', requestId, props: { text, isFirstOfReply } })
}

function press(ui: any) {
  return ui.press({ key: 'key-points-link' })
}

// 带着标注样式的那些小段：[文字, 样式]（只看粗细和标注用的三样；桌面端会把 weight 再写一份成 bold）。
// 只有行内代码颜色（permission）的不算标注
async function marked(ui: any): Promise<[string, Record<string, unknown>][]> {
  const texts: Found[] = await ui.findAll({ type: 'Text' })
  const keys = ['weight', 'color', 'backgroundColor', 'underline']
  return texts
    .filter(t => t.props.color !== 'blueBright') // 按钮上的字（画成链接的样子）不算
    .filter(t => (t.props.color && t.props.color !== 'permission') || t.props.backgroundColor || t.props.underline)
    .map(t => [t.text, Object.fromEntries(keys.filter(k => k in t.props).map(k => [k, t.props[k]]))])
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`a final reply ends with 📌 key points; pressing it marks the reply, pressing again clears it (${surface})`, async ($, on) => {
    const log = newLog()
    engine(on, log)
    const before = await mountReply($, 'msg-1', REPLY, surface)
    expect(await before.find({ key: 'key-points-link' })).toBeUndefined() // 还不是最终回复
    await before.unmount()

    await finish($, REPLY)
    const ui = await mountReply($, 'msg-1', REPLY, surface)
    expect((await ui.find({ key: 'key-points-link' }))?.props.label).toBe('📌 key points')
    expect(await hasEngine(ui)).toBe(true) // 正文原样，还是引擎画的
    expect((await ui.find({ key: 'key-points-link' }))?.type).toBe('Button') // 画成链接的样子，但没有网址可打开
    expect(JSON.stringify(await ui.drawn())).not.toContain('https://')

    await press(ui)
    expect(log.prompts).toHaveLength(1)
    expect(log.prompts[0]).toContain(`<reply>\n${REPLY}\n</reply>`)
    expect(await hasEngine(ui)).toBe(false) // 这一块改由插件画
    expect(await marked(ui)).toEqual([
      ['可以做', { weight: 'bold', color: 'warning' }], // 原文的粗体还在
      ['，但要先改 aload。', { color: 'warning' }],
      ['荧光黄', { color: '#000000', backgroundColor: '#FFFF00' }],
    ])
    expect((await ui.findAll({ type: 'Markdown' })).map((m: Found) => m.props.text)).toEqual([
      '- 关注句用黄色字体', // 没有重点的段落照旧交给 Markdown
      '```\nnpm test\n```',
      LONG,
      '改完再发版。',
    ])
    expect((await ui.find({ key: 'key-points-link' }))?.props.label).toBe('📌 hide key points')

    await press(ui) // 取消
    expect(await marked(ui)).toEqual([])
    expect(await hasEngine(ui)).toBe(true)
    expect((await ui.find({ key: 'key-points-link' }))?.props.label).toBe('📌 key points')

    await press(ui) // 再显示：用留着的结果，不再问
    expect(await marked(ui)).toHaveLength(3)
    expect(log.prompts).toHaveLength(1)
    await ui.unmount()
  })
}

test('the ⏺ that opens a reply is drawn when the plugin draws the block', async ($, on) => {
  engine(on, newLog())
  await finish($, REPLY)
  const ui = await mountReply($, 'msg-2')
  await press(ui)
  expect(await ui.find({ type: 'Text', text: '⏺ ' })).toBeDefined()
  await ui.unmount()
  const later = await mountReply($, 'msg-2', REPLY, 'terminal', false)
  expect(await later.find({ type: 'Text', text: '⏺ ' })).toBeUndefined()
  await later.unmount()
})

test('a marked line keeps its links, inline code, list bullets and headings', async ($, on) => {
  const reply = [
    '## 怎么装',
    '先装好插件，详见 [安装说明](https://example.com/install) 和 `claude plugin test`，然后重启终端。',
    '',
    '- 第一步：添加插件市场，这一步只做一次',
    '  - 子条目：用 `/plugin` 也可以',
    '',
    '> 引用：这里的话不重要，只是凑篇幅，让重点的比例低一些，免得被跳过。再多写几句话，让全文更长一点，这样三处重点都能放得下。',
  ].join('\n')
  const log = newLog({
    isAnswered: true,
    text: JSON.stringify([
      { type: 'sentence', text: '详见安装说明和 claude plugin test' },
      { type: 'word', text: '只做一次' },
      { type: 'word', text: '怎么装' },
    ]),
    usage: USAGE,
  })
  engine(on, log)
  await finish($, reply)
  const ui = await mountReply($, 'msg-links', reply)
  await press(ui)
  const texts = (await marked(ui)).map(([text]) => text)
  expect(texts).toHaveLength(6)
  expect(texts[2]).toMatch(/安装说明$/) // 链接还是链接，标注套在外面
  expect(texts.filter(t => !t.includes('安装说明'))).toEqual(['怎么装', '详见 ', ' 和 ', 'claude plugin test', '只做一次'])
  expect((await ui.find({ type: 'Link' }))?.props.href).toBe('https://example.com/install')
  expect((await ui.find({ type: 'Text', text: /^claude plugin test$/ }))?.props.color).toBe('warning') // 行内代码也标上
  expect((await ui.findAll({ type: 'Text', text: /^(- |  - )$/ })).map((t: Found) => t.text)).toEqual(['- ', '  - '])
  expect((await ui.findAll({ type: 'Markdown' })).map((m: Found) => m.props.text)[0]).toMatch(/^> 引用/) // 没有重点的引用交给 Markdown
  await ui.unmount()
})

test('marks never cover more than 25% of the reply', async ($, on) => {
  const reply = '第一句话说的是背景情况。第二句话给出了结论。第三句话是需要你来决定的事情。第四句话是补充说明而已。'
  const log = newLog({
    isAnswered: true,
    text: JSON.stringify([
      { type: 'sentence', text: '第二句话给出了结论。' },
      { type: 'sentence', text: '第三句话是需要你来决定的事情。' },
      { type: 'word', text: '背景' },
    ]),
    usage: USAGE,
  })
  engine(on, log)
  await finish($, reply)
  const ui = await mountReply($, 'msg-3', reply)
  await press(ui)
  // 一共 49 个字，25% 约 12 个字：第二句（10 字）放得下，第三句（15 字）放不下，再放一个词（2 字）
  expect((await marked(ui)).map(([text]) => text)).toEqual(['背景', '第二句话给出了结论。'])
  await ui.unmount()
})

test('a failed request says so on the link; pressing it again retries', async ($, on) => {
  const log = newLog({ isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded', usage: USAGE })
  engine(on, log)
  await finish($, REPLY)
  const ui = await mountReply($, 'msg-4')
  await press(ui)
  expect((await ui.find({ key: 'key-points-link' }))?.props.label).toBe('⚠️ key points: API 529, retry')
  expect(await marked(ui)).toEqual([])
  log.answer = { isAnswered: true, text: '我看不出重点', usage: USAGE }
  await press(ui)
  expect((await ui.find({ key: 'key-points-link' }))?.props.label).toBe('⚠️ key points: unreadable answer, retry')
  log.answer = { isAnswered: true, text: '[]', usage: USAGE }
  await press(ui)
  expect((await ui.find({ key: 'key-points-link' }))?.props.label).toBe('📌 key points: none found')
  expect(log.prompts).toHaveLength(3)
  await ui.unmount()
})

test('with nothing to fork yet (a resumed session), it asks with the reply alone', async ($, on) => {
  const log = newLog()
  log.nothing = true
  engine(on, log)
  await finish($, REPLY)
  const ui = await mountReply($, 'msg-5')
  await press(ui)
  expect(log.completes).toEqual(['claude-opus-5-5 medium']) // 单独提问固定用 medium 档位
  expect(await marked(ui)).toHaveLength(3)
  await ui.unmount()
})

test('a final reply split into blocks: every block is marked, the link sits under the last one', async ($, on) => {
  engine(on, newLog())
  const head = '前面一块：关注词是荧光黄。'
  await finish($, `${head}\n\n${REPLY}`)
  const tail = await mountReply($, 'msg-6b', REPLY, 'terminal', false)
  await press(tail)
  const top = await mountReply($, 'msg-6a', head)
  expect(await top.find({ key: 'key-points-link' })).toBeUndefined()
  expect(await marked(top)).toEqual([['荧光黄', { color: '#000000', backgroundColor: '#FFFF00' }]])
  await top.unmount()
  await tail.unmount()
})

// 回复下面各行里的链接，从上到下
async function linkRows(ui: any): Promise<string[]> {
  const keys: string[] = []
  const walk = (node: any) => {
    if (!node || typeof node !== 'object') return
    if (node.type === 'Button' && node.props?.key) keys.push(node.props.key)
    for (const child of node.children ?? []) walk(child)
  }
  walk(await ui.drawn())
  return keys
}

test('with aload beneath: read aload keeps its own line, key points gets the next one; marking keeps both', async ($, on) => {
  engine(on, newLog(), 'aload')
  await finish($, REPLY)
  const ui = await mountReply($, 'msg-7')
  expect(await linkRows(ui)).toEqual(['aload-read', 'key-points-link'])
  const drawn: any = await ui.drawn()
  expect(drawn.children.at(-1).children.map((c: any) => c.props.key)).toEqual(['key-points-link']) // 最后一行只有 key points
  await press(ui)
  expect(await marked(ui)).toHaveLength(3)
  expect(await hasEngine(ui)).toBe(false) // 只换掉了引擎画的正文
  expect(await linkRows(ui)).toEqual(['aload-read', 'key-points-link'])
  await ui.unmount()
})

test('when another plugin draws the reply in pieces, a marked reply is drawn here once, not twice', async ($, on) => {
  engine(on, newLog(), 'pieces')
  await finish($, REPLY)
  const ui = await mountReply($, 'msg-8b')
  await press(ui)
  expect(await hasEngine(ui)).toBe(false)
  const texts: unknown[] = (await ui.findAll({ type: 'Markdown' })).map((m: Found) => m.props.text)
  expect(texts.filter(t => t === '改完再发版。')).toHaveLength(1)
  expect(await marked(ui)).toHaveLength(3)
  await press(ui) // 取消后，又是那个插件画的样子
  expect(await hasEngine(ui)).toBe(true)
  await ui.unmount()
})

test('/key-points sets how each kind is marked; it combines and is kept across sessions', async ($, on) => {
  const log = newLog()
  engine(on, log)
  const run = (args: string) => $.command.run({ command: 'key-points', args } as any)
  expect((await run('')).text).toContain('关注句：字体色 warning，背景色 无，下划线 关')
  expect((await run('sentence underline on')).text).toBe('关注句：字体色 warning，背景色 无，下划线 开')
  expect((await run('word color none')).text).toBe('关注词：字体色 默认，背景色 #FFFF00，下划线 关')
  expect((await run('词 bg 青')).text).toBe('关注词：字体色 默认，背景色 cyan，下划线 关')
  expect((await run('sentence color 紫红')).text).toContain('认不出颜色「紫红」')
  expect((await run('word bg none')).text).toContain('关注词现在没有任何样式')
  expect(log.store.styles).toEqual({ sentence: { color: 'warning', underline: true }, word: { underline: false } })

  await run('word bg #ff0')
  await finish($, REPLY)
  const ui = await mountReply($, 'msg-8')
  await press(ui)
  expect(await marked(ui)).toEqual([
    ['可以做', { weight: 'bold', color: 'warning', underline: true }],
    ['，但要先改 aload。', { color: 'warning', underline: true }],
    ['荧光黄', { backgroundColor: '#FF0' }],
  ])
  await ui.unmount()

  expect((await run('reset')).text).toContain('已恢复默认')
  expect(log.store.styles).toEqual({
    sentence: { color: 'warning', underline: false },
    word: { color: '#000000', backgroundColor: '#FFFF00', underline: false },
  })

  // 下次会话开始时读回来；存坏了的值不认
  log.store.styles = { sentence: { color: 'red', underline: true }, word: { backgroundColor: '不是颜色', underline: 'yes' } }
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true } as any)
  expect((await run('')).text).toContain('关注句：字体色 red，背景色 无，下划线 开\n关注词：字体色 默认，背景色 无，下划线 关')
})

test('replies from before the session started get the link too', async ($, on) => {
  const log = newLog()
  log.history = [
    { role: 'user', text: '能做吗？' },
    { role: 'assistant', text: '我先查一下。' },
    { role: 'user', text: '', toolResults: [{}] },
    { role: 'assistant', text: REPLY },
    { role: 'user', text: '<task-notification>后台任务完成</task-notification>' },
  ]
  engine(on, log)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true } as any)
  const ui = await mountReply($, 'old-1')
  expect((await ui.find({ key: 'key-points-link' }))?.props.label).toBe('📌 key points')
  await ui.unmount()
  const middle = await mountReply($, 'old-0', '我先查一下。')
  expect(await middle.find({ key: 'key-points-link' })).toBeUndefined() // 过程中的说明文字不是最终回复
  await middle.unmount()
})

test('a summary block is left to the engine', async ($, on) => {
  engine(on, newLog())
  await finish($, '查了几个文件')
  const ui = await $.ui.mount({
    plugin: 'key-points',
    surface: 'terminal',
    component: 'AssistantMessage',
    props: { text: '查了几个文件', isFirstOfReply: true, isSummary: true },
  })
  expect(await ui.find({ key: 'key-points-link' })).toBeUndefined()
  await ui.unmount()
})
