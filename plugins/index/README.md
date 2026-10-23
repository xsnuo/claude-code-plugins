# index v0.1.0: conversation index

English | [简体中文](README.zh-CN.md) · [← Back to the plugin list](../../README.md)

Run `/index` and a table of contents of this session opens on the right: one entry per turn, with a short form of what you asked on top and a one-line summary of Claude's answer below. Click an entry and the conversation on the left jumps to that prompt.

## Install

```
/plugin marketplace add xsnuo/claude-code-plugins
/plugin install index@xuesinuo
```

## Usage

- **Open and close**: run `/index`. The ✕ at the pane's top right closes it too. It can be opened at any time, even while Claude is answering.
- **Reading the index**: each entry has two parts.
  - The first line is the number and your prompt, cut with … when it is too wide;
  - below it, up to two lines summarize the answer;
  - the turn being answered shows "⋯ 回答中" (answering) and gets its summary once it is done;
  - scroll a long index with the mouse wheel. It opens at the latest turns, and new turns are added at the end.
- **Jumping**: click an entry and the conversation scrolls to that prompt, with the prompt at the top of the screen.
  - Older prompts are not drawn yet, so the plugin first scrolls up screen by screen to find them, showing "正在往上翻找第 N 轮…" (searching upward for turn N). This usually takes a second or two.
  - When a prompt is very far up and one click does not reach it, it says "再点一次，接着往上找" (click again to keep searching); click again and it carries on.
  - While a subagent's transcript is shown, a click first switches back to the main conversation.
- **Summaries**: by default Claude (haiku) writes them in the background, one per turn.
  - Only while the index is open, so a closed index costs nothing;
  - written summaries are kept on this machine and are not written again, also after resuming a session;
  - if writing one fails, the first sentence of the answer is shown, and it is tried again the next time the index opens;
  - `/index summary off`: don't ask Claude, use the answer's first sentence; `/index summary on` turns it back on. The setting is saved.

### What counts as a turn

A turn runs from one of your prompts to the next; its summary is based on Claude's last text in that turn (the final answer).

- Background task notifications and messages from other sessions are not turns, and the replies they trigger are not counted into the previous turn;
- slash commands: those that get an answer (skills, prompt commands) are turns; local commands without an answer, such as `/clear` and `/reload-plugins`, are not;
- a turn that was interrupted or has no text answer shows "（没有文字回复）" (no text reply);
- after `/clear` the index is empty and starts over with the new conversation.

## Requirements

- **The Claude Code command line (CLI)**, version 2.1.307 or later (developed and tested on that version). The VS Code extension, the desktop app and other forms are not supported.
- **Claude Code's fullscreen interface**, so that the index docks on the right and clicks can jump.
  - Turn it on with `/tui fullscreen`, or put `"tui": "fullscreen"` in `~/.claude/settings.json`.
  - This is Claude Code's own interface mode and has nothing to do with maximizing the terminal window.
  - Outside the fullscreen interface the index shows above the prompt, to read only: clicking does not jump.
  - In a narrow terminal (under 110 columns) the index also shows above the prompt.
- **macOS, Windows and Linux.** The plugin is TypeScript only: no Python, no system commands. So far it has only been tested on macOS.

## Cost

Each turn's summary is one request to haiku at low effort:
- **Input**: that turn's prompt (up to about 1,500 characters) and final answer (up to about 8,000 characters; for longer ones the start and the end);
- **Output**: one sentence, a few dozen tokens.

The first time you open the index in a long session, every turn without a summary gets one (newest first, two at a time); after that only new turns do. To avoid this cost, use `/index summary off`.

## Known limitations

- **Turns before a compaction (`/compact`) are not listed.** The index follows the current conversation record, and the screen no longer shows what came before either.
- **Only the latest 300 turns are listed.**
- **Jumping needs to know where the row is on screen.** The plugin API's conversation record has no per-message ids, so the plugin matches the rows the interface draws to the index by their text.
  - Prompts with exactly the same text (say several "继续", continue) are told apart by their order; in rare cases a click may land on the neighboring one;
  - turns that are folded away and not shown cannot be reached; you are told it was not found.
- **Summaries are written by Claude** and may occasionally be off. The conversation itself is what counts.

## Development

- **Tests**: run `claude plugin test .` in this folder.
- **Files**:

| File | Purpose |
|---|---|
| `hooks/register.tsx` | The plugin: the `/index` command, the index pane, background summaries, click to jump |
| `hooks/turns.ts` | Pure logic: splitting the conversation record into turns, cutting and wrapping for display, the summary prompt, matching index entries to rows on screen |
| `hooks/rows.ts` | Keeps the rows the interface drew: prompt rows' ids and order, and where reply and tool-call rows sit in the conversation record |
| `hooks/jump.ts` | Jumping: find the row (scrolling up to it when it is not drawn yet), then bring it to the top of the screen |
| `types/index.d.ts` | Types of the plugin's state |
| `tests/` | Plugin tests with a simulated engine, model and screen, no network |

## License

[MIT](../../LICENSE)
