import type { EngineInterface, FsEntry, Register } from 'claude-code'

import { planTag } from './core'

// tag：/tag 在会话标题最前面放一盏状态灯（⚪🔴🟡🟢⚫）。
//
// 命令由插件自己回答，不经过模型。标题写进 Claude Code 的会话状态文件，改的是里面的 name：
// 后台会话是 <配置目录>/jobs/<jobId>/state.json，其他会话是 <配置目录>/sessions/<pid>.json。
// 这是 Claude Code 未公开的内部结构，升级后可能失效。
// 读写文件都走插件接口，不用 Python，也不调系统命令，所以 macOS、Windows、Linux 是同一套代码。

type $ = EngineInterface
type Json = Record<string, unknown>
type Target = { path: string; kind: 'job' | 'session' } | { path?: undefined; kind: 'mismatch' | 'none' }

// Claude Code 的配置目录：设了 CLAUDE_CONFIG_DIR 就用它，否则是用户目录下的 .claude
async function configDir($: $): Promise<string | undefined> {
  const custom = await $.env.get('CLAUDE_CONFIG_DIR')
  if (custom) return custom.replace(/[\\/]+$/, '')
  // Windows 上 HOME 可能是 Git Bash 的写法（/c/Users/...），所以先用 USERPROFILE
  const isWindows = (await $.env.get('OS')) === 'Windows_NT'
  const home = isWindows
    ? (await $.env.get('USERPROFILE')) || (await $.env.get('HOME'))
    : (await $.env.get('HOME')) || (await $.env.get('USERPROFILE'))
  return home ? `${home.replace(/[\\/]+$/, '')}/.claude` : undefined
}

async function peek($: $, path: string): Promise<Json | undefined> {
  try {
    const d: unknown = JSON.parse(await $.fs.read(path))
    return d && typeof d === 'object' && !Array.isArray(d) ? (d as Json) : undefined
  } catch {
    return undefined
  }
}

// 会话进程会高频重写状态文件，读到半截 JSON 就隔一会儿再读，最多 4 次
async function load($: $, path: string): Promise<Json> {
  let reason = ''
  for (let i = 0; i < 4; i++) {
    let text: string
    try {
      text = await $.fs.read(path)
    } catch (err) {
      throw new Error(`读不到会话状态文件：${(err as Error).message}`)
    }
    try {
      const d: unknown = JSON.parse(text)
      if (d && typeof d === 'object' && !Array.isArray(d)) return d as Json
      reason = '不是 JSON 对象'
    } catch (err) {
      reason = (err as Error).message
    }
    await $.clock.sleep(60)
  }
  throw new Error(`会话状态文件正在被写入，重试 4 次仍失败（${reason}），稍后再试`)
}

// 找当前会话的状态文件：先按 session id 在 sessions/ 里找，再看 CLAUDE_JOB_DIR
async function findStateFile($: $, dir: string | undefined, sid: string): Promise<Target> {
  if (dir && sid) {
    let entries: FsEntry[] = []
    try {
      entries = await $.fs.list(`${dir}/sessions`)
    } catch {
      entries = []
    }
    const names = entries.filter(e => e.kind === 'file' && e.name.endsWith('.json')).map(e => e.name).sort()
    for (const name of names) {
      const d = await peek($, `${dir}/sessions/${name}`)
      if (d?.sessionId !== sid) continue
      if (typeof d.jobId === 'string' && d.jobId) {
        const job = `${dir}/jobs/${d.jobId}/state.json`
        if (await $.fs.exists(job)) return { path: job, kind: 'job' }
      }
      return { path: `${dir}/sessions/${name}`, kind: 'session' }
    }
  }
  // 嵌套会话（在会话里再起一个 claude）会继承父进程的 CLAUDE_JOB_DIR，只认它会把灯打到父会话头上，所以要核对 session id
  const jobDir = await $.env.get('CLAUDE_JOB_DIR')
  if (jobDir) {
    const job = `${jobDir.replace(/[\\/]+$/, '')}/state.json`
    if (await $.fs.exists(job)) {
      if (sid) {
        const d = (await peek($, job)) ?? {}
        if (sid !== d.sessionId && sid !== d.resumeSessionId) return { kind: 'mismatch' }
      }
      return { path: job, kind: 'job' }
    }
  }
  return { kind: 'none' }
}

// 状态文件里还没有标题时，退而从对话记录里找最后一条 custom-title（/rename 留下的，底部 HUD 读的就是它）
async function titleFromTranscript($: $, dir: string, sid: string): Promise<string> {
  let projects: FsEntry[] = []
  try {
    projects = await $.fs.list(`${dir}/projects`)
  } catch {
    return ''
  }
  for (const project of projects) {
    if (project.kind !== 'dir') continue
    const file = `${dir}/projects/${project.name}/${sid}.jsonl`
    if (!(await $.fs.exists(file))) continue
    let text: string
    try {
      text = await $.fs.read(file) // 超过 4 MiB 的读不了，就当没有标题
    } catch {
      return ''
    }
    let title = ''
    for (const line of text.split('\n')) {
      if (!line.includes('"custom-title"')) continue
      try {
        const d = JSON.parse(line) as Json
        if (d.type === 'custom-title' && typeof d.customTitle === 'string') title = d.customTitle
      } catch {
        // 半行，跳过
      }
    }
    return title
  }
  return ''
}

async function writeName($: $, path: string, kind: 'job' | 'session', name: string) {
  const d = await load($, path) // 写前再读一次，尽量贴近会话进程的最新状态
  d.name = name
  if (kind === 'job') d.nameSource = 'user'
  await $.fs.write(path, JSON.stringify(d, null, 2))
}

// 会话进程会周期性把自己内存里的标题刷回状态文件，连按时可能把刚写的名字顶掉。
// 校验一下，被顶掉就再写，最多补三次。写住了返回 true
async function applyName($: $, path: string, kind: 'job' | 'session', name: string): Promise<boolean> {
  await writeName($, path, kind, name)
  for (let i = 0; i < 3; i++) {
    await $.clock.sleep(120)
    try {
      if ((await load($, path)).name === name) return true
    } catch {
      return false
    }
    await writeName($, path, kind, name)
  }
  return false
}

async function tag($: $, args: string): Promise<string> {
  const dir = await configDir($)
  const sid = await $.session.id()
  const target = await findStateFile($, dir, sid)
  if (target.kind === 'mismatch') {
    return '当前进程的 session 与 CLAUDE_JOB_DIR 指向的会话不一致，拒绝写入——看起来是在别的会话里嵌套启动的，请在目标会话内直接用 /tag'
  }
  let title = ''
  if (target.path) {
    try {
      const name = (await load($, target.path)).name
      title = typeof name === 'string' ? name : ''
    } catch {
      title = ''
    }
  }
  if (!title && dir && sid) title = await titleFromTranscript($, dir, sid)

  // 标题取不到就是空串，交给 planTag 处理（它会要求先起名字）
  const plan = planTag(title, args)
  if ('err' in plan) return plan.err
  // ? 查询、或目标就是当前状态：不用写
  if (plan.name === null) return plan.msg

  if (!target.path) return '定位不到当前会话的状态文件，灯没点上——状态灯只能在 Claude Code 会话内使用'
  if (!(await applyName($, target.path, target.kind, plan.name))) return `灯可能没写住（会话进程正在改标题），再来一次：${plan.msg}`
  return plan.msg
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: 'tag',
      description: '会话状态灯与改名：轮换 / 指定灯色 / 摘灯 / 保留灯改名（列表和 HUD 同时生效）',
      argumentHint: '[0-5 | 白|红|黄|绿|黑 | 无 | 新名字 | ?]',
      immediate: true,
    })
    return started
  })

  on('command.run', { command: 'tag' }, async ($, e) => {
    try {
      return { text: await tag($, e.args) }
    } catch (err) {
      return { text: `灯没点上：${(err as Error).message}` }
    }
  })
}
