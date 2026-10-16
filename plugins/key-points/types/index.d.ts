// key-points 放在 $.state 里的值（会话级，热重载后仍在）

// 重点分两类：关注句、关注词
export type KpKind = 'sentence' | 'word'
// 一处重点：Claude 从回复原文里照抄出来的文字
export type KpItem = { type: KpKind; text: string }
// 一轮的最终回复：id 由原文算出，flat 是去掉多余空白后用来比对的样子
export type KpFinal = { id: string; text: string; flat: string }
// 一条回复的标注：loading 正在问 Claude，on 显示，off 已取消（结果留着，再点直接显示），error 出错了
export type KpMark = { status: 'loading' | 'on' | 'off' | 'error'; items: KpItem[]; error?: string }
// 一类重点的标注方式：字体色、背景色、下划线可以组合
export type KpStyle = { color?: string; backgroundColor?: string; underline: boolean }
export type KpStyles = { sentence: KpStyle; word: KpStyle }

declare module 'claude-code' {
  interface PluginState {
    'key-points': {
      finals: KpFinal[]
      marks: Record<string, KpMark>
      styles: KpStyles
    }
  }
}
