import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SiteView } from 'claude-code'

import type { IxSummary, IxTurn } from '../types'

import { locate, reveal } from './jump'
import type { JumpIO } from './jump'
import { Rows } from './rows'
import { cleanSummary, endsWithTurn, fit, hashOf, headOf, keyOf, oneLine, placesOf, splitTurns, summaryPrompt, wrapLines } from './turns'

// index：/index 在右侧弹出本次会话的目录，每一轮一项：提问的缩略、回答的摘要。点一项，左边的对话就跳到那次提问。
//
// - 目录由 $.session.messages() 切出来；摘要在后台请 Claude（haiku）写，一轮一次，写好的存进 $.store，下次不再写；
// - 跳转用 $.ui.scroll 把那一行提问翻到屏幕顶上。它要那一行的 id，而对话记录里没有 id，
//   所以插件记下界面画过的每一行提问（rows.ts），按文字和目录对上号；
//   还没画过的（太早的、往上翻才会画的），就从它下面离它最近的、画过的一行开始往上翻，直到它被画出来（jump.ts）；
// - 点击和翻动对话都只在全屏界面（/tui fullscreen）里有效。

type $ = EngineInterface

const PANE = 'index'
const TITLE = '目录'
// 停靠在右边时想要的宽度（用户拖动过的宽度优先）
const PANE_COLUMNS = 50
const TURNS_MAX = 300
const SUMMARY_LINES = 2
const HOVER = { color: 'suggestion' }

// 摘要：先用快的模型，用不了（账号没有、报错、超时）就换下一个，最后用当前会话的模型。只写别名，跟着升级
const SUMMARY_MODELS = ['haiku', 'sonnet'] as const
const SUMMARY_TIMEOUT_MS = 30000
// 同时写几条
const PARALLEL = 2
// 存进 $.store 的摘要最多留多少条
const SAVED_MAX = 500
const STORE_SUMMARIES = 'summaries'
const STORE_USE_MODEL = 'useModel'

// 会话级状态：写入会让读它的地方重画
const turns = atom({ plugin: 'index', key: 'turns' } as const, [])
const running = atom({ plugin: 'index', key: 'running' } as const, false)
const summaries = atom({ plugin: 'index', key: 'summaries' } as const, {})
const useModel = atom({ plugin: 'index', key: 'useModel' } as const, true)

const rows = new Rows()
// 写摘要要用的提问和回复原文（按回复的 hash）。只在内存里，重新加载后由 refresh() 补回
const sources = new Map<string, { question: string; answer: string }>()
// $.store 里存着的摘要（跨会话）：hash → 摘要
let saved: Record<string, string> = {}
const queue: string[] = []
let active = 0
// 上次写成摘要的是第几个模型：下次从它开始（重新加载插件后从头来）
let modelFrom = 0
let jumping = false
// 主对话有一轮正在跑（turn.start 到 turn.complete 之间）
let isTurnRunning = false

// ---------- 目录 ----------

async function isOpen($: $, placedOnly = true): Promise<boolean> {
  try {
    return (await $.ui.panes()).some(p => p.id === PANE && (!placedOnly || p.isPlaced))
  } catch {
    return false
  }
}

// 从对话记录重新切一遍目录
async function refresh($: $) {
  let msgs
  try {
    msgs = await $.session.messages()
  } catch {
    return
  }
  const list = splitTurns(msgs, isTurnRunning).slice(-TURNS_MAX)
  // 目录最后一项还在回答：跑着的这一轮是它（不是任务通知之类引起的）
  const isLive = isTurnRunning && endsWithTurn(msgs)
  if ((await read($, running)) !== isLive) await update($, running, () => isLive)
  sources.clear()
  const next: IxTurn[] = list.map(t => {
    const hash = t.answer.trim() ? hashOf(t.answer) : ''
    if (hash) sources.set(hash, { question: t.prompt, answer: t.answer })
    return { key: t.key, prompt: oneLine(t.prompt).slice(0, 400), hash, head: headOf(t.answer) }
  })
  if (JSON.stringify(await read($, turns)) !== JSON.stringify(next)) await update($, turns, () => next)
  if (await isOpen($)) await summarizeAll($)
}

// ---------- 摘要 ----------

async function summarizeAll($: $) {
  const list = await read($, turns)
  const isRunning = await read($, running)
  const sums = await read($, summaries)
  const isOn = await read($, useModel)
  const known: Record<string, IxSummary> = {}
  const todo: string[] = []
  list.forEach((t, i) => {
    // 还在回答的那一轮先不写
    if (!t.hash || sums[t.hash] || (isRunning && i === list.length - 1)) return
    const text = saved[t.hash]
    if (text) known[t.hash] = { status: 'done', text }
    else if (isOn) todo.push(t.hash)
  })
  if (Object.keys(known).length) await update($, summaries, all => ({ ...all, ...known }))
  // 新的先写：打开目录时看到的是最后几轮
  for (const hash of todo.reverse()) if (!queue.includes(hash)) queue.push(hash)
  pump($)
}

function pump($: $) {
  while (active < PARALLEL && queue.length) {
    const hash = queue.shift()!
    active++
    void summarizeOne($, hash).finally(() => {
      active--
      pump($)
    })
  }
}

async function setSummary($: $, hash: string, s: IxSummary) {
  await update($, summaries, all => ({ ...all, [hash]: s }))
}

async function summarizeOne($: $, hash: string) {
  const src = sources.get(hash)
  if (!src) return
  // 目录已经关了：还没开始写的都不写了
  if (!(await isOpen($))) {
    queue.length = 0
    return
  }
  await setSummary($, hash, { status: 'loading', text: '' })
  const text = await askSummary($, src.question, src.answer)
  await setSummary($, hash, text ? { status: 'done', text } : { status: 'error', text: '' })
  if (text) await remember($, hash, text)
}

async function askSummary($: $, question: string, answer: string): Promise<string> {
  const models: string[] = [...SUMMARY_MODELS]
  try {
    models.push(await $.session.model())
  } catch {
    // 拿不到当前模型，就只试上面几个
  }
  const prompt = summaryPrompt(question, answer)
  for (let i = Math.min(modelFrom, models.length - 1); i < models.length; i++) {
    try {
      const r = await $.model.complete({ model: models[i]!, prompt, effort: 'low', maxTokens: 300, timeoutMs: SUMMARY_TIMEOUT_MS })
      const text = r.isAnswered ? cleanSummary(r.text) : ''
      if (text) {
        modelFrom = i
        return text
      }
    } catch {
      // 这个模型用不了（比如账号没有权限），试下一个
    }
  }
  return ''
}

async function remember($: $, hash: string, text: string) {
  delete saved[hash]
  saved[hash] = text
  const keys = Object.keys(saved)
  for (const k of keys.slice(0, Math.max(0, keys.length - SAVED_MAX))) delete saved[k]
  try {
    await $.store.set(STORE_SUMMARIES, saved)
  } catch {
    // 存不住只影响下次会话，这次照样显示
  }
}

async function loadStore($: $) {
  try {
    const s = await $.store.get(STORE_SUMMARIES)
    if (s && typeof s === 'object' && !Array.isArray(s)) {
      saved = Object.fromEntries(Object.entries(s).filter(([, v]) => typeof v === 'string')) as Record<string, string>
    }
    const flag = await $.store.get(STORE_USE_MODEL)
    if (typeof flag === 'boolean') await update($, useModel, () => flag)
  } catch {
    // 读不到就用默认
  }
}

// ---------- 跳转 ----------

function explain(deny: string): string {
  if (/person-initiated/i.test(deny)) return '只有你自己点的时候才能跳转'
  if (/no-surface/i.test(deny)) return '现在没有可以跳转的界面'
  if (/moved meanwhile/i.test(deny)) return '对话刚好在滚动，再点一次'
  if (/nothing drawn/i.test(deny)) return '没找到这一轮在界面上的位置：可能被折叠了，或者压缩对话时去掉了'
  return `跳不过去（${deny}）。跳转只在全屏界面里有效：/tui fullscreen`
}

async function jump($: $, index: number, key: string, view: SiteView) {
  if (jumping) return
  jumping = true
  try {
    // 正在看子代理的对话：先回到主对话
    if (view.agentId !== undefined) {
      const back = await $.ui.view({})
      if (back.deny) {
        $.ui.toast(`回不到主对话：${back.deny}`)
        return
      }
    }
    // 重新切一遍目录：要知道每一轮在对话记录里的位置，也顺便查清回复、工具调用各在哪
    let msgs
    try {
      msgs = await $.session.messages()
    } catch {
      return
    }
    const list = splitTurns(msgs, isTurnRunning).slice(-TURNS_MAX)
    const toc = { keys: list.map(t => t.key), at: list.map(t => t.at) }
    const i = list[index]?.key === key ? index : toc.keys.indexOf(key)
    if (i < 0) return
    const places = placesOf(msgs)
    const io: JumpIO = {
      scroll: async (id, block) => (await $.ui.scroll({ to: { requestId: id }, block })).deny,
      sleep: ms => $.clock.sleep(ms),
      toast: text => $.ui.toast(text, { timeoutMs: 2000 }),
      debug: text => $.ui.log(text, { to: 'debug' }),
    }
    // 找到的那一行要是已经不在界面上了（比如压缩对话后），忘掉它，再找一次
    for (let attempt = 0; attempt < 2; attempt++) {
      const found = await locate(rows, toc, places, i, io)
      if ('miss' in found) {
        $.ui.toast(
          found.miss === 'far'
            ? '离得比较远，还没翻到这一轮。再点一次，接着往上找'
            : '没找到这一轮在界面上的位置：可能被折叠了，或者压缩对话时去掉了',
        )
        return
      }
      const deny = 'deny' in found ? found.deny : await reveal(rows, found.id, io)
      if (!deny) return
      if (!/nothing drawn/i.test(deny) || !('id' in found)) {
        $.ui.toast(explain(deny))
        return
      }
      rows.forget(found.id)
    }
  } finally {
    jumping = false
  }
}

// ---------- 命令 ----------

const USAGE = [
  '/index                打开或关闭对话目录',
  '/index summary on     摘要请 Claude 来写（默认，用 haiku，一轮写一次，写过的会记住）',
  '/index summary off    不请 Claude 写，摘要用回复的第一句',
].join('\n')

async function toggle($: $, isFullscreen: boolean): Promise<string> {
  const pane = (await $.ui.panes().catch(() => [])).find(p => p.id === PANE)
  if (pane?.isShown) {
    await $.ui.close({ id: PANE })
    queue.length = 0
    return '目录已关闭'
  }
  // 上次没写成的摘要，这次再试
  const sums = await read($, summaries)
  if (Object.values(sums).some(s => s.status === 'error')) {
    await update($, summaries, old => Object.fromEntries(Object.entries(old).filter(([, s]) => s.status !== 'error')))
  }
  await refresh($)
  const opened = await $.ui.open({ id: PANE, title: TITLE, columns: PANE_COLUMNS })
  // 停在最后几轮；之后新加的轮次也跟着显示出来
  void $.ui.scroll({ in: PANE, to: 'end' }).catch(() => undefined)
  await summarizeAll($)
  if (!opened.isPlaced) return `目录已打开，但还没显示出来：${opened.reason}`
  return isFullscreen ? '目录已打开，点一项就跳到那次提问' : '目录已打开。现在不是全屏界面，点击跳转用不了，可以先执行 /tui fullscreen'
}

async function command($: $, args: string, isFullscreen: boolean): Promise<string> {
  const [first = '', second = ''] = args.trim().split(/\s+/).filter(Boolean)
  if (!first) return toggle($, isFullscreen)
  if (first === 'summary' && (second === 'on' || second === 'off')) {
    const isOn = second === 'on'
    await update($, useModel, () => isOn)
    try {
      await $.store.set(STORE_USE_MODEL, isOn)
    } catch {
      // 存不住只影响下次会话
    }
    if (isOn && (await isOpen($))) await summarizeAll($)
    if (!isOn) queue.length = 0
    return isOn ? '摘要改由 Claude 来写（用 haiku，一轮写一次）' : '摘要不再请 Claude 写，改用回复的第一句'
  }
  return USAGE
}

// ---------- 画目录 ----------

function summaryOf(t: IxTurn, s: IxSummary | undefined, isLive: boolean, isOn: boolean): string {
  if (isLive) return '⋯ 回答中'
  if (!t.hash) return '（没有文字回复）'
  if (isOn && s?.status === 'done') return s.text
  if (isOn && s?.status === 'loading') return `⋯ ${t.head}`
  return t.head || '（没有文字回复）'
}

// ---------- 注册 ----------

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    // 重新加载后，正在写的摘要已经没人管了：改回没写过，打开目录时重写
    const sums = await read($, summaries)
    if (Object.values(sums).some(s => s.status === 'loading')) {
      await update($, summaries, old => Object.fromEntries(Object.entries(old).filter(([, s]) => s.status !== 'loading')))
    }
    await loadStore($)
    await $.command.register({
      name: 'index',
      description: '对话目录：在右侧打开或关闭本次会话的目录，点一项跳到那次提问',
      argumentHint: '[summary on|off]',
      immediate: true,
    })
    await refresh($)
    return started
  })

  // 主对话一轮开始、结束时更新目录（子代理的不算）。不等它更新完，免得拖慢对话
  on('turn.start', async ($, e, next) => {
    const started = await next(e)
    if (e.agentId === undefined) {
      if (e.text) rows.started(e.text, Date.now())
      isTurnRunning = true
      void refresh($)
    }
    return started
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId === undefined) {
      isTurnRunning = false
      void refresh($)
    }
    return done
  })

  // /clear 之后是新的对话：目录清空，记下的行也作废
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      rows.reset()
      queue.length = 0
      sources.clear()
      isTurnRunning = false
      await update($, turns, () => [])
      await update($, running, () => false)
    }
    return next(e)
  })

  // presentation 是引擎填的；没填（比如测试里）就当是全屏
  on('command.run', { command: 'index' }, async ($, e) => ({ text: await command($, e.args, e.presentation?.isFullscreen !== false) }))

  // 记下界面画过的行：提问行用来对号，回复和工具调用的行在往上翻找时当落脚点
  on('ui.render', { component: 'UserMessage' }, ($, e, next) => {
    rows.user(e.requestId, e.props.text, e.props.onScreen, Date.now())
    return next(e)
  })

  on('ui.render', { component: 'AssistantMessage' }, ($, e, next) => {
    rows.other(e.requestId, [keyOf(e.props.text)], e.props.onScreen, Date.now())
    return next(e)
  })

  // 工具调用那一行的 id 就是 tool_use_id；折起来的一组按组里的调用
  on('ui.render', { component: 'ToolUse' }, ($, e, next) => {
    rows.other(e.requestId, [e.requestId], e.props.onScreen, Date.now())
    return next(e)
  })

  on('ui.render', { component: 'ToolGroup' }, ($, e, next) => {
    const ids = e.props.calls.flatMap(c => (c.tool_use_id ? [c.tool_use_id] : []))
    rows.other(e.requestId, ids, e.props.onScreen, Date.now())
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const list = await read($, turns)
    const sums = await read($, summaries)
    const isRunning = await read($, running)
    const isOn = await read($, useModel)
    const width = Math.max(16, e.props.bodyColumns)
    const view = e.props.view
    const numWidth = String(list.length).length
    const indent = ' '.repeat(numWidth + 1)
    // 不在全屏界面时目录放在输入框上方，点击和翻动对话都用不了
    const isDocked = e.props.placement === 'dock'
    const header = !list.length ? '还没有对话' : isDocked ? `共 ${list.length} 轮 · 点一项跳到那次提问` : `共 ${list.length} 轮`
    return (
      <Box flexDirection="column">
        <Text dimColor>{fit(header, width)}</Text>
        {!isDocked && <Text dimColor>{fit('全屏界面（/tui fullscreen）里才能点击跳转', width)}</Text>}
        {list.map((t, i) => {
          const text = summaryOf(t, sums[t.hash], isRunning && i === list.length - 1, isOn)
          const lines = wrapLines(text, width - indent.length, SUMMARY_LINES)
          return (
            <Box key={`row-${i}`} flexDirection="column" marginTop={1}>
              <Button key={`turn-${i}`} plain onPress={() => jump($, i, t.key, view)}>
                <Text dimColor hover={HOVER}>
                  {`${String(i + 1).padStart(numWidth)} `}
                </Text>
                <Text weight="bold" hover={HOVER}>
                  {fit(t.prompt, width - indent.length)}
                </Text>
                {lines.map(line => [
                  '\n',
                  <Text dimColor hover={HOVER}>
                    {indent + line}
                  </Text>,
                ])}
              </Button>
            </Box>
          )
        })}
      </Box>
    )
  })
}
