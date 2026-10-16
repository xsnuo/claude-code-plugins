# claude-code-plugins

English | [简体中文](README.zh-CN.md)

Claude Code plugins by xuesinuo, published as the `xuesinuo` plugin marketplace. Each plugin installs on its own, so pick only what you need.

They are all for the Claude Code command line (CLI) and work on macOS, Windows and Linux.

## Plugins

| Plugin | Version | What it does |
|---|---|---|
| [tag](plugins/tag/README.md) | v2.0.0 | `/tag` puts a status light ⚪🔴🟡🟢⚫ at the front of the session title, so you can see each session's state at a glance in the session list |
| [aload](plugins/aload/README.md) | v0.5.0 | A "🔊 read aload" link at the end of each reply reads it out loud only when you click, optionally starting from the text you selected (Azure / Doubao TTS 2.0) |
| [key-points](plugins/key-points/README.md) | v0.2.1 | A "📌 key points" link at the end of each reply has Claude pick the key sentences and key words, marked right in the reply |

## About the plugins

### tag v2.0.0: session status light

With many background sessions it is easy to lose track of which one is waiting for you and which one is done. tag puts a light at the front of the session title. You decide what each color means.

- `/tag`: cycle to the next color.
- `/tag yellow`: set a color directly.
- `/tag new name`: rename the session and keep the light.

The plugin handles `/tag` itself, without the model, so it costs nothing. It works in background sessions (the ones `claude agents` lists).

[Details →](plugins/tag/README.md)

### aload v0.5.0: click to read aloud

It reads only when you click, never on its own.

- **From the top**: click "🔊 read aload" to read from the start to the end of that reply.
- **From the middle**: select a few words first, then click, to start from there.
- **Pay only for what you hear**: it calls the speech API paragraph by paragraph while reading and makes no more requests once you stop.
- **No leaked secrets**: before anything is sent, Claude replaces keys, passwords, UIDs and the like with 【密钥】【密码】【UID】, with local rules as a backstop.

You need your own Azure Speech key (it has a monthly free tier) or a Doubao (Volcengine) TTS 2.0 key. On Windows and Linux you also need Python 3.

[Details →](plugins/aload/README.md)

### key-points v0.2.1: mark the key points

Click "📌 key points" at the end of a reply and Claude, with the whole conversation in view, picks that reply's key sentences and key words and marks them right in the reply. Click again to clear them.

- **What it picks**: the core of the conversation, the part that answers your question directly, and what you need to know or decide.
- **No clutter**: it asks Claude in a separate background request that stays out of the conversation. Only the reply's look changes, never its text.
- **Never too much**: marks cover at most 25% of the reply, enforced by the plugin.
- **Your style**: text color, background and underline combine freely, set separately for sentences and words.

Installed together with aload, the two links each take their own line under the reply, so neither affects the other.

[Details →](plugins/key-points/README.md)

## Before you install

**Only aload needs something installed first: Python 3.** tag and key-points need nothing else.

| System | What aload needs | How to install it |
|---|---|---|
| macOS | Python 3 (part of the Xcode Command Line Tools) | Run `python3 --version` in a terminal. If a dialog offers to install the command line developer tools, click "Install"; or run `xcode-select --install` |
| Windows | Python 3 | Install it from [python.org](https://www.python.org/downloads/) (keep the py launcher, which is ticked by default), or run `winget install Python.Python.3.13`. Afterwards `py -3 --version` should print a 3.x version |
| Linux | Python 3 and a command that plays sound | Debian, Ubuntu: `sudo apt install python3 pulseaudio-utils`; Fedora: `sudo dnf install python3 pulseaudio-utils` |

**The buttons of aload and key-points are links.** To click them with the mouse you also need:
- **Claude Code's fullscreen interface**: run `/tui fullscreen`, or put `"tui": "fullscreen"` in `~/.claude/settings.json`. This is Claude Code's own interface mode and has nothing to do with maximizing the window.
- **A terminal that supports hyperlinks**:

| System | Terminals that work |
|---|---|
| macOS | iTerm2, Ghostty (the built-in Terminal app does not) |
| Windows | Windows Terminal (built into Windows 11; on Windows 10, get it from the Microsoft Store) |
| Linux | GNOME Terminal |

## Install

Run these in Claude Code:

```
/plugin marketplace add xsnuo/claude-code-plugins
/plugin install tag@xuesinuo
/plugin install aload@xuesinuo
/plugin install key-points@xuesinuo
```

The first line adds the marketplace and only needs to run once. Install whichever of the others you want.

- **Update**: `/plugin marketplace update xuesinuo`.
- **Disable or uninstall**: use `/plugin`.

## Requirements

- **The Claude Code command line (CLI)**, version 2.1.299 or later. The VS Code extension, the desktop app and other forms are not supported.
- **macOS, Windows and Linux.** So far everything has only been tested on macOS; the Windows and Linux support has not been tried on a real machine yet.
- **What to install first**: see [Before you install](#before-you-install) above.

Details are in each plugin's own README: [tag](plugins/tag/README.md#requirements), [aload](plugins/aload/README.md#requirements), [key-points](plugins/key-points/README.md#requirements).

## License

[MIT](LICENSE): free to use, modify and distribute, as long as the copyright notice is kept.
