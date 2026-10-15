# tag：会话状态灯

[English](README.md) | 简体中文 · [← 返回插件列表](../../README.zh-CN.md)

用 `/tag` 在会话标题最前面放一盏灯（⚪🔴🟡🟢⚫），在会话列表里一眼看出每个会话进行到哪了。如果装了 claude-hud 这类会显示会话名的状态栏，状态栏里的标题也会跟着变。

灯的含义由你自己定。比如：🔴 等我处理，🟡 进行中，🟢 已完成。

## 安装

```
/plugin marketplace add xsnuo/claude-code-plugins
/plugin install tag@xuesinuo
```

## 用法

| 输入 | 效果 |
|---|---|
| `/tag` | 轮换：无 → ⚪ → 🔴 → 🟡 → 🟢 → ⚫ → 无 |
| `/tag 0`～`/tag 5` | 按格号指定：0 无，1 白，2 红，3 黄，4 绿，5 黑 |
| `/tag 黄` | 按颜色指定，也认 emoji 和 w / r / y / g / k |
| `/tag 无` | 摘掉灯，也认 `none`、`off` |
| `/tag 新名字` | 改名，保留当前的灯；`/tag 🟢 新名字` 同时换灯 |
| `/tag ?` | 查看当前状态 |

## 需要知道的

- **不经过模型，不消耗额度。** 插件的钩子会直接拦下 `/tag` 处理。
- **会多出一行提示。** 每次都会先显示一行 `UserPromptSubmit operation blocked by hook:`，结果跟在后面。这是正常现象：钩子拦下输入时，Claude Code 一定会打印这一行。
- **可能随升级失效。** tag 是靠改写 Claude Code 未公开的内部文件（`~/.claude/jobs/<id>/state.json`）来换标题的，Claude Code 升级后可能不再有效。
- **`/rename` 会抹掉灯。** 内置的 `/rename` 会整体替换标题，灯也一起没了，再执行一次 `/tag` 即可。
- **认不出的参数会当成新名字。** 比如 `/tag 紫` 会把会话改名为“紫”。

## 从手工安装迁移

如果你以前把 `/tag` 手工装在了 `~/.claude` 下，装插件前要先删掉下面三处，否则每次 `/tag` 都会被处理两次，灯会多跳一格：

1. `~/.claude/tag/` 目录；
2. `~/.claude/commands/tag.md`；
3. `~/.claude/settings.json` 里 `UserPromptSubmit` 下调用 `tag-hook.py` 的那条钩子。

## 开发

- **测试**：在本目录下运行 `python3 tests/test_tag.py`。
- **文件**：

| 文件 | 作用 |
|---|---|
| `bin/tag.py` | 核心逻辑：算新标题、找会话状态文件、写入；也能当命令行用 |
| `bin/tag-hook.py` | 钩子入口：拦下 `/tag`，调用 tag.py，回一行结果 |
| `hooks/hooks.json` | 注册上面的钩子 |
| `commands/tag.md` | 只负责让 `/tag` 成为已知命令。**里面绝不能加 `!` 去调用 tag.py**，否则会被处理两次 |

## 许可证

[MIT](../../LICENSE)
