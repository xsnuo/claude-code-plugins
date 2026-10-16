// 会话状态灯的纯逻辑：把 ⚪🔴🟡🟢⚫ 之一放在会话标题首位。不碰文件，不碰 $。

export const LIGHTS = ['⚪', '🔴', '🟡', '🟢', '⚫'] as const
export type Light = (typeof LIGHTS)[number]

const NAMES: Record<Light, string> = { '⚪': '白', '🔴': '红', '🟡': '黄', '🟢': '绿', '⚫': '黑' }
const VS16 = '️'

// 数字就是环上的格号：0 无 · 1 ⚪ · 2 🔴 · 3 🟡 · 4 🟢 · 5 ⚫（0 归 NONE_ALIASES 管）
const ALIASES: Record<string, Light> = {
  '⚪': '⚪', 白: '⚪', w: '⚪', white: '⚪', '1': '⚪',
  '🔴': '🔴', 红: '🔴', r: '🔴', red: '🔴', '2': '🔴',
  '🟡': '🟡', 黄: '🟡', y: '🟡', yellow: '🟡', '3': '🟡',
  '🟢': '🟢', 绿: '🟢', g: '🟢', green: '🟢', '4': '🟢',
  '⚫': '⚫', 黑: '⚫', k: '⚫', black: '⚫', '5': '⚫',
}
const SHOW = new Set(['?', '？', 'show', 'status', 'h', 'help'])
// 摘灯。注意这几个词因此不能再当名字用了——想叫这个名字请用 /rename
const NONE_ALIASES = new Set(['0', '无', '無', 'none', 'off', 'clear', 'x', '-'])

export const USAGE =
  '用法：/tag 轮换 · /tag 0~5 指定（0无 1白 2红 3黄 4绿 5黑，也认中文和 emoji）· /tag <新名字> 改名（保留当前灯）· /tag ? 查看'

// 把标题拆成 [灯, 其余]。没灯则灯为 null
export function splitLight(name: string): [Light | null, string] {
  for (const lit of LIGHTS) {
    for (const prefix of [lit + VS16, lit]) {
      if (name.startsWith(prefix)) return [lit, name.slice(prefix.length).trimStart()]
    }
  }
  return [null, name]
}

function compose(light: Light | null, rest: string): string {
  const r = rest.trim()
  if (light === null) return r
  return r ? `${light} ${r}` : light
}

// 无 ⚪ 🔴 [🟡] 🟢 ⚫ 这样的一行状态盘，"无"也是环上的一格
function dial(light: Light | null): string {
  return [light === null ? '[无]' : '无', ...LIGHTS.map(x => (x === light ? `[${x}]` : x))].join(' ')
}

// 把一次灯的变化说成一句话。null 表示没有灯
function describeLight(old: Light | null, next: Light | null): string {
  if (old === next) return next === null ? '灯不变' : `${next} ${NAMES[next]}灯不变`
  if (old === null) return `点灯 ${next} ${NAMES[next!]}`
  if (next === null) return `摘灯 ${old} ${NAMES[old]} → 无`
  return `${old} ${NAMES[old]} → ${next} ${NAMES[next]}`
}

export type Plan = { name: string | null; msg: string } | { name: null; msg: null; err: string }

// 算出新标题。name 为 null 表示不用改；有 err 表示出错，不改。
//
// 参数分五类：
//   ? ？ show     只看当前状态，不改
//   （不带参数）    沿环轮换：无 → ⚪ → 🔴 → 🟡 → 🟢 → ⚫ → 无
//   白红黄绿黑      直接指定灯，名字不动
//   无 none off   摘掉灯，名字不动
//   其余任何文字    当作改名，保留当前的灯（相当于会留灯的 /rename）；
//                 文本自带灯时以它为准，于是 "/tag 🟢 新名字" 一步到位
export function planTag(title: string, arg: string): Plan {
  const [light, rest] = splitLight(title)
  const a = arg.trim()
  const key = a.replace(/️+$/, '').toLowerCase()

  if (SHOW.has(key)) return { name: null, msg: `${dial(light)}  标题：${title || '(空)'}\n${USAGE}` }

  // ---------------------------------------------- 定出目标灯 + 目标名字
  let target: Light | null
  let newRest: string
  if (a === '') {
    // 轮换。把"没有灯"也算作环上的一格
    target = light === null ? LIGHTS[0] : light === LIGHTS[LIGHTS.length - 1] ? null : LIGHTS[LIGHTS.indexOf(light) + 1]!
    newRest = rest
  } else if (NONE_ALIASES.has(key)) {
    target = null
    newRest = rest
  } else if (Object.hasOwn(ALIASES, key)) {
    target = ALIASES[key]!
    newRest = rest
  } else {
    // 认不出的一律当改名。文本里自带灯就用它，免得拼出两个灯的标题
    const [typedLight, typedRest] = splitLight(a)
    if (!typedRest) return { name: null, msg: null, err: `新名字不能为空（只收到 “${a}”）` }
    target = typedLight ?? light
    newRest = typedRest
  }

  // ------------------------------------------------------------ 组装
  if (target === light && newRest === rest) {
    if (light === null) return { name: null, msg: `本来就没有灯 · ${title || '(空)'}` }
    return { name: null, msg: `${light} ${NAMES[light]}灯，没变化 · ${title}` }
  }

  // 标题不能只剩一个灯：全新会话还没起名时就是这种情况，光秃秃一个灯在列表里没意义
  if (!newRest) {
    if (target === null) return { name: null, msg: null, err: `摘掉灯之后标题就空了（当前标题只有 “${title}”），先用 /tag <新名字> 起个名字` }
    return { name: null, msg: null, err: '这个会话还没有标题，先用 /tag <新名字> 给它起个名字，再点灯' }
  }

  const name = compose(target, newRest)
  if (newRest !== rest) {
    // 改了名字：把改名放在前面，灯的变化（如果有）跟在后面
    const change = target === light ? '改名' : `改名 + ${describeLight(light, target)}`
    return { name, msg: `${change} · ${title || '(空)'} → ${name}` }
  }
  return { name, msg: `${describeLight(light, target)} · ${name}` }
}
