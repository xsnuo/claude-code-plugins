// 送去第三方朗读接口之前，把敏感信息换成【密钥】【密码】【UID】这类说明。纯函数，不碰 $。
//
// 两道关：
// 1. 请 Claude 找出要屏蔽的片段（register.tsx 里调用）。只让它列出片段、不重写全文，输出短，又快又省；
// 2. 本地规则兜底，抓常见格式的 Key 和“密码：xxx”这种写法：Claude 漏掉的，或者第一步没成功时，都靠它。

export type Span = { text: string; label: string }

export function redactPrompt(segments: readonly string[]): string {
  return [
    '下面 <text> 里的文字马上要送去第三方语音合成接口朗读。请找出其中不该让第三方看到的敏感信息，例如：',
    '- 密钥类：API Key、Access Key、Secret、Token、私钥、证书、Cookie、会话标识 → 名称写“密钥”；',
    '- 密码、口令 → “密码”；',
    '- 用户 ID、账号 ID、UID、OpenID 等身份标识 → “UID”；',
    '- 手机号 → “手机号”；身份证号 → “身份证号”；银行卡号 → “银行卡号”；邮箱地址 → “邮箱”；',
    '- 其他明显不该外传的凭据或个人隐私：起一个 2～6 个字的名称，说清它是什么。',
    '普通的技术名词、文件名、命令、版本号，以及示例里的占位符（比如 YOUR_API_KEY、xxx），都不算。',
    '只输出一个 JSON 数组，每项是 {"text": "原文里逐字照抄的那一段", "label": "名称"}；没有敏感信息就输出 []。不要输出别的内容。',
    '',
    '<text>',
    segments.join('\n\n'),
    '</text>',
  ].join('\n')
}

// 读 Claude 的回答：一个 JSON 数组；读不懂返回 null
export function parseSpans(raw: string): Span[] | null {
  const text = raw.trim().replace(/^```\w*\s*/, '').replace(/\s*```$/, '')
  const tries = [text]
  const a = text.indexOf('[')
  const b = text.lastIndexOf(']')
  if (a >= 0 && b > a) tries.push(text.slice(a, b + 1))
  for (const t of tries) {
    let data: unknown
    try {
      data = JSON.parse(t)
    } catch {
      continue
    }
    if (!Array.isArray(data)) continue
    const out: Span[] = []
    for (const x of data) {
      if (!x || typeof x !== 'object') continue
      const { text: span, label } = x as { text?: unknown; label?: unknown }
      if (typeof span !== 'string' || span.trim().length < 2) continue
      const name = typeof label === 'string' ? label.replace(/[【】\[\]\s]/g, '').slice(0, 8) : ''
      out.push({ text: span.trim(), label: name || '敏感信息' })
    }
    return out
  }
  return null
}

// 把每个片段在文字里出现的地方都换成【名称】。长的先换，免得短的把长的切碎
export function applySpans(text: string, spans: readonly Span[]): string {
  let out = text
  for (const { text: span, label } of [...spans].sort((x, y) => y.text.length - x.text.length)) {
    out = out.split(span).join(`【${label}】`)
  }
  return out
}

// 常见格式的 Key：看格式就知道是什么
const KEYS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bsk-[A-Za-z0-9_-]{16,}/g, // OpenAI、Anthropic 等
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS Access Key
  /\bgh[pousr]_[A-Za-z0-9]{30,}/g, // GitHub
  /\bgithub_pat_[A-Za-z0-9_]{30,}/g,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/g, // Slack
  /\bAIza[0-9A-Za-z_-]{35}/g, // Google
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, // JWT
]

// “密码：xxx”“api_key = xxx”这种写法，只换后面的值。值里有汉字的不算（多半是一句话，不是密码）
const VALUE = String.raw`("[^"\n]{4,}"|'[^'\n]{4,}'|[^\s,，;；"'。、一-鿿]{4,})`
const PAIRS: [RegExp, string][] = [
  [new RegExp(String.raw`((?:password|passwd|pwd|密码|口令)\s*[:：=]\s*)` + VALUE, 'gi'), '密码'],
  [new RegExp(String.raw`((?:api[_-]?key|access[_-]?key|secret(?:[_-]?key)?|token|密钥|私钥)\s*[:：=]\s*)` + VALUE, 'gi'), '密钥'],
]

// 没有前缀的长串：32 位以上，大写、小写、数字都有的，多半是 Key
const LONG = /[A-Za-z0-9_\-+/=]{32,}/g

export function localRedact(text: string): string {
  let out = text
  for (const re of KEYS) out = out.replace(re, '【密钥】')
  for (const [re, label] of PAIRS) out = out.replace(re, (_, head: string) => `${head}【${label}】`)
  out = out.replace(LONG, s => (/[A-Z]/.test(s) && /[a-z]/.test(s) && /\d/.test(s) ? '【密钥】' : s))
  return out
}

// 两道关都过一遍
export function redactAll(segments: readonly string[], spans: readonly Span[]): string[] {
  return segments.map(s => localRedact(applySpans(s, spans)))
}
