// 面板的排版，不碰 $。
//
// 最新消息区在列表下面，不能被滚走，所以面板不交给引擎翻：会话多、放不下时只画列表的一段，
// 滚轮、翻页键由 ui.scroll 钩子接住，改“列表从第几个画起”。每个会话、每条消息都只占一行。

// 最新消息只留最近几条；区域固定这么高，来了新消息列表也不跳
export const NEWS_MAX = 3
// 最新消息区：分隔线、标题，加上 NEWS_MAX 行
export const NEWS_ROWS = 2 + NEWS_MAX

export type Layout = {
  // 列表从第几个会话画起、画几个
  top: number
  count: number
  // 列表放不下：上下各一行写着还有几个
  isCut: boolean
}

// room 是面板有几行，list 是有几个会话，top 是上次翻到第几个。最上面还有一行说明
export function layout(room: number, list: number, top: number): Layout {
  const listRoom = room - 1 - NEWS_ROWS
  if (list <= listRoom) return { top: 0, count: list, isCut: false }
  const count = Math.max(1, listRoom - 2)
  return { top: Math.min(Math.max(0, top), list - count), count, isCut: true }
}

// 翻动 by 行（负数往上）之后列表从第几个画起
export function scrolled(list: number, count: number, top: number, by: number): number {
  return Math.min(Math.max(0, top + by), Math.max(0, list - count))
}
