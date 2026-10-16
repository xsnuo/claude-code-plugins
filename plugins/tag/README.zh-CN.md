# tag v2.0.0：会话状态灯

[English](README.md) | 简体中文 · [← 返回插件列表](../../README.zh-CN.md)

用 `/tag` 在会话标题最前面放一盏灯（⚪🔴🟡🟢⚫），在会话列表（`claude agents`）里一眼看出每个会话进行到哪了。如果装了 claude-hud 这类会显示会话名的状态栏，状态栏里的标题也会跟着变。

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

- **不经过模型，不消耗额度。** `/tag` 由插件直接回答。
- **只对后台会话有效。** 只有后台会话（用 `claude --bg` 启动、在 `claude agents` 里列出的会话）有会话状态文件。在普通的前台会话里用 `/tag`，会提示“定位不到当前会话的状态文件”。
- **可能随升级失效。** tag 是靠改写 Claude Code 未公开的内部文件来换标题的（`~/.claude/jobs/<id>/state.json`；设了 `CLAUDE_CONFIG_DIR` 时在那个目录下），Claude Code 升级后可能不再有效。
- **`/rename` 会抹掉灯。** 内置的 `/rename` 会整体替换标题，灯也一起没了，再执行一次 `/tag` 即可。
- **认不出的参数会当成新名字。** 比如 `/tag 紫` 会把会话改名为“紫”。

## 运行要求

- **Claude Code 命令行（CLI）**，2.1.299 或更高版本。不支持 VS Code 扩展、桌面 App 等其他形式。
- **macOS、Windows、Linux 都可以。** 插件只有 TypeScript 代码，不需要 Python，也不调用系统命令。目前只在 macOS 上实测过。

## 从旧版迁移

- **从 1.x 升级**：1.x 用 Python 钩子拦截 `/tag`，每次会多出一行 `UserPromptSubmit operation blocked by hook:`。2.0 改由插件直接回答，这一行没有了，也不再需要 Python。更新插件即可，不用做别的。
- **以前手工装在 `~/.claude` 下的**：装插件前要先删掉下面三处，否则旧的钩子会抢先处理 `/tag`：
  1. `~/.claude/tag/` 目录；
  2. `~/.claude/commands/tag.md`；
  3. `~/.claude/settings.json` 里 `UserPromptSubmit` 下调用 `tag-hook.py` 的那条钩子。

## 开发

- **测试**：在本目录下运行 `claude plugin test .`。
- **文件**：

| 文件 | 作用 |
|---|---|
| `hooks/core.ts` | 纯逻辑：根据当前标题和参数算出新标题、给你看的那一行 |
| `hooks/register.ts` | 插件本体：注册 `/tag` 命令，找到会话状态文件并写入 |
| `hooks/hooks.json` | 指向上面的插件代码 |
| `tests/` | 插件测试：纯逻辑的用例，以及用内存里的假文件系统模拟各种会话 |

## 许可证

[MIT](../../LICENSE)
