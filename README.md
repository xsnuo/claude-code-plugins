# claude-code-plugins

English | [简体中文](README.zh-CN.md)

Claude Code plugins by xuesinuo, published as the `xuesinuo` plugin marketplace. Each plugin installs on its own, so pick only what you need.

They are all for the Claude Code command line (CLI) and work on macOS, Windows and Linux.

## Plugins

| Plugin | Version | What it does |
|---|---|---|
| [tag](plugins/tag/README.md) | v2.0.0 | `/tag` puts a status light ⚪🔴🟡🟢⚫ at the front of the session title, so you can see each session's state at a glance in the session list |
| [aload](plugins/aload/README.md) | v0.6.1 | A "🔊 read aload" button at the end of each reply reads it out loud only when you click, optionally starting from the text you selected (Azure / Doubao TTS 2.0 / the computer's own speech) |
| [key-points](plugins/key-points/README.md) | v0.2.2 | A "📌 key points" button at the end of each reply has Claude pick the key sentences and key words, marked right in the reply |
| [index](plugins/index/README.md) | v0.4.0 | `/index` opens a table of contents of this session on the right, one entry per turn with the prompt in short and a summary of the answer; click one to jump to that prompt; star the turns that matter |
| [fleet](plugins/fleet/README.md) | v0.2.0 | `/fleet` lists every session of `claude agents` on the right: an asterisk mark shows running, waiting for you or done, followed by how long ago it last replied; the latest reply comes first; the news area below lists the sessions that replied since you entered |

## About the plugins

### tag v2.0.0: session status light

With many background sessions it is easy to lose track of which one is waiting for you and which one is done. tag puts a light at the front of the session title. You decide what each color means.

- `/tag`: cycle to the next color.
- `/tag yellow`: set a color directly.
- `/tag new name`: rename the session and keep the light.

The plugin handles `/tag` itself, without the model, so it costs nothing. It works in background sessions (the ones `claude agents` lists).

[Details →](plugins/tag/README.md)

### aload v0.6.1: click to read aloud

It reads only when you click, never on its own.

- **From the top**: click "🔊 read aload" to read from the start to the end of that reply.
- **From the middle**: select a few words first, then click, to start from there.
- **Pay only for what you hear**: it calls the speech API paragraph by paragraph while reading and makes no more requests once you stop.
- **No leaked secrets**: before anything is sent, Claude replaces keys, passwords, UIDs and the like with 【密钥】【密码】【UID】, with local rules as a backstop.
- **The computer's own speech**: on a Mac, `/aload macos` uses the built-in speech: no key, offline, free (Windows and Linux have their own equivalent).

With Azure Speech (it has a monthly free tier) or Doubao (Volcengine) TTS 2.0 you need your own key. On Windows and Linux you also need Python 3.

[Details →](plugins/aload/README.md)

### key-points v0.2.2: mark the key points

Click "📌 key points" at the end of a reply and Claude, with the whole conversation in view, picks that reply's key sentences and key words and marks them right in the reply. Click again to clear them.

- **What it picks**: the core of the conversation, the part that answers your question directly, and what you need to know or decide.
- **No clutter**: it asks Claude in a separate background request that stays out of the conversation. Only the reply's look changes, never its text.
- **Never too much**: marks cover at most 25% of the reply, enforced by the plugin.
- **Your style**: text color, background and underline combine freely, set separately for sentences and words.

Installed together with aload, the two buttons each take their own line under the reply, so neither affects the other.

[Details →](plugins/key-points/README.md)

### index v0.4.0: conversation index

In a long conversation, going back to an earlier turn means scrolling up screen after screen. Run `/index` and a table of contents of this session opens on the right; click an entry and the conversation jumps to that prompt.

- **One entry per turn**: your prompt on top (at most two lines by default, `/index lines N` changes it), a one-line summary of the answer below.
- **Summaries**: on by default: Claude (haiku) writes them in the background, one per turn, only while the index is open; written ones are kept on this machine and never rewritten. `/index summary off` uses the answer's first sentence instead, at no cost.
- **Jumping**: for prompts far up, the plugin first scrolls up to find them, usually in a second or two.
- **Favorites**: click the ☆ in front of an entry to star it. Starred turns stay pinned at the top of the index, never scrolled away, and one click jumps there. They survive a compaction; `/clear` removes them.
- **Open automatically**: after `/index auto on`, the index opens by itself every time you enter a session (off by default); each conversation also remembers whether its index was open and restores that when opened again.

[Details →](plugins/index/README.md)

### fleet v0.2.0: session overview

With many background sessions, finding out which one is running, which one is waiting for you and which one is done means going back to `claude agents`. Run `/fleet` and a list of every session in `claude agents` opens on the right, so you can see them all at a glance without leaving the current session.

- **One line per session**: Claude's asterisk mark ✻, the session name, and how long ago it last replied (`3s` under a minute, no seconds from a minute on, `2m` or `10h 2m`; `24h+` from a full day).
- **The mark tells the state**: turning means running, yellow means waiting for you (including a question for you or a tool to approve), green means done; red is failed, gray is stopped or idle.
- **Latest reply first**: as soon as any session replies, it jumps to the first line.
- **News area**: under the list; once you are in this session, other sessions that reply are listed there too, the latest 3 only. It empties every time you enter the session, or with a click.
- **Free**: no model, no network; it only reads the files Claude Code keeps on this machine, every 2 seconds while the pane is open.
- **Open automatically**: after `/fleet auto on`, it opens by itself every time you enter a session (off by default); each conversation also remembers how its sidebar looked and restores that when opened again.
- **Together with the index**: the sessions tab always comes before the index; when both open by themselves on entering a session, the overview is shown.

[Details →](plugins/fleet/README.md)

## Before you install

**Only aload needs something installed first: Python 3.** tag, key-points, index and fleet need nothing else.

| System | What aload needs | How to install it |
|---|---|---|
| macOS | Python 3 (part of the Xcode Command Line Tools) | Run `python3 --version` in a terminal. If a dialog offers to install the command line developer tools, click "Install"; or run `xcode-select --install` |
| Windows | Python 3 | Install it from [python.org](https://www.python.org/downloads/) (keep the py launcher, which is ticked by default), or run `winget install Python.Python.3.13`. Afterwards `py -3 --version` should print a 3.x version |
| Linux | Python 3 and a command that plays sound; the computer's own speech also needs espeak-ng | Debian, Ubuntu: `sudo apt install python3 pulseaudio-utils espeak-ng`; Fedora: `sudo dnf install python3 pulseaudio-utils espeak-ng` |

**The buttons of aload and key-points and the entries of index are clicked with the mouse**, so Claude Code's fullscreen interface must be on: run `/tui fullscreen`, or put `"tui": "fullscreen"` in `~/.claude/settings.json`. This is Claude Code's own interface mode and has nothing to do with maximizing the window. Any terminal works. The fleet list is only for reading: it docks on the right in the fullscreen interface, and shows above the input box outside it.

## Install

Run these in Claude Code:

```
/plugin marketplace add xsnuo/claude-code-plugins
/plugin install tag@xuesinuo
/plugin install aload@xuesinuo
/plugin install key-points@xuesinuo
/plugin install index@xuesinuo
/plugin install fleet@xuesinuo
```

The first line adds the marketplace and only needs to run once. Install whichever of the others you want.

- **Update**: `/plugin marketplace update xuesinuo`.
- **Disable or uninstall**: use `/plugin`.

## Requirements

- **The Claude Code command line (CLI)**, version 2.1.299 or later (2.1.307 or later for index, 2.1.309 or later for fleet). The VS Code extension, the desktop app and other forms are not supported.
- **macOS, Windows and Linux.** So far everything has only been tested on macOS; the Windows and Linux support has not been tried on a real machine yet.
- **What to install first**: see [Before you install](#before-you-install) above.

Details are in each plugin's own README: [tag](plugins/tag/README.md#requirements), [aload](plugins/aload/README.md#requirements), [key-points](plugins/key-points/README.md#requirements), [index](plugins/index/README.md#requirements), [fleet](plugins/fleet/README.md#requirements).

## License

[MIT](LICENSE): free to use, modify and distribute, as long as the copyright notice is kept.
