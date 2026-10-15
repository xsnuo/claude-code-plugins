// aload 放在 $.state 里的值（会话级，热重载后仍在）
export type AloadProvider = 'azure' | 'doubao'
// 朗读按钮放哪：每条回复末尾一个 / 每段一个（常显）/ 每段一个（悬停才显示）
export type AloadIcon = 'reply' | 'paragraph' | 'hover'
// 一次朗读：依次念 segments；念第 j 段时，key 为 keys[j] 的按钮显示为"正在念"
export type AloadJob = { keys: string[]; segments: string[] }
// 正在念：key 是 `<消息 id>`（末尾按钮）或 `<消息 id>:<段序号>`（每段按钮）；seg / total 是第几段 / 共几段
export type AloadNow = { key: string; status: 'loading' | 'playing'; seg: number; total: number }
// 一轮的最终回复：原文，和去掉多余空白后用来比对的样子
export type AloadFinal = { text: string; flat: string }
// 鼠标选中的文字，和它所在的那条消息
export type AloadSelected = { text: string; requestId?: string }
// Key 输入面板：给哪家填、为什么弹出来、填好后要接着念的那一次
export type AloadPane = { provider: AloadProvider; reason: string; pending?: AloadJob }

declare module 'claude-code' {
  interface PluginState {
    aload: {
      now: AloadNow | null
      icon: AloadIcon
      finals: AloadFinal[]
      selected: AloadSelected | null
      pane: AloadPane | null
      draftKey: string
      draftExtra: string
      paneMsg: string
      paneBusy: boolean
    }
  }
}
