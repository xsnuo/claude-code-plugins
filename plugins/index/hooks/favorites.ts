// 收藏的纯逻辑，不碰 $：把收藏和目录里的轮次对上号、收藏时缓存哪些内容、存进 $.store 的样子。
//
// 一条收藏缓存着那一轮的提问、回答原文和摘要，压缩对话后目录里没有这一轮了也还在；
// 记着界面上那一行提问的 id（知道了的话），点它直接跳，不用再往上翻找。
// 收藏只属于当前这段对话：/clear 之后清空。

import type { IxFavorite } from '../types'

// 每段对话最多收藏多少条；缓存的提问、回答最多多少字
export const FAVORITES_MAX = 30
const PROMPT_CACHE = 2000
const ANSWER_CACHE = 3000
// $.store 里最多留几段对话的收藏（按最后改动的时间，旧的丢掉）
const SESSIONS_MAX = 10

type TurnLike = { key: string; hash: string }

// 同样 key 的轮次里，第 i 轮是第几次（从 0 数）
export function nthOf(turns: readonly TurnLike[], i: number): number {
  let n = 0
  for (let j = 0; j < i; j++) if (turns[j]!.key === turns[i]!.key) n++
  return n
}

// 目录第几项是第几条收藏：有回答的按 key 和回答的 hash 认；收藏时还在回答的（hash 为空）按 key 和第几次认
export function matchFavorites(turns: readonly TurnLike[], favs: readonly IxFavorite[]): Map<number, number> {
  const out = new Map<number, number>()
  const taken = new Set<number>()
  favs.forEach((f, j) => {
    const i = turns.findIndex((t, i) => !taken.has(i) && t.key === f.key && (f.hash ? t.hash === f.hash : nthOf(turns, i) === f.nth))
    if (i < 0) return
    taken.add(i)
    out.set(i, j)
  })
  return out
}

// 收藏一轮时存下的内容。isLive：这一轮还在回答，回答还不算数，等答完再补上
export function favoriteOf(
  turn: { key: string; hash: string; prompt: string; head: string },
  nth: number,
  full: { question: string; answer: string } | undefined,
  summary: string,
  isLive: boolean,
  id: string | undefined,
): IxFavorite {
  const fav: IxFavorite = {
    key: turn.key,
    hash: isLive ? '' : turn.hash,
    nth,
    prompt: (full?.question ?? turn.prompt).slice(0, PROMPT_CACHE),
    answer: isLive ? '' : (full?.answer ?? '').slice(0, ANSWER_CACHE),
    head: isLive ? '' : turn.head,
    summary: isLive ? '' : summary,
  }
  if (id) fav.id = id
  return fav
}

// 收藏时还在回答的那一轮答完了：补上回答
export function completed(fav: IxFavorite, turn: { hash: string; head: string }, full: { question: string; answer: string } | undefined): IxFavorite {
  return {
    ...fav,
    hash: turn.hash,
    head: turn.head,
    prompt: (full?.question ?? fav.prompt).slice(0, PROMPT_CACHE),
    answer: (full?.answer ?? '').slice(0, ANSWER_CACHE),
  }
}

// 复制到剪贴板的样子
export function clipText(fav: IxFavorite): string {
  return fav.answer ? `${fav.prompt}\n\n${fav.answer}` : fav.prompt
}

// $.store 里的收藏：会话 id → 这段对话的收藏和最后改动的时间
export type SavedFavorites = Record<string, { at: number; items: IxFavorite[] }>

function isFavorite(x: unknown): x is IxFavorite {
  if (!x || typeof x !== 'object') return false
  const f = x as Record<string, unknown>
  return (
    typeof f.key === 'string' &&
    typeof f.hash === 'string' &&
    typeof f.nth === 'number' &&
    typeof f.prompt === 'string' &&
    typeof f.answer === 'string' &&
    typeof f.head === 'string' &&
    typeof f.summary === 'string' &&
    (f.id === undefined || typeof f.id === 'string')
  )
}

// 读 $.store 里存的：认不出的丢掉
export function readSaved(raw: unknown): SavedFavorites {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: SavedFavorites = {}
  for (const [sid, v] of Object.entries(raw)) {
    const o = v as { at?: unknown; items?: unknown }
    if (!o || typeof o.at !== 'number' || !Array.isArray(o.items)) continue
    out[sid] = { at: o.at, items: o.items.filter(isFavorite).slice(0, FAVORITES_MAX) }
  }
  return out
}

// 写回一段对话的收藏（没有收藏就删掉这一段），只留最近改过的几段
export function withSession(all: SavedFavorites, sid: string, items: readonly IxFavorite[], now: number): SavedFavorites {
  const out: SavedFavorites = { ...all }
  if (items.length) out[sid] = { at: now, items: [...items] }
  else delete out[sid]
  const keep = Object.entries(out)
    .sort(([, a], [, b]) => b.at - a.at)
    .slice(0, SESSIONS_MAX)
  return Object.fromEntries(keep)
}
