// 跳到某一轮的提问：找到界面上那一行的 id，再把它翻到屏幕顶上。不直接碰 $：翻动、等待、提示都由调用方传进来。
//
// 那一行要是还没画过（太早的，全屏界面只画屏幕附近的行），就往上翻着找：
// 在画过的行里挑在它下面、离它最近的一行（位置从对话记录里查：提问按目录，回复按文字，工具调用按 tool_use_id），
// 翻到屏幕底部，屏幕上方就会画出更早的行；再挑离它最近的，一屏一屏往上，直到它被画出来。

import type { Rows } from './rows'
import { assignIds } from './turns'
import type { Places } from './turns'

export type JumpIO = {
  // 把这一行翻进屏幕：start 顶上对齐，end 底下对齐；翻不了返回原因
  scroll: (id: string, block: 'start' | 'end') => Promise<string | undefined>
  sleep: (ms: number) => Promise<void>
  toast: (text: string) => void
  // 每一步翻到哪、为什么，写进调试日志（claude --debug）
  debug?: (text: string) => void
}

// 目录：每一轮提问的 key 和它在对话记录里的位置
export type Toc = { keys: readonly string[]; at: readonly number[] }

// 往上翻找时最多等多久：插件处理一次点击有 10 秒上限，等待也算在里面
export const WALK_BUDGET_MS = 7000
// 翻动一次后，等界面把新翻出来的行画完：每 40ms 看一次，有新行以后安静 120ms 就算画完，一直没有新行最多等 900ms。
// 大会话里一屏带长 diff 的行，画出来可能要半秒多
const STEP_POLL_MS = 40
const STEP_QUIET_MS = 120
const STEP_MAX_MS = 900
// 把目标翻到顶上后，等它量好高度再看一眼
const REVEAL_WAIT_MS = 100

// 等界面把翻出来的行画完，返回等了多久。before 是翻动之前的 rows.size（有的行在翻动还没返回时就画了）
async function settle(rows: Rows, before: number, io: JumpIO): Promise<number> {
  let waited = 0
  let last = rows.size
  let quiet = 0
  while (waited < STEP_MAX_MS) {
    await io.sleep(STEP_POLL_MS)
    waited += STEP_POLL_MS
    if (rows.size !== last) {
      last = rows.size
      quiet = 0
    } else if (last !== before && (quiet += STEP_POLL_MS) >= STEP_QUIET_MS) break
  }
  return waited
}

// 画过的行里，在第 target 轮提问下面、离它最近的一行，和它的位置
function nearestBelow(rows: Rows, toc: Toc, places: Places, target: number): [string, number] | undefined {
  const floor = toc.at[target]!
  let best: string | undefined
  let bestAt = Infinity
  const take = (id: string, at: number | undefined) => {
    if (at !== undefined && at > floor && at < bestAt) {
      best = id
      bestAt = at
    }
  }
  const ids = assignIds(toc.keys, rows.order)
  ids.forEach((id, i) => id && take(id, toc.at[i]))
  // 没对上目录的提问行（比如本地命令）按文字找位置
  const used = new Set(ids)
  for (const r of rows.order) if (!used.has(r.id)) take(r.id, places.texts.get(r.key))
  for (const [id, marks] of rows.marked()) {
    for (const mark of marks) take(id, places.tools.get(mark) ?? places.texts.get(mark))
  }
  return best === undefined ? undefined : [best, bestAt]
}

// 找的结果：找到了（id）；还没翻到但还在往上走、时间用完了（far，再点一次接着找）；
// 界面上没有这一轮（gone，比如压缩对话时去掉了）；翻不动（deny 是原因）
export type Located = { id: string } | { miss: 'far' | 'gone' } | { deny: string }

// 第 target 轮的提问在界面上那一行的 id；还没画过就往上翻着找
export async function locate(rows: Rows, toc: Toc, places: Places, target: number, io: JumpIO): Promise<Located> {
  let waited = 0
  let last: string | undefined
  let first: string | undefined
  let stuck = 0
  for (let step = 0; ; step++) {
    const id = assignIds(toc.keys, rows.order)[target]
    if (id) return { id }
    if (waited >= WALK_BUDGET_MS) return { miss: 'far' }
    const near = nearestBelow(rows, toc, places, target)
    io.debug?.(`index: step ${step} target=${toc.at[target]} anchor=${near?.join('@')} rows=${rows.size} waited=${waited}`)
    if (!near) return { miss: 'gone' }
    const [anchor] = near
    first ??= anchor
    // 上一步没翻出更近的行：界面可能还没画完，或者那一屏没画到上面。换个对齐方式（顶上对齐）再翻一次；
    // 还不行就停下：这次往上走过了，就是还没翻到（再点一次接着找），一步都没走动才是界面上没有这一轮
    if (anchor !== last) stuck = 0
    else if (++stuck >= 2) return { miss: anchor === first ? 'gone' : 'far' }
    // 一步没找到，说明离得远：告诉一声正在找
    if (step === 1) io.toast(`正在往上翻找第 ${target + 1} 轮…`)
    const before = rows.size
    const deny = await io.scroll(anchor, stuck ? 'start' : 'end')
    if (deny) return { deny }
    waited += await settle(rows, before, io)
    last = anchor
  }
}

// 把这一行翻到屏幕顶上，返回翻不了的原因。还没量过高度的行，第一次可能落不准，量好以后再翻一次
export async function reveal(rows: Rows, id: string, io: JumpIO): Promise<string | undefined> {
  for (let i = 0; i < 3; i++) {
    const deny = await io.scroll(id, 'start')
    if (deny) return deny
    await io.sleep(REVEAL_WAIT_MS)
    const shown = rows.isTopShown(id)
    if (shown === true || (shown === undefined && i > 0)) break
  }
  return undefined
}
