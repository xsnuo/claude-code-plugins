// index 放在 $.state 里的值（会话级，热重载后仍在）

// 目录里的一轮：key 用来和界面上那一行提问对上号；prompt 是显示用的提问（已压成一行）；
// hash 由最终回复算出（没有回复时是空串），摘要按它存；head 是回复的第一句，没有摘要时顶上
export type IxTurn = { key: string; prompt: string; hash: string; head: string }
// 一段回复的摘要：loading 正在问 Claude，done 写好了，error 没写成（显示 head）
export type IxSummary = { status: 'loading' | 'done' | 'error'; text: string }
// 一条收藏：key、hash 用来在目录里认出是哪一轮（收藏时还在回答的，hash 是空串，按 nth 认：同样 key 的第几次）；
// prompt、answer、head、summary 是缓存下来的内容，压缩对话后目录里没有这一轮了也还在；
// id 是界面上那一行提问的 id，知道了就能直接跳
export type IxFavorite = { key: string; hash: string; nth: number; prompt: string; answer: string; head: string; summary: string; id?: string }
// 目录列表翻到哪：top 是最上面一项的序号；follow 时一直停在最后，新的一轮跟着显示出来
export type IxView = { top: number; follow: boolean }

declare module 'claude-code' {
  interface PluginState {
    index: {
      turns: IxTurn[]
      // 目录最后一项还在回答
      running: boolean
      summaries: Record<string, IxSummary>
      // 摘要是否请 Claude 写；关掉时用回复的第一句
      useModel: boolean
      // 进入会话时是否自动打开目录
      autoOpen: boolean
      // 提问最多折成几行
      promptLines: number
      // 这个进程已经进过会话了（重新加载插件时不再自动打开）
      entered: boolean
      // 这段对话的收藏，按收藏的先后
      favorites: IxFavorite[]
      view: IxView
    }
  }
}
