# fleet v0.2.6: session overview

English | [简体中文](README.zh-CN.md) · [← Back to the plugin list](../../README.md)

With many background sessions, finding out which one is running, which one is waiting for you and which one is done means going back to `claude agents`. Run `/fleet` and a list of every session in `claude agents` opens on the right, so you can see them all at a glance without leaving the current session. Under the list is the unread area: the sessions that replied since you last opened them are listed there; open one and it leaves.

```
5 个会话 · 1 运行中 · 1 等你回复
✻ 产品需求文档整理                    2m
✻ 我的插件 当前                      30m
✻ 线上报错 帮我查一下                41m
✻ 🟢 发版                          3h 2m
✢ 老会话                          10h 2m
────────────────────────────────────────
未读消息
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
  - when there are more sessions than fit, scroll the list with the mouse wheel; a line above and below says how many more there are. The unread area does not scroll with it and stays under the list.
- **Order**: the latest reply comes first. As soon as any session replies (finishes a turn, or asks you a question), it jumps to the first line; a running session stays where its previous reply put it and moves up once it finishes.
- **Unread area** (「未读消息」): under the list, behind a separating line; docked on the right it sits on the pane's bottom edge, and the room a short list leaves free stays under the list.
  - a session that replies (finishes a turn, or asks you a question) jumps to the first line of the list and is listed in the unread area as well;
  - one line per session: when it replies again, its line moves to the top. There is no limit on how many pile up; the latest 6 are shown, and when one of them leaves, the next one moves up;
  - opening the session takes it out of the unread area. "Opening" means: opening it from `claude agents` or connecting with `claude attach` (a reply while it is open is not news; a reply after you went back to the list is), or typing in that session (a prompt or a slash command), or a phone or the desktop app connecting to it;
  - every session shows the same unread list: what leaves it in one session is gone from the others too. The current session is not listed (seeing this pane means you have it open);
  - the area is always 6 lines tall, just enough for 6; with fewer it stays partly empty, so the list above does not jump when a new one comes in.
- **Refreshing**: while the pane is open it rereads every session's state every 2 seconds, the times tick every second and the running mark turns. While the pane is closed or hidden behind another pane, the sessions' state is not read; only Claude Code's opening records are glanced at (to note which session you opened).
- **Together with the index (the index plugin)**: docked on the right, they are two tabs, and Claude Code shows the one opened last.
  - When both open by themselves on entering a session, the overview is shown (the tabs then read 「目录 会话」), and the cursor stays in the prompt, so you can type right away;
  - `/fleet` shows the overview and `/index` shows the index; after that, whichever tab you click is shown;
  - with the overview hidden behind the index, `/fleet` moves it to the last tab and shows it instead of closing it.
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
  - The list is only for reading, nothing needs clicking, so it works outside the fullscreen interface too.
- **macOS, Windows and Linux.** The plugin is TypeScript only: no Python, and it runs no system commands. So far it has only been tested on macOS.

## Cost

It calls no model, uses no network and costs nothing. It only reads the files Claude Code keeps on this machine.

## Known limits

- **It reads Claude Code's undocumented internal files**: `~/.claude/jobs/<id>/state.json` and `timeline.jsonl`, `~/.claude/sessions/*.json`, and, to tell which session you opened, `~/.claude/daemon/attach-journal/*.json`, `~/.claude/daemon/roster.json` and `~/.claude/daemon.lock` (under `CLAUDE_CONFIG_DIR` when that is set). A Claude Code update may break it. `roster.json` also holds keys; the plugin takes only how many messages each session had when it was first drawn, and uses or keeps nothing else.
- **A change of state shows up to 2 seconds late.**
- **For a running session, or one waiting for your reply, the time of the latest reply comes from `timeline.jsonl`.** That file cannot be read once it is over 4 MiB: a session waiting for you then uses the time its state file was last updated, and a running one shows `-`, unless the pane saw it finish while open, in which case that time is used.
- **Clicking a line does not switch to that session.** Claude Code 2.1.309 does not let a plugin in a background session switch sessions: Claude Code has its own "open another background session" path, but it is turned off inside background sessions, and there is no plugin interface for it. To go in, press ← at an empty prompt (or run `/background`) to get back to `claude agents` and pick it there, or use `claude attach <id>`.
- **Which session you opened is worked out by matching.** Opening a session from `claude agents` raises no event, and the opening record Claude Code leaves does not name the session; it only says how many messages that session's process had when it was first drawn. The plugin matches that against the counts of each session in `roster.json`, and counts it only when exactly one matches. A newly created session that has not been reopened has no counts; it is still recognized when it is the only such session. In these two cases it cannot tell, and you have to type once in that session before it leaves:
  - two sessions happen to have the same counts;
  - there is more than one newly created session that has not been reopened, and you open one of them (after a Claude Code update, sessions still running the old version count among them too).
- **Opening and closing are noticed up to 2 seconds late.** The opening records are checked every 2 seconds: a reply within 2 seconds after you closed a session may also count as seen.

## Development

- **Tests**: run `claude plugin test .` in this folder.
- **Files**:

| File | What it does |
|---|---|
| `hooks/register.tsx` | The plugin: the `/fleet` command and its setting, opening on entering a session, reading each session's files, watching the opening records, the refresh timers, drawing the list and the unread area |
| `hooks/jobs.ts` | Pure logic: the state (following the rules of `claude agents`), the time of the latest reply, which session an opening record is about, the order, how times are written, cutting names to fit |
| `hooks/layout.ts` | Pane layout: which part of the list to draw when it does not fit, how many unread lines (the unread area stays under the list, so the plugin scrolls the list itself) |
| `types/index.d.ts` | The types of the plugin's state |
| `tests/` | Plugin tests, with mocked files, clock and interface |

## License

[MIT](../../LICENSE)
