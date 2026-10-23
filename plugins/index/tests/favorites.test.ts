import { expect, test } from 'claude-code/testing'

import { clipText, completed, favoriteOf, matchFavorites, nthOf, readSaved, withSession } from '../hooks/favorites'
import { fitCount, lastTop, scrolled } from '../hooks/layout'
import type { IxFavorite } from '../types'

const turn = (key: string, hash: string) => ({ key, hash, prompt: key, head: `${key}的第一句` })
const fav = (key: string, hash: string, nth = 0): IxFavorite => ({ key, hash, nth, prompt: key, answer: '', head: '', summary: '' })

test('favorites find their turn by text and answer; one starred while answering by which time the text came', async () => {
  const list = [turn('继续', 'h1'), turn('问A', 'h2'), turn('继续', 'h3'), turn('继续', '')]
  expect(nthOf(list, 3)).toBe(2)
  const m = matchFavorites(list, [fav('继续', 'h3'), fav('问A', 'h2'), fav('继续', '', 2), fav('不在了', 'h9')])
  expect([...m]).toEqual([
    [2, 0],
    [1, 1],
    [3, 2],
  ])
  // 同一轮不会被两条收藏认领
  expect([...matchFavorites(list, [fav('继续', 'h1'), fav('继续', 'h1')])]).toEqual([[0, 0]])
})

test('a favorite caches the prompt and answer; one still being answered waits for its answer', async () => {
  const full = { question: '完整的提问'.repeat(10), answer: '回答'.repeat(2000) }
  const done = favoriteOf(turn('问A', 'h2'), 0, full, '摘要', false, 'row-1')
  expect(done).toEqual({ key: '问A', hash: 'h2', nth: 0, prompt: full.question, answer: '回答'.repeat(1500), head: '问A的第一句', summary: '摘要', id: 'row-1' })
  const live = favoriteOf(turn('问B', 'partial'), 1, undefined, '', true, undefined)
  expect(live).toEqual({ key: '问B', hash: '', nth: 1, prompt: '问B', answer: '', head: '', summary: '' })
  const after = completed(live, { hash: 'h5', head: '答完了' }, { question: '问B 的全文', answer: '答完了。' })
  expect(after).toEqual({ ...live, hash: 'h5', head: '答完了', prompt: '问B 的全文', answer: '答完了。' })
  expect(clipText(after)).toBe('问B 的全文\n\n答完了。')
  expect(clipText(live)).toBe('问B')
})

test('saved favorites: unreadable entries dropped, empty sessions removed, only the latest sessions kept', async () => {
  expect(readSaved(undefined)).toEqual({})
  expect(readSaved({ a: { at: 1, items: [fav('问', 'h'), { key: 1 }] }, b: 'x' })).toEqual({ a: { at: 1, items: [fav('问', 'h')] } })
  let all = {}
  for (let i = 0; i < 12; i++) all = withSession(all, `s${i}`, [fav('问', `h${i}`)], i)
  expect(Object.keys(all).sort()).toEqual(['s10', 's11', 's2', 's3', 's4', 's5', 's6', 's7', 's8', 's9'])
  all = withSession(all, 's11', [], 99)
  expect(Object.keys(all)).not.toContain('s11')
})

test('the list scrolls a whole entry at a time and follows the end once it gets there', async () => {
  const heights = [3, 3, 4, 3, 3]
  expect(lastTop(heights, 7)).toBe(3)
  expect(lastTop(heights, 100)).toBe(0)
  expect(lastTop([10], 5)).toBe(0)
  expect(fitCount(heights, 7, 0)).toBe(2)
  expect(fitCount(heights, 7, 2)).toBe(2)
  expect(fitCount(heights, 6, 2)).toBe(1)
  expect(fitCount([10], 5, 0)).toBe(1) // 太高的一项也照样画
  expect(scrolled(heights, 7, 3, -1)).toEqual({ top: 2, follow: false }) // 一格滚轮翻一项
  expect(scrolled(heights, 7, 3, -7)).toEqual({ top: 1, follow: false }) // 翻页按行数翻
  expect(scrolled(heights, 7, 1, -20)).toEqual({ top: 0, follow: false })
  expect(scrolled(heights, 7, 1, 1)).toEqual({ top: 2, follow: false })
  expect(scrolled(heights, 7, 2, 5)).toEqual({ top: 3, follow: true }) // 翻到底，跟着最后
  expect(scrolled([3, 3], 100, 0, -1)).toEqual({ top: 0, follow: true }) // 全都放得下
})
