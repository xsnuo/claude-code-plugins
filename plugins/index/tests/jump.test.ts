import { expect, test } from 'claude-code/testing'

import { WALK_BUDGET_MS, locate, reveal } from '../hooks/jump'
import type { JumpIO, Toc } from '../hooks/jump'
import { Rows } from '../hooks/rows'
import { keyOf } from '../hooks/turns'
import type { Places } from '../hooks/turns'

// 测试工具里翻不动对话（$.ui.scroll 翻对话这一步没有可以扮演的钩子），所以这里自己做一个“全屏界面”：
// 一列有高度的行，屏幕是其中 view 行高的一段，屏幕上下各多画 overscan 行。
// 每翻一次，就像真界面一样把新进入范围的行画出来（告诉 Rows），并报一下每一行露出了多少。

// user 是提问行；other 是回复或工具调用的行，marked 时能在对话记录里查到位置
type Line = { id: string; kind: 'user' | 'other'; text?: string; height: number; marked?: boolean }

class Screen {
  top: number
  private ys: number[] = []
  private now = 0
  scrolls: [string, 'start' | 'end'][] = []
  slept = 0

  constructor(
    private lines: Line[],
    private rows: Rows,
    private view = 20,
    private overscan = 10,
    private reverse = false,
  ) {
    let y = 0
    for (const l of lines) {
      this.ys.push(y)
      y += l.height
    }
    this.top = Math.max(0, y - view)
    this.draw()
  }

  private get total(): number {
    return this.lines.reduce((n, l) => n + l.height, 0)
  }

  private onScreen(i: number) {
    const y = this.ys[i]!
    const h = this.lines[i]!.height
    const first = Math.max(0, this.top - y)
    const last = Math.min(h - 1, this.top + this.view - 1 - y)
    return last < first ? null : { first, last, of: h }
  }

  // 画出屏幕和上下预画范围里的行；reverse 时一批里从下往上告诉 Rows
  private draw() {
    this.now += 100 // 每批之间隔一段时间，像真界面那样
    const batch: number[] = []
    this.lines.forEach((l, i) => {
      const y = this.ys[i]!
      if (y + l.height > this.top - this.overscan && y < this.top + this.view + this.overscan) batch.push(i)
    })
    if (this.reverse) batch.reverse()
    for (const i of batch) {
      const l = this.lines[i]!
      if (l.kind === 'user') this.rows.user(l.id, l.text!, this.onScreen(i), this.now)
      else this.rows.other(l.id, l.marked === false ? [] : [l.id], this.onScreen(i), this.now)
    }
  }

  topLine(): string {
    return this.lines.find((l, i) => this.ys[i]! <= this.top && this.top < this.ys[i]! + l.height)!.id
  }

  toc(extra?: string): Toc {
    const at: number[] = []
    const keys: string[] = []
    if (extra) {
      keys.push(keyOf(extra))
      at.push(-1)
    }
    this.lines.forEach((l, i) => {
      if (l.kind !== 'user') return
      keys.push(keyOf(l.text!))
      at.push(i)
    })
    return { keys, at }
  }

  places(): Places {
    const tools = new Map<string, number>()
    this.lines.forEach((l, i) => l.kind === 'other' && tools.set(l.id, i))
    return { tools, texts: new Map() }
  }

  io(): JumpIO {
    return {
      scroll: async (id, block) => {
        this.scrolls.push([id, block])
        const i = this.lines.findIndex(l => l.id === id)
        if (i < 0) return 'nothing drawn under that requestId'
        const y = this.ys[i]!
        const h = this.lines[i]!.height
        const at = block === 'start' || h > this.view ? y : y + h - this.view
        this.top = Math.max(0, Math.min(at, this.total - this.view))
        this.draw()
        return undefined
      },
      sleep: async ms => {
        this.slept += ms
      },
      toast: () => undefined,
    }
  }
}

// n 轮对话：每轮一行提问（高 2）、tools 行工具调用（各高 toolHeight）、一段回复（高 answer）
function talk(n: number, answer: number, opts: { tools?: number; toolHeight?: number; prompt?: (i: number) => string } = {}): Line[] {
  const out: Line[] = []
  for (let i = 0; i < n; i++) {
    out.push({ id: `p${i}`, kind: 'user', text: opts.prompt?.(i) ?? `第 ${i + 1} 个问题`, height: 2 })
    for (let j = 0; j < (opts.tools ?? 0); j++) out.push({ id: `t${i}-${j}`, kind: 'other', height: opts.toolHeight ?? 3 })
    out.push({ id: `a${i}`, kind: 'other', height: answer })
  }
  return out
}

// 跳到第 target 轮；离得太远一次没翻到时，像用户那样再点一次（最多 tries 次）
async function jumpTo(screen: Screen, rows: Rows, target: number, tries = 1) {
  const io = screen.io()
  for (let i = 0; i < tries; i++) {
    const found = await locate(rows, screen.toc(), screen.places(), target, io)
    if ('id' in found) {
      expect(await reveal(rows, found.id, io)).toBeUndefined()
      return found.id
    }
    if (!('miss' in found) || found.miss !== 'far') return undefined
  }
  return undefined
}

test('a prompt already drawn is revealed at once', async () => {
  const rows = new Rows()
  const screen = new Screen(talk(4, 10), rows)
  expect(await jumpTo(screen, rows, 2)).toBe('p2')
  expect(screen.scrolls).toEqual([['p2', 'start']])
  expect(screen.topLine()).toBe('p2')
})

test('a prompt far above is found by walking up, whatever the turns look like', async () => {
  const shapes = [
    { n: 40, answer: 3 }, // 很多短的轮
    { n: 12, answer: 45 }, // 回复比一屏还长
    { n: 8, answer: 120 }, // 最后一次提问都没画出来
    { n: 6, answer: 4, tools: 30 }, // 一轮里一长串工具调用
  ]
  for (const shape of shapes) {
    for (const reverse of [false, true]) {
      const rows = new Rows()
      const screen = new Screen(talk(shape.n, shape.answer, shape), rows, 20, 10, reverse)
      expect(await jumpTo(screen, rows, 0)).toBe('p0')
      expect(screen.slept).toBeLessThan(WALK_BUDGET_MS)
      expect(screen.topLine()).toBe('p0')
      // 翻过一遍以后，中间那些轮都认得了，再跳不用再找
      const middle = Math.floor(shape.n / 2)
      const before = screen.scrolls.length
      expect(await jumpTo(screen, rows, middle)).toBe(`p${middle}`)
      expect(screen.scrolls.length - before).toBeLessThanOrEqual(3)
    }
  }
})

test('very far away: one click walks as far as it may, the next click carries on', async () => {
  // 每轮十个带着很长 diff 的工具调用：每一步只能往上翻一行
  const rows = new Rows()
  const screen = new Screen(talk(6, 4, { tools: 10, toolHeight: 40 }), rows)
  const first = await locate(rows, screen.toc(), screen.places(), 0, screen.io())
  expect(first).toEqual({ miss: 'far' })
  expect(await jumpTo(screen, rows, 0, 2)).toBe('p0')
})

test('replies whose place is unknown are stepped over by the tool calls around them', async () => {
  const rows = new Rows()
  const lines = talk(8, 25, { tools: 4 }).map(l => (l.id.startsWith('a') ? { ...l, marked: false } : l))
  const screen = new Screen(lines, rows)
  expect(await jumpTo(screen, rows, 0)).toBe('p0')
})

test('repeated prompts are told apart by their order', async () => {
  const rows = new Rows()
  const screen = new Screen(talk(12, 30, { prompt: i => (i % 3 === 2 ? '继续' : `问题 ${i}`) }), rows)
  expect(await jumpTo(screen, rows, 2)).toBe('p2') // 第一次“继续”
  expect(await jumpTo(screen, rows, 5)).toBe('p5')
  expect(await jumpTo(screen, rows, 11)).toBe('p11') // 最后一次
})

test('a prompt that is not on screen at all gives up instead of looping', async () => {
  const rows = new Rows()
  const screen = new Screen(talk(5, 30), rows)
  // 目录里多出一轮界面上没有的（比如压缩对话时去掉了）：第一次翻到顶停下，再点一次一步也走不动，就说找不到
  const toc = screen.toc('早就不在了')
  expect(await locate(rows, toc, screen.places(), 0, screen.io())).toEqual({ miss: 'far' })
  expect(screen.slept).toBeLessThan(WALK_BUDGET_MS)
  expect(await locate(rows, toc, screen.places(), 0, screen.io())).toEqual({ miss: 'gone' })
})

test('a refused scroll stops the walk and is passed on by reveal', async () => {
  const rows = new Rows()
  const screen = new Screen(talk(10, 30), rows)
  const refuse: JumpIO = { ...screen.io(), scroll: async () => 'not person-initiated' }
  expect(await locate(rows, screen.toc(), screen.places(), 0, refuse)).toEqual({ deny: 'not person-initiated' })
  expect(await reveal(rows, 'p9', refuse)).toBe('not person-initiated')
})
