---
description: 会话状态灯与改名：轮换 / 指定灯色 / 摘灯 / 保留灯改名（列表和 HUD 同时生效）
argument-hint: "[0-5 | 白|红|黄|绿|黑 | 无 | 新名字 | ?]"
disable-model-invocation: true
---

状态灯由本插件的 UserPromptSubmit hook（bin/tag-hook.py）拦下 `/tag` 直接处理，
不经过模型。这个文件只负责让 `/tag` 成为一个已知的斜杠命令。

**这里绝不能再执行 tag.py。** 斜杠命令里的 `!` 会先于 hook 执行：它先把状态改掉，
hook 再在改过的状态上算一次，导致反馈消息比实际状态超前一格（实际 黄→绿，却提示 绿→黑）。

正常情况下 hook 会拦下输入，下面这行不会到达模型。若你看到了这段话，说明 hook 没生效：
请告诉用户「状态灯 hook 未运行：确认 tag 插件已启用（/plugin），并执行 /reload-plugins」，
不要自己去调用 tag.py。
