// 记下界面上画过的对话行，不碰 $。
//
// 插件接口给的对话记录（$.session.messages）没有每条消息的 id，跳转却要用 id（$.ui.scroll 的 requestId）。
// 界面每画一行，ui.render 都会带上这一行的 id，这里把它们记下来：
// - 提问行带着文字，按文字和目录对上号；
// - 回复行带着文字、工具调用行带着 tool_use_id（marks），能在对话记录里找到它在哪一轮，往上翻找时当落脚点。
//
// 文字相同的提问（比如两次“继续”）要靠先后分清，所以提问行还要自己排先后。全屏界面只画屏幕附近的行，往上翻才画更早的：
// - 刚发出的提问接在最后。认法：它先以 'placeholder' 的 id 画一次再换成真 id，或者这一轮开始时（turn.start）带着同样的文字；
// - 其他第一次见到的提问都比已经见过的早（往上翻才会出现），放在最前面；
//   同一批画出来的（相隔不到 BATCH_MS）按画出来的先后排。
// 排错了只会影响文字相同的那几轮，别的目录项按文字直接对上。

import { keyOf } from './turns'
import type { Known } from './turns'

export type OnScreen = { first: number; last: number; of: number }

const BATCH_MS = 30
const PLACEHOLDER = 'placeholder'
// 发出提问、画出那一行、这一轮开始，这几件事最多相隔多久
const FRESH_MS = 10000

export class Rows {
  // 提问行，按在对话里的先后
  order: Known[] = []
  // 回复、工具调用这些行：id → 用来在对话记录里找位置的 marks
  private marks = new Map<string, readonly string[]>()
  private seen = new Map<string, number>()
  private onScreen = new Map<string, OnScreen | null>()
  private fresh: { key: string; at: number } | undefined
  private batch = { at: -Infinity, pos: -1 }

  // 画了一行提问
  user(id: string, text: string, onScreen: OnScreen | null | undefined, now: number) {
    if (id === PLACEHOLDER) {
      this.fresh = { key: keyOf(text), at: now }
      return
    }
    if (onScreen !== undefined) this.onScreen.set(id, onScreen)
    if (this.seen.has(id)) return
    this.seen.set(id, now)
    const row = { id, key: keyOf(text) }
    if (this.fresh && this.fresh.key === row.key && now - this.fresh.at <= FRESH_MS) {
      this.fresh = undefined
      this.order.push(row)
      return
    }
    if (now - this.batch.at <= BATCH_MS && this.batch.pos >= 0 && this.batch.pos < this.order.length) {
      this.batch.pos++
      this.order.splice(this.batch.pos, 0, row)
    } else {
      this.batch.pos = 0
      this.order.unshift(row)
    }
    this.batch.at = now
  }

  // 画了一段回复或一行工具调用
  other(id: string, marks: readonly string[], onScreen: OnScreen | null | undefined, now: number) {
    if (onScreen !== undefined) this.onScreen.set(id, onScreen)
    if (this.seen.has(id)) return
    this.seen.set(id, now)
    if (marks.length) this.marks.set(id, marks)
  }

  // 一轮开始了，提问是 text：那一行已经画过（刚画的）就挪到最后，还没画就等它画出来时接在最后
  started(text: string, now: number) {
    const key = keyOf(text)
    const i = this.order.findLastIndex(r => r.key === key && now - (this.seen.get(r.id) ?? -Infinity) <= FRESH_MS)
    if (i < 0) {
      this.fresh = { key, at: now }
      return
    }
    const [row] = this.order.splice(i, 1)
    this.order.push(row!)
    if (this.fresh?.key === key) this.fresh = undefined
  }

  // 到目前为止一共见过多少行：往上翻找时用来判断界面画完了没有
  get size(): number {
    return this.seen.size
  }

  // 回复、工具调用这些行和它们的 marks
  marked(): IterableIterator<[string, readonly string[]]> {
    return this.marks.entries()
  }

  // 这一行的顶上在不在屏幕里；不知道时返回 undefined
  isTopShown(id: string): boolean | undefined {
    const at = this.onScreen.get(id)
    return at === undefined ? undefined : at !== null && at.first === 0
  }

  // 这一行已经不在界面上了（比如压缩以后）
  forget(id: string) {
    this.order = this.order.filter(r => r.id !== id)
    this.marks.delete(id)
    this.seen.delete(id)
    this.onScreen.delete(id)
  }

  reset() {
    this.order = []
    this.marks.clear()
    this.seen.clear()
    this.onScreen.clear()
    this.fresh = undefined
    this.batch = { at: -Infinity, pos: -1 }
  }
}
