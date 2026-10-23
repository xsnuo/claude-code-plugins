// index 放在 $.state 里的值（会话级，热重载后仍在）

// 目录里的一轮：key 用来和界面上那一行提问对上号；prompt 是显示用的提问（已压成一行）；
// hash 由最终回复算出（没有回复时是空串），摘要按它存；head 是回复的第一句，没有摘要时顶上
export type IxTurn = { key: string; prompt: string; hash: string; head: string }
// 一段回复的摘要：loading 正在问 Claude，done 写好了，error 没写成（显示 head）
export type IxSummary = { status: 'loading' | 'done' | 'error'; text: string }

declare module 'claude-code' {
  interface PluginState {
    index: {
      turns: IxTurn[]
      // 目录最后一项还在回答
      running: boolean
      summaries: Record<string, IxSummary>
      // 摘要是否请 Claude 写；关掉时用回复的第一句
      useModel: boolean
    }
  }
}
