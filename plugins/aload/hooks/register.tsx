import { atom, memberOf, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderNode } from 'claude-code'

import type { AloadFinal, AloadIcon, AloadJob, AloadNow, AloadProvider } from '../types'

import { locate, speechFrom, splitChunks } from './blocks'
import { parseSpans, redactAll, redactPrompt } from './redact'
import { hasEngine, withoutEngine } from './tree'

// aload：点了才念，从不自动念。
// 默认（reply）：每轮最终回复的末尾一个「🔊 read aload」，从头念到这条回复结束；先选中几个字再点，从选中处往后念。
// 可选（paragraph / hover）：每段左边一个 🔊，从那一段念到结尾。
// 合成和播放交给 bin/aload.py（只用 Python 标准库，macOS、Windows、Linux 通用）；这里管画按钮、/aload 命令和 Key 输入框。
// 送去第三方朗读接口之前，先把敏感信息换成【密钥】【密码】这类说明（见 redact.ts）。
// 本机朗读（macOS 上叫 macos，用系统自带的“辅助功能 → 朗读内容”）不联网，不用屏蔽。

type $ = EngineInterface

// 找 Python 3 的顺序：macOS 自带的、Linux 和 Homebrew 的 python3、Windows 的 py 启动器、最后是 python。
// Windows 上的 python3 常常是跳去微软商店的空壳，跑不出版本号，会被跳过
const PYTHONS: readonly (readonly string[])[] = [['/usr/bin/python3'], ['python3'], ['py', '-3'], ['python']]
// 让 Python 和插件之间的管道一律用 UTF-8（Windows 默认是系统代码页）
const PY_ENV = { PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' }
const PANE = 'aload-key'
// 云端的两家要 Key；本机朗读不要 Key、不联网，名字跟着系统走，aload.py 的 status 会说这台电脑上是哪一个
const CLOUD: readonly AloadProvider[] = ['azure', 'doubao']
const LOCALS: readonly AloadProvider[] = ['macos', 'windows', 'linux']
const ICONS: readonly AloadIcon[] = ['reply', 'paragraph', 'hover']
const NAMES: Record<AloadProvider, string> = {
  azure: 'Azure 语音',
  doubao: '豆包语音 2.0',
  macos: 'macOS 系统朗读',
  windows: 'Windows 系统朗读',
  linux: 'Linux 系统朗读',
}
const ICON_NAMES: Record<AloadIcon, string> = {
  reply: '每条回复末尾一个',
  paragraph: '每段一个（常显）',
  hover: '每段一个（鼠标移上去才显示）',
}
const ICON_PLAY = '🔊'
const ICON_LOADING = '⏳'
const ICON_STOP = '🔇'
// 末尾的按钮画成链接的样子（蓝色、下划线），但它是 Button，不是真的链接：
// 链接带网址，点击偶尔没被插件接住时（比如正好赶上重画），Ghostty 里的 Claude Code 会当成 ⌘+点击，用浏览器打开网址；
// 按钮没有网址，最坏只是这一下没反应。也就不再要求终端支持超链接
const LINK_COLOR = 'blueBright'
const FINALS_MAX = 100
const POLL_MS = 400

// 会话级状态：写入会让读它的地方重画
const now = atom({ plugin: 'aload', key: 'now' } as const, null)
const playing = atom({ plugin: 'aload', key: 'playing' } as const, null)
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
  // 这台电脑上的本机朗读叫什么
  local?: AloadProvider
  icon: AloadIcon
  voices: Partial<Record<AloadProvider, string>>
  keys: Partial<Record<AloadProvider, KeyInfo>>
  saved?: AloadProvider
  // Key 本身有效、但还不能念（没开通对应服务、音色不属于已开通的服务）时的说明
  warning?: string
}

// 本会话里正在念的那一个：结束它的读取循环，引擎就结束 aload.py
let current: { job: AloadJob; stream: AsyncGenerator<unknown, unknown> } | null = null
// 正在检查敏感信息、还没开念的那一次：这期间按了停止或者又开了新的一次，它就作废
let preparing: object | null = null
// 检查过的文字记一份，同一段再念就不用再问（最多记 20 次）
const REDACTED_MAX = 20
const redacted = new Map<string, string[]>()
let polling: { cancel: () => void } | null = null

function isProvider(x: string | undefined): x is AloadProvider {
  return !!x && ([...CLOUD, ...LOCALS] as readonly string[]).includes(x)
}

function isLocal(x: AloadProvider | undefined): boolean {
  return !!x && LOCALS.includes(x)
}

function isIcon(x: string | undefined): x is AloadIcon {
  return !!x && (ICONS as readonly string[]).includes(x)
}

// 试出来的 Python 记在这里（重新加载插件后再试一次）
let python: readonly string[] | null = null

async function findPython($: $): Promise<readonly string[]> {
  if (python) return python
  for (const candidate of PYTHONS) {
    try {
      const { exitCode, stdout } = await $.process.run([...candidate, '-c', 'import sys; print(sys.version_info[0])'], { env: PY_ENV, timeoutMs: 15000 })
      if (exitCode === 0 && stdout.trim() === '3') return (python = candidate)
    } catch {
      // 没有这个命令，试下一个
    }
  }
  throw new Error('找不到 Python 3。macOS 请执行 xcode-select --install；Windows 请从 python.org 安装，或执行 winget install Python.Python.3.13；Linux 请安装 python3')
}

async function helper($: $): Promise<string[]> {
  return [...(await findPython($)), `${$.plugin.root}/bin/aload.py`]
}

// 跑一次 aload.py 的子命令，它最后一行输出 JSON
async function run($: $, args: string[], stdin?: string, timeoutMs = 30000): Promise<Status> {
  try {
    const { stdout, stderr } = await $.process.run([...(await helper($)), ...args], { stdin, timeoutMs, env: PY_ENV })
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

// 送去第三方之前屏蔽敏感信息：请 Claude 列出要屏蔽的片段，再用本地规则兜底。
// 用快的模型，medium 档位。只写模型名、不写版本号，模型升级了自动跟着用新的；
// 按顺序试，前一个用不了（账号没有这个模型、下架了、报错、超时）就换下一个，最后才用当前会话的模型。
// 都没成功时只用本地规则，并提示一句
const CHECK_MODELS = ['haiku', 'sonnet', 'opus'] as const
// 整个检查最多等这么久，过了就不再换模型，直接用本地规则
const CHECK_BUDGET_MS = 20000
// 上次成功的是第几个：后面再查就从它开始，不用每次都在用不了的模型上浪费时间（重新加载插件后从头来）
let checkFrom = 0

async function askForSpans($: $, segments: readonly string[]) {
  const models: string[] = [...CHECK_MODELS]
  try {
    models.push(await $.session.model())
  } catch {
    // 拿不到当前模型，就只试上面几个
  }
  const prompt = redactPrompt(segments)
  const deadline = Date.now() + CHECK_BUDGET_MS
  for (let i = Math.min(checkFrom, models.length - 1); i < models.length; i++) {
    const left = deadline - Date.now()
    if (left < 1000) break
    try {
      const res = await $.model.complete({ model: models[i]!, prompt, effort: 'medium', maxTokens: 2000, timeoutMs: Math.min(15000, left) })
      const spans = res.isAnswered ? parseSpans(res.text) : null
      if (spans) {
        checkFrom = i
        return spans
      }
    } catch {
      // 这个模型用不了（比如账号没有权限），试下一个
    }
  }
  return null
}

async function redact($: $, segments: readonly string[]): Promise<string[]> {
  const memo = redacted.get(JSON.stringify(segments))
  if (memo) return memo
  const spans = await askForSpans($, segments)
  if (!spans) {
    $.ui.toast('敏感信息检查没有完成，这次只按本地规则屏蔽了常见格式的 Key 和密码')
    return redactAll(segments, [])
  }
  const out = redactAll(segments, spans)
  redacted.set(JSON.stringify(segments), out)
  if (redacted.size > REDACTED_MAX) redacted.delete(redacted.keys().next().value!)
  return out
}

// “正在念”的消息 id：每段模式的 key 是“消息 id:段号”
function messageOf(key: string): string {
  const cut = key.lastIndexOf(':')
  return cut < 0 ? key : key.slice(0, cut)
}

// 改“正在念”：全局一份（停止、判断时用），再按消息各存一份（画的时候用），
// 这样念到下一段时只有正在念的那条回复重画，别的回复不跟着动
async function setNow($: $, change: (cur: AloadNow | null) => AloadNow | null) {
  const before = await read($, now)
  const after = await update($, now, change)
  const was = before ? messageOf(before.key) : null
  const is = after ? messageOf(after.key) : null
  if (was && was !== is) await update($, memberOf(playing, { requestId: was }), () => null)
  if (is) await update($, memberOf(playing, { requestId: is }), () => after)
}

// provider：这次用哪家念（不知道时 aload.py 用设置里的那家，这里照常屏蔽敏感信息）
async function speak($: $, job: AloadJob, provider?: AloadProvider) {
  await stopCurrent($)
  const ticket = {}
  preparing = ticket
  const total = job.segments.length
  await setNow($, () => ({ key: job.keys[0]!, status: 'loading' as const, seg: 1, total }))
  // 本机朗读不出这台电脑，不用屏蔽
  const segments = isLocal(provider) ? [...job.segments] : await redact($, job.segments)
  if (preparing !== ticket) return // 检查的时候停掉了，或者又开了新的一次
  preparing = null
  let argv: string[]
  try {
    argv = [...(await helper($)), 'speak']
  } catch (err) {
    $.ui.toast(`朗读启动失败：${(err as Error).message}`)
    await setNow($, () => null)
    return
  }
  const stream = $.process.spawn({ argv, env: PY_ENV, input: JSON.stringify(provider ? { segments, provider } : { segments }) })
  current = { job, stream }
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
        if (line === 'PLAYING') await setNow($, n => (n ? { ...n, status: 'playing' as const } : n))
        else if (line.startsWith('SEGMENT ')) {
          const j = Number(line.slice(8)) || 0
          await setNow($, () => ({ key: job.keys[j] ?? job.keys[0]!, status: 'playing' as const, seg: j + 1, total }))
        } else if (line.startsWith('ERROR ')) await onError($, line, job)
      }
    }
    if (/Traceback/.test(err)) $.ui.toast(`朗读出错：${err.trim().split('\n').pop()}`)
  } catch (error) {
    $.ui.toast(`朗读启动失败：${(error as Error).message}`)
  } finally {
    if (current?.stream === stream) {
      current = null
      await setNow($, () => null)
    }
  }
}

// ERROR <类型> <厂家> <说明>：没 Key、Key 失效就弹输入框，填好后接着念；别的错误提示一下
async function onError($: $, line: string, job: AloadJob) {
  const [, kind = 'other', provider = '', ...rest] = line.split(' ')
  const message = rest.join(' ')
  if ((kind === 'nokey' || kind === 'auth') && isProvider(provider) && !isLocal(provider)) {
    const reason = kind === 'nokey' ? `还没有${NAMES[provider]}的 Key，请先输入。` : `${message}。请重新输入。`
    const placed = await openKeyPane($, provider, reason, job)
    if (!placed) $.ui.toast(`${reason}输入 /aload key ${provider} 打开输入框。`)
    return
  }
  $.ui.toast(`朗读失败：${message || kind}`)
}

async function stopCurrent($: $) {
  preparing = null
  const cur = current
  current = null
  if (cur) void cur.stream.return(undefined).catch(() => undefined)
  if (await read($, now)) await setNow($, () => null)
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
  if (st.ok && !st.keys[st.provider]?.set) {
    await openKeyPane($, st.provider, `还没有${NAMES[st.provider]}的 Key，请先输入。`, job)
    return
  }
  void speak($, job, st.ok ? st.provider : undefined)
}

// 末尾的 read aload：有选中文字就从选中处念，否则从头念，一直念到这条回复结束
async function pressReply($: $, requestId: string, answer: string) {
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
    if (p.pending?.segments.length) void speak($, p.pending, p.provider)
  } finally {
    await update($, paneBusy, () => false)
  }
}

// ---------- /aload ----------

// 用法：这台电脑上有本机朗读，就把它也列进去
function usage(local?: AloadProvider): string {
  return [
    '/aload                       查看当前厂家、Key、音色',
    `/aload ${[...CLOUD, ...(local ? [local] : [])].join('|')}   切换厂家（azure、doubao 没有 Key 会弹出输入框${local ? `；${local} 是${NAMES[local]}，不要 Key、不联网` : ''}）`,
    '/aload key [厂家]            重新输入 Key',
    `/aload voice <音色>          设置当前厂家的音色${local ? `（${NAMES[local]}写系统里的声音名，写 default 回到系统默认的声音）` : ''}`,
    '/aload icon reply|paragraph|hover  按钮放在每条回复末尾 / 每段左边 / 每段左边且鼠标移上去才显示',
    '/aload stop                  停止朗读',
  ].join('\n')
}

function voiceOf(st: Status, p: AloadProvider): string {
  return st.voices[p] || (isLocal(p) ? '系统默认的声音' : '默认')
}

function describe(st: Status): string {
  if (!st.ok) return `❌ ${st.error}`
  const lines = [`当前厂家：${NAMES[st.provider]}　按钮：${ICON_NAMES[st.icon] ?? st.icon}`]
  for (const p of [...CLOUD, ...(st.local ? [st.local] : [])]) {
    const mark = p === st.provider ? '▶' : '　'
    if (isLocal(p)) {
      lines.push(`${mark} ${NAMES[p]}：不要 Key，不联网，音色 ${voiceOf(st, p)}`)
      continue
    }
    const k = st.keys[p] ?? { set: false }
    const extra = p === 'azure' && k.region ? `，区域 ${k.region}` : p === 'doubao' && k.appId ? `，AppID ${k.appId}` : ''
    lines.push(`${mark} ${NAMES[p]}：${k.set ? `Key ${k.masked}${extra}` : '未设置 Key'}，音色 ${voiceOf(st, p)}`)
  }
  return `${lines.join('\n')}\n\n${usage(st.local)}`
}

async function command($: $, args: string): Promise<string> {
  const [sub = '', arg] = args.trim().split(/\s+/).filter(Boolean)
  if (!sub || sub === 'status') return describe(await run($, ['status']))
  if (isProvider(sub)) {
    const st = await run($, ['use', sub])
    if (!st.ok) return `❌ ${st.error}`
    if (isLocal(sub)) return `已切换到${NAMES[sub]}（不要 Key、不联网，音色 ${voiceOf(st, sub)}）。`
    if (!st.keys[sub]?.set) {
      await openKeyPane($, sub, `还没有${NAMES[sub]}的 Key，请先输入。`)
      return `已切换到${NAMES[sub]}，还没有 Key：已打开输入框。`
    }
    return `已切换到${NAMES[sub]}（Key ${st.keys[sub]?.masked}，音色 ${voiceOf(st, sub)}）。`
  }
  if (sub === 'key') {
    const target = isProvider(arg) ? arg : (await run($, ['status'])).provider ?? 'azure'
    if (isLocal(target)) return `${NAMES[target]}不需要 Key。`
    await openKeyPane($, target, '')
    return `已打开${NAMES[target]}的 Key 输入框。`
  }
  if (sub === 'voice') {
    // 音色名里可能有空格，比如 macOS 的“Eddy (中文（中国大陆）)”
    const name = args.trim().slice('voice'.length).trim()
    if (!name) return '请给出音色名，例如 /aload voice zh-CN-YunxiNeural'
    const st = await run($, ['voice', name])
    return st.ok ? `${NAMES[st.provider]}的音色已设为 ${voiceOf(st, st.provider)}，下次朗读生效。` : `❌ ${st.error}`
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
  return usage((await run($, ['status'])).local)
}

// ---------- 注册 ----------

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    current = null // 重新加载后旧的读取循环已经没了
    await setNow($, () => null)
    const st = await run($, ['status'])
    if (st.ok) await update($, icon, () => st.icon)
    await loadHistoryFinals($)
    const local = st.ok ? st.local : undefined
    await $.command.register({
      name: 'aload',
      description: `朗读：切换厂家（azure / doubao${local ? ` / ${local} 本机朗读` : ''}）、设置 Key、音色、按钮位置，或停止`,
      argumentHint: `[azure|doubao${local ? `|${local}` : ''}|key|voice|icon|stop]`,
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
      const cur = await read($, memberOf(playing, e))
      const active = cur?.key === e.requestId ? cur : null
      const { Box, Button, Text } = $.ui.resolve(e)
      let button
      if (active) {
        const label = active.status === 'loading' ? `${ICON_LOADING} loading` : `${ICON_STOP} stop reading`
        const progress = active.total > 1 ? ` ${active.seg}/${active.total}` : ''
        button = (
          <Button key="aload-read" label={label + progress} plain onPress={() => void stopAll($)}>
            <Text color={LINK_COLOR} underline>
              {label}
            </Text>
            {progress ? <Text dimColor>{progress}</Text> : null}
          </Button>
        )
      } else {
        const onSelected = selectionIn(answer, e.requestId, await read($, selected)) >= 0
        const label = `${ICON_PLAY} read aload${onSelected ? ' on selected' : ''}`
        button = (
          <Button key="aload-read" label={label} plain onPress={() => void pressReply($, e.requestId, answer)}>
            <Text color={LINK_COLOR} underline>
              {label}
            </Text>
          </Button>
        )
      }
      // 按钮在回复下面单独占一行。和别的插件（比如 key-points）的按钮上下排开，谁的文字变长变短都不会挤动别人
      return (
        <Box flexDirection="column">
          {drawn}
          <Box paddingLeft={2}>{button}</Box>
        </Box>
      )
    }

    // 每段一个图标。第一段交给引擎画（上面带一行空行，左边是 "⏺ "），后面的段用同一套 Markdown 渲染器画，
    // 补 2 格缩进和第一段对齐；🔊 叠在左边这 2 格里（第一段叠在 ⏺ 上），不挤动文字。
    // 段和段之间空一行、同一列表的相邻条目不空，都由这里排：各段的范围互不重叠，悬停才不会亮错段。
    const chunks = splitChunks(e.props.text)
    if (!chunks.some(c => c.speech)) return next(e)
    // 先按整条回复问一次里层（只有一段时不用，下面画第一段时里层就看到了整条）：
    // - 里层有插件把整条回复重画了（比如 key-points 正在标重点），这时让它画，每段的 🔊 暂时不显示；
    // - 否则把里层插件在回复下面加的东西（比如 key-points 的链接）留下来，接在最后一段后面
    let extras: RenderNode | null = null
    if (chunks.length > 1) {
      const whole = await next(e)
      if (!hasEngine(whole)) return whole
      extras = withoutEngine(whole)
    }
    const { Box, Button, Markdown } = $.ui.resolve(e)
    const cur = await read($, memberOf(playing, e))
    const rows = []
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]!
      const key = `${e.requestId}:${i}`
      const first = i === 0
      const body = first ? await next({ ...e, props: { ...e.props, text: chunk.md } }) : <Markdown text={chunk.md} />
      const tight = !first && chunk.kind === 'item' && chunks[i - 1]!.kind === 'item'
      const active = cur?.key === key ? cur : null
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
    if (extras) rows.push(extras)
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
