import { expect, test } from 'claude-code/testing'

// 测试里没有真引擎：engine() 注册的钩子扮演引擎——一个内存里的文件系统、环境变量和会话 id。
// 会话进程把标题刷回状态文件的行为，用 fightBack 模拟：写入后的前几次读，读到的是旧标题。

type World = {
  files: Map<string, string>
  env: Record<string, string>
  sid: string
  writes: string[]
  fightBack?: { times: number; name: string }
}

function world(env: Record<string, string> = { HOME: '/home/me' }, sid = 'sid-1'): World {
  return { files: new Map(), env, sid, writes: [] }
}

function put(w: World, path: string, data: object) {
  w.files.set(path, JSON.stringify(data))
}

function name(w: World, path: string): unknown {
  return JSON.parse(w.files.get(path)!).name
}

function engine(on: any, w: World) {
  on('env.get', ($: any, e: any) => ({ value: w.env[e.name] }))
  on('session.id', () => ({ value: w.sid }))
  on('clock.sleep', () => ({ value: undefined }))
  on('fs.exists', ($: any, e: any) => ({ value: w.files.has(e.path) || [...w.files.keys()].some(p => p.startsWith(`${e.path}/`)) }))
  on('fs.read', ($: any, e: any) => {
    const text = w.files.get(e.path)
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`)
    if (w.fightBack && w.fightBack.times > 0 && w.writes.includes(e.path)) {
      w.fightBack.times--
      return { value: JSON.stringify({ ...JSON.parse(text), name: w.fightBack.name }) }
    }
    return { value: text }
  })
  on('fs.write', ($: any, e: any) => {
    w.files.set(e.path, e.text)
    w.writes.push(e.path)
    return { value: undefined }
  })
  on('fs.list', ($: any, e: any) => {
    const prefix = `${e.path}/`
    const names = new Map<string, 'file' | 'dir'>()
    for (const p of w.files.keys()) {
      if (!p.startsWith(prefix)) continue
      const rest = p.slice(prefix.length)
      const cut = rest.indexOf('/')
      names.set(cut < 0 ? rest : rest.slice(0, cut), cut < 0 ? 'file' : 'dir')
    }
    if (!names.size) throw new Error(`ENOENT: ${e.path}`)
    return { value: [...names].map(([name, kind]) => ({ name, kind, size: 0, mtimeMs: 0, isLink: false })) }
  })
  on('command.register', () => ({ value: undefined }))
}

const tag = ($: any, args = '') => $.command.run({ command: 'tag', args } as any)

test('a background session: the light goes into jobs/<id>/state.json', async ($, on) => {
  const w = world()
  put(w, '/home/me/.claude/sessions/111.json', { sessionId: 'other', jobId: 'job-x' })
  put(w, '/home/me/.claude/sessions/222.json', { sessionId: 'sid-1', jobId: 'job-1', name: 'ignored here' })
  put(w, '/home/me/.claude/jobs/job-1/state.json', { name: '我的会话', nameSource: 'auto', sessionId: 'sid-1' })
  engine(on, w)
  expect((await tag($)).text).toBe('点灯 ⚪ 白 · ⚪ 我的会话')
  const state = JSON.parse(w.files.get('/home/me/.claude/jobs/job-1/state.json')!)
  expect(state).toEqual({ name: '⚪ 我的会话', nameSource: 'user', sessionId: 'sid-1' }) // 别的字段原样留着
  expect((await tag($, '绿')).text).toBe('⚪ 白 → 🟢 绿 · 🟢 我的会话')
  expect((await tag($, '?')).text).toContain('无 ⚪ 🔴 🟡 [🟢] ⚫  标题：🟢 我的会话')
  expect(w.writes).toHaveLength(2) // 查询不写
})

test('a plain session: the light goes into sessions/<pid>.json', async ($, on) => {
  const w = world()
  put(w, '/home/me/.claude/sessions/333.json', { sessionId: 'sid-1', name: '旧名字' })
  engine(on, w)
  expect((await tag($, '🟡 新名字')).text).toBe('改名 + 点灯 🟡 黄 · 旧名字 → 🟡 新名字')
  expect(name(w, '/home/me/.claude/sessions/333.json')).toBe('🟡 新名字')
  expect(JSON.parse(w.files.get('/home/me/.claude/sessions/333.json')!).nameSource).toBeUndefined()
})

test('Windows: the config folder is under USERPROFILE, and CLAUDE_CONFIG_DIR wins over both', async ($, on) => {
  // 测试跑在 macOS 上，引擎会把不像绝对路径的 C:\\ 接到工作目录后面，所以这里用斜杠写法代替盘符
  const w = world({ OS: 'Windows_NT', USERPROFILE: '/win/Users/me/', HOME: '/c/Users/me' })
  put(w, '/win/Users/me/.claude/sessions/9.json', { sessionId: 'sid-1', name: '会话' })
  engine(on, w)
  expect((await tag($)).text).toBe('点灯 ⚪ 白 · ⚪ 会话')
  w.env.CLAUDE_CONFIG_DIR = '/data/claude/'
  put(w, '/data/claude/sessions/9.json', { sessionId: 'sid-1', name: '另一个' })
  expect((await tag($)).text).toBe('点灯 ⚪ 白 · ⚪ 另一个')
})

test('when the session writes its old title back, the light is written again', async ($, on) => {
  const w = world()
  put(w, '/home/me/.claude/sessions/1.json', { sessionId: 'sid-1', name: '会话' })
  engine(on, w)
  w.fightBack = { times: 1, name: '会话' }
  expect((await tag($, '红')).text).toBe('点灯 🔴 红 · 🔴 会话')
  expect(w.writes).toHaveLength(2)
  w.fightBack = { times: 99, name: '🔴 会话' }
  expect((await tag($, '黄')).text).toContain('灯可能没写住')
})

test('a nested session must not light its parent through CLAUDE_JOB_DIR', async ($, on) => {
  const w = world({ HOME: '/home/me', CLAUDE_JOB_DIR: '/home/me/.claude/jobs/parent' })
  put(w, '/home/me/.claude/jobs/parent/state.json', { name: '父会话', sessionId: 'parent-sid' })
  engine(on, w)
  expect((await tag($)).text).toContain('拒绝写入')
  expect(w.writes).toEqual([])
  w.sid = 'parent-sid' // 真是这个会话：照写
  expect((await tag($)).text).toBe('点灯 ⚪ 白 · ⚪ 父会话')
})

test('no title yet: it falls back to the last /rename in the transcript, else asks for a name', async ($, on) => {
  const w = world()
  put(w, '/home/me/.claude/sessions/5.json', { sessionId: 'sid-1' })
  engine(on, w)
  expect((await tag($, '黄')).text).toContain('还没有标题')
  w.files.set(
    '/home/me/.claude/projects/-home-me-proj/sid-1.jsonl',
    [
      JSON.stringify({ type: 'user', message: 'hi' }),
      JSON.stringify({ type: 'custom-title', customTitle: '第一个名字' }),
      '{"type":"custom-title", 半行',
      JSON.stringify({ type: 'custom-title', customTitle: '记录里的名字' }),
    ].join('\n'),
  )
  expect((await tag($, '黄')).text).toBe('点灯 🟡 黄 · 🟡 记录里的名字')
  expect(name(w, '/home/me/.claude/sessions/5.json')).toBe('🟡 记录里的名字')
})

test('outside a known session it says so instead of failing', async ($, on) => {
  const w = world()
  engine(on, w)
  expect((await tag($, '新名字')).text).toBe('定位不到当前会话的状态文件，灯没点上——状态灯只能在 Claude Code 会话内使用')
})
