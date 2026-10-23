// fleet 放在 $.state 里的值（会话级，热重载后仍在）

// 一个会话的状态：running 运行中、needs 等你回复（或批准）、done 做完、failed 出错、stopped 被停掉、
// idle 开着但没在跑（新开还没提问的，或者定时醒来的会话在等下一次）
export type FlStatus = 'running' | 'needs' | 'done' | 'failed' | 'stopped' | 'idle'
// 列表里的一个会话：id 是 claude agents 里的短 id；doneAt 是最近一次做完一轮的时间（毫秒，没做完过是 null）；
// sortAt 是排序用的时间：有 doneAt 就是它，没有就是会话开始的时间；isSelf 是不是现在这个会话
export type FlJob = { id: string; name: string; status: FlStatus; doneAt: number | null; sortAt: number; isSelf: boolean }

declare module 'claude-code' {
  interface PluginState {
    fleet: {
      // 排好序的会话
      jobs: FlJob[]
      // 画面用的“现在”：定时更新，菊花标转动、时长走字都靠它
      now: number
      // 最新消息区从什么时候算起（毫秒）：这之后别的会话有了新回复，就列进最新消息区
      since: number
      // 列表放不下时，从第几个会话画起
      top: number
      // 进入会话时是否自动打开
      autoOpen: boolean
      // 这个进程已经进过会话了（重新加载插件时不再自动打开）
      entered: boolean
    }
  }
}
