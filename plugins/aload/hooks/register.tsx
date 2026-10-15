import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AloadFinal, AloadIcon, AloadJob, AloadProvider } from '../types'

import { locate, speechFrom, splitChunks } from './blocks'

// aload：点了才念，从不自动念。
// 默认（reply）：每轮最终回复的末尾一个「🔊 read aload」，从头念到这条回复结束；先选中几个字再点，从选中处往后念。
// 可选（paragraph / hover）：每段左边一个 🔊，从那一段念到结尾。
// 合成和播放交给 bin/aload.py（只用 macOS 自带的 python3 和 afplay）；这里管画按钮、/aload 命令和 Key 输入框。

type $ = EngineInterface

const PYTHON = '/usr/bin/python3'
const PANE = 'aload-key'
const PROVIDERS: readonly AloadProvider[] = ['azure', 'doubao']
const ICONS: readonly AloadIcon[] = ['reply', 'paragraph', 'hover']
const NAMES: Record<AloadProvider, string> = { azure: 'Azure 语音', doubao: '豆包语音 2.0' }
const ICON_NAMES: Record<AloadIcon, string> = {
  reply: '每条回复末尾一个',
  paragraph: '每段一个（常显）',
  hover: '每段一个（鼠标移上去才显示）',
}
const ICON_PLAY = '🔊'
const ICON_LOADING = '⏳'
const ICON_STOP = '🔇'
// 末尾按钮画成一个链接（蓝色、下划线），点它由插件接住，不会打开网页；.invalid 是保留域名，按住 ⌘ 点开也去不了任何地方
const READ_URL = 'https://aload.invalid/read'
const STOP_URL = 'https://aload.invalid/stop'
const FINALS_MAX = 100
const POLL_MS = 400

// 会话级状态：写入会让读它的地方重画
const now = atom({ plugin: 'aload', key: 'now' } as const, null)
const icon = atom({ plugin: 'aload', key: 'icon' } as const, 'reply')
const finals = atom({ plugin: 'aload', key: 'finals' } as const, [])
const selected = atom({ plugin: 'aload', key: 'selected' } as const, null)
const pane = atom({ plugin: 'aload', key: 'pane' } as const, null)
const draftKey = atom({ plugin: 'aload', key: 'draftKey' } as const, '')
const draftExtra = atom({ plugin: 'aload', key: 'draftExtra' } as const, '')
const paneMsg = atom({ plugin: 'aload', key: 'paneMsg' } as const, '')
const paneBusy = atom({ plugin: 'aload', key: 'paneBusy' } as const, false)

type KeyInfo = { set: boolean; masked?: string; region?: string; appId?: string }
type Status = {
  ok: boolean
  error?: string
  kind?: string
  provider: AloadProvider
  icon: AloadIcon
  voices: Record<AloadProvider, string>
  keys: Record<AloadProvider, KeyInfo>
  saved?: AloadProvider
  // Key 本身有效、但还不能念（没开通对应服务、音色不属于已开通的服务）时的说明
  warning?: string
}

// 本会话里正在念的那一个：结束它的读取循环，引擎就结束 aload.py
let current: { job: AloadJob; stream: AsyncGenerator<unknown, unknown> } | null = null
let polling: { cancel: () => void } | null = null

function isProvider(x: string | undefined): x is AloadProvider {
  return !!x && (PROVIDERS as readonly string[]).includes(x)
}

function isIcon(x: string | undefined): x is AloadIcon {
  return !!x && (ICONS as readonly string[]).includes(x)
}

function helper($: $): string[] {
  return [PYTHON, `${$.plugin.root}/bin/aload.py`]
}

// 跑一次 aload.py 的子命令，它最后一行输出 JSON
async function run($: $, args: string[], stdin?: string, timeoutMs = 30000): Promise<Status> {
  try {
    const { stdout, stderr } = await $.process.run([...helper($), ...args], { stdin, timeoutMs })
    const last = stdout.trim().split('\n').pop() || ''
    try {
      return JSON.parse(last) as Status
    } catch {
      return { ok: false, error: (stderr || stdout || 'aload.py 没有输出').trim().slice(-300) } as Status
    }
  } catch (err) {
    return { ok: false, error: `aload.py 起不来：${(err as Error).message}` } as Status
  }
}

// ---------- 最终回复 ----------

function flat(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

async function addFinals($: $, answers: string[]) {
  const add = answers.filter(a => a.trim()).map(text => ({ text, flat: flat(text) }))
  if (!add.length) return
  const fresh = new Set(add.map(a => a.flat))
  await update($, finals, list => [...list.filter(a => !fresh.has(a.flat)), ...add].slice(-FINALS_MAX))
}

// 这一块是不是某轮最终回复的结尾那块：是就给出整条回复的原文（最终回复拆成几块时，按钮放在最后一块下面）
function finalOf(list: readonly AloadFinal[], blockText: string): string | undefined {
  const t = flat(blockText)
  if (!t) return undefined
  for (let i = list.length - 1; i >= 0; i--) if (list[i]!.flat.endsWith(t)) return list[i]!.text
  return undefined
}

// 历史回复：你每次提问之后、下一次提问之前，Claude 的最后一段文字就是那一轮的最终回复
// （任务通知、子代理回报这些也是 user 消息，但不算提问）
async function loadHistoryFinals($: $) {
  let rows
  try {
    rows = await $.session.messages()
  } catch {
    return
  }
  const answers: string[] = []
  let last = ''
  for (const row of rows) {
    if (row.role === 'user') {
      const t = row.text.trim()
      const isPrompt = !!t && !row.toolResults?.length && !t.startsWith('<') && !t.startsWith('Another Claude session')
      if (isPrompt) {
        if (last) answers.push(last)
        last = ''
      }
    } else if (row.text.trim()) last = row.text
  }
  if (last) answers.push(last)
  await addFinals($, answers)
}

// ---------- 选中的文字 ----------

async function pollSelection($: $) {
  if ((await read($, icon)) !== 'reply') return
  let sel
  try {
    sel = await $.ui.selection()
  } catch {
    return
  }
  const next = sel && sel.text.trim() ? { text: sel.text, requestId: sel.requestId } : null
  const cur = await read($, selected)
  if ((cur?.text ?? '') === (next?.text ?? '') && cur?.requestId === next?.requestId) return
  await update($, selected, () => next)
}

// 选中的文字在这条回复里的位置；不在这条回复里返回 -1
function selectionIn(answer: string, requestId: string, sel: { text: string; requestId?: string } | null | undefined): number {
  if (!sel || !sel.text.trim()) return -1
  const at = locate(answer, sel.text)
  if (at >= 0) return at
  return sel.requestId === requestId ? 0 : -1
}

// ---------- 念、停 ----------

async function speak($: $, job: AloadJob) {
  await stopCurrent($)
  const stream = $.process.spawn({ argv: [...helper($), 'speak'], input: JSON.stringify({ segments: job.segments }) })
  current = { job, stream }
  const total = job.segments.length
  await update($, now, () => ({ key: job.keys[0]!, status: 'loading' as const, seg: 1, total }))
  let out = ''
  let err = ''
  try {
    for await (const piece of stream) {
      if (current?.stream !== stream) break
      if (piece.stream === 'stderr') {
        err += piece.text
        continue
      }
      out += piece.text
      let nl: number
      while ((nl = out.indexOf('\n')) >= 0) {
        const line = out.slice(0, nl)
        out = out.slice(nl + 1)
        if (line === 'PLAYING') await update($, now, n => (n ? { ...n, status: 'playing' as const } : n))
        else if (line.startsWith('SEGMENT ')) {
          const j = Number(line.slice(8)) || 0
          await update($, now, () => ({ key: job.keys[j] ?? job.keys[0]!, status: 'playing' as const, seg: j + 1, total }))
        } else if (line.startsWith('ERROR ')) await onError($, line, job)
      }
    }
    if (/Traceback/.test(err)) $.ui.toast(`朗读出错：${err.trim().split('\n').pop()}`)
  } catch (error) {
    $.ui.toast(`朗读启动失败：${(error as Error).message}`)
  } finally {
    if (current?.stream === stream) {
      current = null
      await update($, now, () => null)
    }
  }
}

// ERROR <类型> <厂家> <说明>：没 Key、Key 失效就弹输入框，填好后接着念；别的错误提示一下
async function onError($: $, line: string, job: AloadJob) {
  const [, kind = 'other', provider = '', ...rest] = line.split(' ')
  const message = rest.join(' ')
  if ((kind === 'nokey' || kind === 'auth') && isProvider(provider)) {
    const reason = kind === 'nokey' ? `还没有${NAMES[provider]}的 Key，请先输入。` : `${message}。请重新输入。`
    const placed = await openKeyPane($, provider, reason, job)
    if (!placed) $.ui.toast(`${reason}输入 /aload key ${provider} 打开输入框。`)
    return
  }
  $.ui.toast(`朗读失败：${message || kind}`)
}

async function stopCurrent($: $) {
  const cur = current
  current = null
  if (cur) void cur.stream.return(undefined).catch(() => undefined)
  if (await read($, now)) await update($, now, () => null)
}

// 停掉本会话的，也停掉全机正在念的那个（全机只有一个声音）
async function stopAll($: $) {
  await stopCurrent($)
  await run($, ['stop'], undefined, 5000)
}

// 开念：在这次按下里先查有没有 Key，没有就当场弹输入框（引擎只给"你按了按钮才弹"的面板让位置）；
// 有 Key 才开念，念的过程不拖住这次按下
async function start($: $, job: AloadJob) {
  if (!job.segments.length) {
    $.ui.toast('这里没有可以念的文字')
    return
  }
  const st = await run($, ['status'])
  if (st.ok && !st.keys[st.provider].set) {
    await openKeyPane($, st.provider, `还没有${NAMES[st.provider]}的 Key，请先输入。`, job)
    return
  }
  void speak($, job)
}

// 末尾的 read aload：有选中文字就从选中处念，否则从头念，一直念到这条回复结束
async function pressReply($: $, requestId: string, answer: string, href: string) {
  if (href === STOP_URL) return stopAll($)
  let sel
  try {
    sel = await $.ui.selection()
  } catch {
    sel = undefined
  }
  const at = selectionIn(answer, requestId, sel)
  const segments = speechFrom(answer, Math.max(at, 0))
  return start($, { keys: segments.map(() => requestId), segments })
}

// 每段的 🔊：从这一段念到结尾；正在念的那段再点一下就停
async function pressChunk($: $, requestId: string, text: string, from: number) {
  const cur = await read($, now)
  if (cur?.key === `${requestId}:${from}`) return stopAll($)
  const chunks = splitChunks(text)
  const keys: string[] = []
  const segments: string[] = []
  chunks.forEach((c, i) => {
    if (i >= from && c.speech) {
      keys.push(`${requestId}:${i}`)
      segments.push(c.speech)
    }
  })
  return start($, { keys, segments })
}

// ---------- Key 输入面板 ----------

// 返回面板有没有放出来（不是你按按钮或敲命令打开的，窄终端里会先不放）
async function openKeyPane($: $, provider: AloadProvider, reason: string, pending?: AloadJob) {
  const st = await run($, ['status'])
  const info = st.ok ? st.keys[provider] : undefined
  await update($, pane, () => ({ provider, reason, pending }))
  await update($, draftKey, () => '')
  await update($, draftExtra, () => (provider === 'azure' ? info?.region ?? 'eastasia' : info?.appId ?? ''))
  await update($, paneMsg, () => '')
  const res = await $.ui.open({ id: PANE, title: `🔑 ${NAMES[provider]} Key`, focus: true, closeOnEscape: true, columns: 56, rows: 14 })
  return res.isPlaced
}

async function saveKey($: $) {
  if (await read($, paneBusy)) return
  const p = await read($, pane)
  if (!p) return
  const key = (await read($, draftKey)).trim()
  const extra = (await read($, draftExtra)).trim()
  if (!key) {
    await update($, paneMsg, () => '请先填 Key')
    return
  }
  await update($, paneBusy, () => true)
  await update($, paneMsg, () => '⏳ 正在向厂家验证（会真的合成一句"你好"）…')
  try {
    const payload = p.provider === 'azure' ? { provider: p.provider, key, region: extra } : { provider: p.provider, key, appId: extra }
    const res = await run($, ['setkey'], JSON.stringify(payload), 45000)
    if (!res.ok) {
      await update($, paneMsg, () => `❌ ${res.error ?? '验证失败'}`)
      return
    }
    await update($, draftKey, () => '')
    if (res.warning) {
      // Key 已存好；面板留着，把卡在哪一步说清楚（去控制台开通后直接点 🔊 就行，不用再输 Key）
      await update($, pane, () => ({ provider: p.provider, reason: '' }))
      await update($, paneMsg, () => `✅ Key 有效，已保存（${res.keys[p.provider]?.masked ?? ''}）。\n⚠️ ${res.warning}`)
      return
    }
    await update($, pane, () => null)
    await $.ui.close({ id: PANE })
    $.ui.toast(`✅ 已保存${NAMES[p.provider]}的 Key（${res.keys[p.provider]?.masked ?? ''}），现在用它朗读`)
    if (p.pending?.segments.length) void speak($, p.pending)
  } finally {
    await update($, paneBusy, () => false)
  }
}

// ---------- /aload ----------

const USAGE = [
  '/aload                       查看当前厂家、Key、音色',
  '/aload azure|doubao          切换厂家（没有 Key 会弹出输入框）',
  '/aload key [厂家]            重新输入 Key',
  '/aload voice <音色>          设置当前厂家的音色',
  '/aload icon reply|paragraph|hover  按钮放在每条回复末尾 / 每段左边 / 每段左边且鼠标移上去才显示',
  '/aload stop                  停止朗读',
].join('\n')

function describe(st: Status): string {
  if (!st.ok) return `❌ ${st.error}`
  const lines = [`当前厂家：${NAMES[st.provider]}　按钮：${ICON_NAMES[st.icon] ?? st.icon}`]
  for (const p of PROVIDERS) {
    const k = st.keys[p]
    const extra = p === 'azure' && k.region ? `，区域 ${k.region}` : p === 'doubao' && k.appId ? `，AppID ${k.appId}` : ''
    lines.push(`${p === st.provider ? '▶' : '　'} ${NAMES[p]}：${k.set ? `Key ${k.masked}${extra}` : '未设置 Key'}，音色 ${st.voices[p]}`)
  }
  return `${lines.join('\n')}\n\n${USAGE}`
}

async function command($: $, args: string): Promise<string> {
  const [sub = '', arg] = args.trim().split(/\s+/).filter(Boolean)
  if (!sub || sub === 'status') return describe(await run($, ['status']))
  if (isProvider(sub)) {
    const st = await run($, ['use', sub])
    if (!st.ok) return `❌ ${st.error}`
    if (!st.keys[sub].set) {
      await openKeyPane($, sub, `还没有${NAMES[sub]}的 Key，请先输入。`)
      return `已切换到${NAMES[sub]}，还没有 Key：已打开输入框。`
    }
    return `已切换到${NAMES[sub]}（Key ${st.keys[sub].masked}，音色 ${st.voices[sub]}）。`
  }
  if (sub === 'key') {
    const target = isProvider(arg) ? arg : (await run($, ['status'])).provider ?? 'azure'
    await openKeyPane($, target, '')
    return `已打开${NAMES[target]}的 Key 输入框。`
  }
  if (sub === 'voice') {
    if (!arg) return '请给出音色名，例如 /aload voice zh-CN-YunxiNeural'
    const st = await run($, ['voice', arg])
    return st.ok ? `${NAMES[st.provider]}的音色已设为 ${arg}，下次朗读生效。` : `❌ ${st.error}`
  }
  if (sub === 'icon') {
    if (!isIcon(arg)) return '用法：/aload icon reply、/aload icon paragraph 或 /aload icon hover'
    const st = await run($, ['icon', arg])
    if (!st.ok) return `❌ ${st.error}`
    await update($, icon, () => arg)
    return `朗读按钮改为：${ICON_NAMES[arg]}。`
  }
  if (sub === 'stop') {
    await stopAll($)
    return '已停止朗读。'
  }
  return USAGE
}

// ---------- 注册 ----------

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    current = null // 重新加载后旧的读取循环已经没了
    await update($, now, () => null)
    const st = await run($, ['status'])
    if (st.ok) await update($, icon, () => st.icon)
    await loadHistoryFinals($)
    await $.command.register({
      name: 'aload',
      description: '朗读：切换厂家（azure / doubao）、设置 Key、音色、按钮位置，或停止',
      argumentHint: '[azure|doubao|key|voice|icon|stop]',
      immediate: true,
    })
    polling?.cancel()
    polling = $.clock.every(POLL_MS, () => void pollSelection($))
    return started
  })

  on('session.end', async ($, e, next) => {
    if (current) await stopAll($)
    return next(e)
  })

  // 一轮结束：记下这轮的最终回复（子代理的回合不算），它下面才出现 read aload
  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (!e.agentId && e.reason === 'answer' && e.answer.trim()) await addFinals($, [e.answer])
    return done
  })

  on('command.run', { command: 'aload' }, async ($, e) => ({ text: await command($, e.args) }))

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    if (e.props.isSummary || !e.props.text.trim()) return next(e)
    const mode = await read($, icon)
    if (mode === 'reply') {
      // 每条最终回复的末尾一行「🔊 read aload」，正文原样不动
      const answer = finalOf(await read($, finals), e.props.text)
      if (!answer) return next(e)
      const drawn = await next(e)
      const playing = await read($, now)
      const active = playing?.key === e.requestId ? playing : null
      let link: string
      if (active) {
        const progress = active.total > 1 ? ` ${active.seg}/${active.total}` : ''
        link = `[${active.status === 'loading' ? `${ICON_LOADING} loading` : `${ICON_STOP} stop reading`}](${STOP_URL})${progress}`
      } else {
        const onSelected = selectionIn(answer, e.requestId, await read($, selected)) >= 0
        link = `[${ICON_PLAY} read aload${onSelected ? ' on selected' : ''}](${READ_URL})`
      }
      const { Box, Markdown } = $.ui.resolve(e)
      return (
        <Box flexDirection="column">
          {drawn}
          <Box paddingLeft={2}>
            <Markdown key="aload-read" text={link} onLinkPress={pressed => void pressReply($, e.requestId, answer, pressed.href)} />
          </Box>
        </Box>
      )
    }

    // 每段一个图标。第一段交给引擎画（上面带一行空行，左边是 "⏺ "），后面的段用同一套 Markdown 渲染器画，
    // 补 2 格缩进和第一段对齐；🔊 叠在左边这 2 格里（第一段叠在 ⏺ 上），不挤动文字。
    // 段和段之间空一行、同一列表的相邻条目不空，都由这里排：各段的范围互不重叠，悬停才不会亮错段。
    const chunks = splitChunks(e.props.text)
    if (!chunks.some(c => c.speech)) return next(e)
    const { Box, Button, Markdown } = $.ui.resolve(e)
    const playing = await read($, now)
    const rows = []
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]!
      const key = `${e.requestId}:${i}`
      const first = i === 0
      const body = first ? await next({ ...e, props: { ...e.props, text: chunk.md } }) : <Markdown text={chunk.md} />
      const tight = !first && chunk.kind === 'item' && chunks[i - 1]!.kind === 'item'
      const active = playing?.key === key ? playing : null
      let mark = null
      if (chunk.speech) {
        const shown = mode === 'paragraph' || !!active
        mark = (
          <Box position="absolute" top={first ? 1 : 0} left={0} {...(shown ? {} : { display: 'none' as const, hover: { display: 'flex' as const } })}>
            <Button
              key={`aload-${i}`}
              label={active ? (active.status === 'loading' ? ICON_LOADING : ICON_STOP) : ICON_PLAY}
              plain
              dimColor={!active}
              onPress={() => pressChunk($, e.requestId, e.props.text, i)}
            />
          </Box>
        )
      }
      rows.push(
        <Box key={`aload-row-${i}`} flexDirection="column" marginTop={first || tight ? 0 : 1}>
          <Box flexDirection="column" paddingLeft={first && e.props.isFirstOfReply ? 0 : 2}>
            {body}
          </Box>
          {mark}
        </Box>,
      )
    }
    return <Box flexDirection="column">{rows}</Box>
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const p = await read($, pane)
    if (!p) return <Text dimColor>没有要设置的 Key。用 /aload key 打开。</Text>
    if (e.surface === 'mobile') return <Text>请在终端里输入 Key：/aload key {p.provider}</Text>
    const { Input, Button } = $.ui.resolve(e)
    const isAzure = p.provider === 'azure'
    const busy = await read($, paneBusy)
    const msg = await read($, paneMsg)
    return (
      <Box flexDirection="column" gap={1}>
        {p.reason ? <Text color="yellow">{p.reason}</Text> : null}
        <Box flexDirection="column">
          <Input
            key="aload-key"
            label={isAzure ? 'Key' : 'API Key'}
            placeholder={isAzure ? '密钥 1 或密钥 2' : 'API Key 管理里的 Key'}
            value={await read($, draftKey)}
            submitLabel="验证"
            autoFocus
            onInput={v => void update($, draftKey, () => v)}
            onSubmit={v => void update($, draftKey, () => v).then(() => saveKey($))}
          />
          <Input
            key="aload-extra"
            label={isAzure ? '区域' : 'App ID'}
            placeholder={isAzure ? '如 eastasia' : '可选，旧版控制台才填'}
            value={await read($, draftExtra)}
            submitLabel="验证"
            onInput={v => void update($, draftExtra, () => v)}
            onSubmit={v => void update($, draftExtra, () => v).then(() => saveKey($))}
          />
          <Button key="aload-save" label={busy ? '⏳ 验证中…' : '验证并保存'} variant="primary" onPress={() => void saveKey($)} />
        </Box>
        {msg ? <Text>{msg}</Text> : null}
        <Text dimColor>
          {isAzure
            ? 'Azure 门户 → 语音服务资源 →「密钥和终结点」：复制密钥和位置/区域（如 eastasia、eastus、chinanorth3）。免费档 F0 每月 50 万字符。'
            : '火山引擎控制台开通「豆包语音合成大模型 2.0」，在「API Key 管理」创建 Key；旧版控制台填 AppID，上面填 Access Token。按字数计费。'}
        </Text>
        <Text dimColor>Key 只存在本机 ~/.config/aload/credentials.json（权限 600），不进对话记录。输入时会明文显示，注意屏幕共享。</Text>
      </Box>
    )
  })
}
