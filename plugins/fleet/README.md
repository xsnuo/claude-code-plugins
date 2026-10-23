# fleet v0.2.0: session overview

English | [简体中文](README.zh-CN.md) · [← Back to the plugin list](../../README.md)

With many background sessions, finding out which one is running, which one is waiting for you and which one is done means going back to `claude agents`. Run `/fleet` and a list of every session in `claude agents` opens on the right, so you can see them all at a glance without leaving the current session. Under the list is the news area: once you are in this session, any other session that replies is listed there too.

```
5 个会话 · 1 运行中 · 1 等你回复
✻ 产品需求文档整理                    2m
✻ 我的插件 当前                      30m
✻ 线上报错 帮我查一下                41m
✻ 🟢 发版                          3h 2m
✢ 老会话                          10h 2m
────────────────────────────────────────
最新消息 · 点这里清空
✻ 产品需求文档整理                    2m
```

## Install

```
/plugin marketplace add xsnuo/claude-code-plugins
/plugin install fleet@xuesinuo
```

## Usage

- **Open and close**: run `/fleet`. You can also click the ✕ at the top right of the pane.
- **Open on entering a session**: run `/fleet auto on` and the list opens by itself whenever you enter a session, with no need to type `/fleet` each time; `/fleet auto off` turns it off again (off by default). The setting is saved.
  - "Entering a session" means: starting Claude Code (including `claude --resume` and `claude --continue`), a background session (shown when `claude attach` connects), and after `/clear`;
  - an open you did not run yourself is not shown while the terminal is too narrow: under 144 columns (110 for a pane you opened with `/fleet` and never closed by hand). Widen the terminal or run `/fleet` once, and it shows up.
- **Reading the list**: one line per session: Claude's asterisk mark, the session name, and how long ago it last replied.
  - The mark's color is the state:

    | Looks | State |
    |---|---|
    | turning (orange) | running |
    | yellow ✻ | waiting for you: it finished a turn with a question for you, it is asking you a question, or it waits for you to approve a tool |
    | green ✻ | done |
    | red ✻ | failed |
    | gray ✻ | stopped; or open but not running: a new session with no prompt yet, or a self-waking session waiting for its next run |

  - Name: the session's name (what `/rename` and `/tag` change), or its first prompt when it has none; cut with … when it does not fit. The current session is marked 「当前」 (current);
  - Time: how long since its latest reply. Seconds only under a minute, such as `3s`; from a minute on no seconds, such as `2m` or `10h 2m`; `24h+` from a full day; `-` when it has never replied. A running session shows its previous reply;
  - the top line counts the sessions, how many are running and how many are waiting for you;
  - when there are more sessions than fit, scroll the list with the mouse wheel; a line above and below says how many more there are. The news area does not scroll with it and stays under the list.
- **Order**: the latest reply comes first. As soon as any session replies (finishes a turn, or asks you a question), it jumps to the first line; a running session stays where its previous reply put it and moves up once it finishes.
- **News area** (「最新消息」): under the list, behind a separating line; docked on the right it sits on the pane's bottom edge, and the room a short list leaves free stays under the list.
  - Once you are in this session, any other session that replies (finishes a turn, or asks you a question) jumps to the first line of the list and is listed in the news area as well; only the latest 3 are kept, newest first, one line per session, updated when it replies again;
  - replies of the current session itself do not count;
  - it is emptied every time you enter the session and counts from then on. "Entering the session" means: opening it from `claude agents`, `claude attach`, starting Claude Code (including `claude --resume` and `claude --continue`), after `/clear`, and a phone or the desktop app connecting;
  - you can also click the 「最新消息」 line to empty it (a click needs the fullscreen interface);
  - the area is always 3 lines tall, just enough for 3; with fewer it stays partly empty, so the list above does not jump when news comes in.
- **Refreshing**: while the pane is open it rereads every session's state every 2 seconds, the times tick every second and the running mark turns. While the pane is closed or hidden behind another pane, nothing is read.
- **Together with the index (the index plugin)**: docked on the right, they are two tabs.
  - The sessions tab always comes first: when the index is already open and you open the overview, the index steps aside and comes back after the overview has opened;
  - when both open by themselves on entering a session, the overview is shown; after that, whichever tab you click is shown;
  - with the overview hidden behind the index, `/fleet` brings it to the front instead of closing it.
- **Each conversation remembers its sidebar**: whether the overview is open, and whether the overview or the index is shown, is kept on this machine (the index keeps whether it is open itself).
  - Opening the conversation again (`claude --resume`, or opening a background session that has gone to rest) restores it as it was, ahead of `/fleet auto on|off`;
  - a conversation with nothing kept follows `/fleet auto on|off`;
  - the latest 200 conversations are kept.
- **See the current setting**: run `/fleet help` to list every usage and the current setting.

### Which sessions are listed

The same ones `claude agents` lists: background sessions, including the ones that are done and still kept in the list.

- Background sessions are the ones started with `claude --bg` or created in `claude agents`;
- a session started with plain `claude` that stays in the foreground is not listed by `claude agents`, and not here either;
- once removed with `claude rm`, it is gone from here too.

## Requirements

- **The Claude Code command line (CLI)**, version 2.1.309 or later (developed and tested on it). The VS Code extension, the desktop app and other forms are not supported.
- **Claude Code's fullscreen interface is best**, so the list docks on the right.
  - Turn it on with `/tui fullscreen`, or put `"tui": "fullscreen"` in `~/.claude/settings.json`.
  - This is Claude Code's own interface mode and has nothing to do with maximizing the terminal window.
  - Outside the fullscreen interface, or in a terminal under 110 columns, the list shows above the input box.
  - Only emptying the news area takes a click; everything else is for reading, so it works outside the fullscreen interface too.
- **macOS, Windows and Linux.** The plugin is TypeScript only: no Python, and it runs no system commands. So far it has only been tested on macOS.

## Cost

It calls no model, uses no network and costs nothing. It only reads the files Claude Code keeps on this machine.

## Known limits

- **It reads Claude Code's undocumented internal files**: `~/.claude/jobs/<id>/state.json` and `timeline.jsonl`, and `~/.claude/sessions/*.json` (under `CLAUDE_CONFIG_DIR` when that is set). A Claude Code update may break it.
- **A change of state shows up to 2 seconds late.**
- **For a running session, or one waiting for your reply, the time of the latest reply comes from `timeline.jsonl`.** That file cannot be read once it is over 4 MiB: a session waiting for you then uses the time its state file was last updated, and a running one shows `-`, unless the pane saw it finish while open, in which case that time is used.
- **Clicking a line does not switch to that session.** Claude Code 2.1.309 does not let a plugin in a background session switch sessions: Claude Code has its own "open another background session" path, but it is turned off inside background sessions, and there is no plugin interface for it. To go in, press ← at an empty prompt (or run `/background`) to get back to `claude agents` and pick it there, or use `claude attach <id>`.
- **Telling that a session was opened also relies on Claude Code's internal files.** Opening a session from `claude agents` raises no event; the plugin watches `~/.claude/daemon/attach-journal/` for a new opening record (one file per opening). The record does not say which session was opened, so whichever it is, every session's news area counts again from that moment. With one terminal that you switch sessions in, that is exactly right; with several terminals each showing a session, opening a session in one empties the news area in the others too.

## Development

- **Tests**: run `claude plugin test .` in this folder.
- **Files**:

| File | What it does |
|---|---|
| `hooks/register.tsx` | The plugin: the `/fleet` command and its setting, opening on entering a session, reading each session's files, the refresh timers, drawing the list and the news area |
| `hooks/jobs.ts` | Pure logic: the state (following the rules of `claude agents`), the time of the latest reply, the order, how times are written, cutting names to fit |
| `hooks/layout.ts` | Pane layout: which part of the list to draw when it does not fit, how many news lines (the news area stays under the list, so the plugin scrolls the list itself) |
| `types/index.d.ts` | The types of the plugin's state |
| `tests/` | Plugin tests, with mocked files, clock and interface |

## License

[MIT](../../LICENSE)
