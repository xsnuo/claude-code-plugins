// 目录列表自己翻动，不碰 $。
//
// 收藏固定在目录顶上，不跟着列表滚走，所以目录面板不交给引擎翻：插件只画放得下的那几项，
// 滚轮、翻页键由 ui.scroll 钩子接住，改“最上面是第几项”。heights 是每一项占几行，room 是列表区有几行。

// 停在最后时，最上面是第几项
export function lastTop(heights: readonly number[], room: number): number {
  let used = 0
  for (let i = heights.length - 1; i >= 0; i--) {
    used += heights[i]!
    if (used > room) return Math.min(heights.length - 1, i + 1)
  }
  return 0
}

// 从 top 开始能放下几项（至少一项，太高的一项也照样画）
export function fitCount(heights: readonly number[], room: number, top: number): number {
  let used = 0
  let n = 0
  for (let i = top; i < heights.length; i++) {
    if (n > 0 && used + heights[i]! > room) break
    used += heights[i]!
    n++
  }
  return n
}

// 翻动 by 行之后最上面是第几项（by 为负往上）：一格滚轮至少翻一项；翻到底就一直跟着最后
export function scrolled(heights: readonly number[], room: number, top: number, by: number): { top: number; follow: boolean } {
  const max = lastTop(heights, room)
  let t = Math.min(Math.max(0, top), max)
  let moved = 0
  if (by > 0) {
    while (t < max && (moved === 0 || moved < by)) moved += heights[t++]!
  } else if (by < 0) {
    while (t > 0 && (moved === 0 || moved < -by)) moved += heights[--t]!
  }
  return { top: t, follow: t >= max }
}
