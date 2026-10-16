# key-points v0.2.1: mark the key points

English | [简体中文](README.zh-CN.md) · [← Back to the plugin list](../../README.md)

Each final Claude reply ends with a "📌 key points" link. Click it and Claude, with the whole conversation in view, picks the **key sentences** and **key words** out of that reply. They are marked right in the reply. Click again to clear them.

No new reply is written and the stored text is not touched. Only the way that reply is drawn changes.

## Install

```
/plugin marketplace add xsnuo/claude-code-plugins
/plugin install key-points@xuesinuo
```

## Usage

- **Mark**: click "📌 key points". While it works the link shows "⏳ key points…", usually for a few seconds. Once the marks are in, it changes to "📌 hide key points".
- **Clear**: click again and the reply goes back to how it was. Clicking once more shows the same marks straight away, without asking Claude again.
- **On errors**: the link says why, e.g. "⚠️ key points: API 529, retry". Click it to try again.
- **With aload**: when both plugins are installed, "🔊 read aload" and "📌 key points" each take their own line under the reply, one above the other. When one link's text gets longer or shorter, the other doesn't move.

### What counts as a key point

The plugin asks Claude to pick by these rules:

1. The core of what the conversation is about;
2. The part that answers your question directly and briefly;
3. What you need to know, or a decision you need to make;
4. Anything else Claude considers important.

There are two kinds: a key sentence is a sentence or part of one, a key word is a word or short phrase. A key word may sit inside a key sentence.

**Marks never cover more than 25% of the reply.** The plugin counts and enforces this itself instead of trusting Claude:
- It adds marks in Claude's order of importance and skips any mark that would push the total over 25%.
- A key word is marked everywhere it appears, and every occurrence counts.
- Text where a word and a sentence overlap is counted once.
- Code blocks don't count toward the reply's length.

### The background request stays out of the conversation

When you click, the plugin makes one extra request in the background: it carries the conversation's context as it is, plus this reply and the rules above.
- The request and its answer are not added to the conversation and never show on screen.
- In the rare case there is no context to carry, such as a resumed session you haven't talked in yet, it sends the reply alone.
- Effort: the request with the context reuses the main conversation's settings, and the plugin API offers no effort option for it; the reply-only request always uses medium effort, which is faster and cheaper.

## How marks look

By default, key sentences are drawn in yellow (the theme's `warning` color, readable on both dark and light themes), and key words get a highlighter-yellow background with black text.

Text color, background color and underline combine freely, and each kind is set on its own:

| Command | What it does |
|---|---|
| `/key-points` | Shows the current settings |
| `/key-points sentence color <color>` | Text color for key sentences; `none` keeps the normal color |
| `/key-points word bg <color>` | Background for key words; `none` for no background |
| `/key-points sentence underline on` | Underlines key sentences; `off` removes it |
| `/key-points reset` | Back to the defaults |

- Colors can be written four ways:
  - `#RRGGBB` or `#RGB`;
  - a color name such as `yellow` or `redBright`;
  - a theme color such as `warning` or `success`;
  - a one-character Chinese name such as `黄` (yellow) or `红` (red).
- Settings are saved and apply to later sessions too.
- An underline takes the text's color; its color can't be set on its own.

## Requirements

- **The Claude Code command line (CLI)**, version 2.1.299 or later (the version it was built and tested on). The VS Code extension, the desktop app and other forms are not supported.
- **Claude Code's fullscreen interface**, so you can click the link with the mouse.
  - Turn it on with `/tui fullscreen`, or put `"tui": "fullscreen"` in `~/.claude/settings.json`.
  - This is Claude Code's own interface mode; it has nothing to do with maximizing the terminal window.
- **A terminal that supports hyperlinks**; in other terminals the link can't be clicked. Terminals that work, for example:
  - macOS: iTerm2 or Ghostty (the built-in Terminal app does not);
  - Windows: Windows Terminal;
  - Linux: GNOME Terminal.

  If another terminal does support hyperlinks but isn't recognized, set the environment variable `FORCE_HYPERLINK=1` before starting Claude Code.
- **macOS, Windows and Linux.** The plugin is TypeScript only: no Python and no system commands. So far it has only been tested on macOS.

## Cost

Each click on "key points" makes one extra request, billed at your current model's rates:
- **Input**:
  - The earlier context shares the main conversation's prompt cache, so it is billed as cache reads, about 1/10 of the normal input price.
  - If you click long after the reply (once the cache has expired), the whole context is billed at the full price again.
- **Output**: only tens to a few hundred tokens.

Showing marks again after clearing them reuses the saved answer and costs nothing.

## Known limits

- **Paragraphs with marks are drawn by the plugin.** The engine's Markdown component can't color part of its text, so paragraphs that hold a mark are drawn line by line by the plugin. Bold, italics, inline code, links and lists are all reproduced, but they may look slightly different from the engine's drawing. Paragraphs without marks are still drawn by the engine.
- **Nothing inside code blocks or tables is marked.**
- **In aload's per-paragraph button modes (`/aload icon paragraph` or `hover`)**, while a reply is marked, aload's 🔊 next to each of its paragraphs is hidden; it comes back once you clear the marks. aload's default mode, one link at the end of each reply, doesn't have this problem.

## Development

- **Tests**: run `claude plugin test .` in this folder.
- **Files**:

| File | Purpose |
|---|---|
| `hooks/register.tsx` | The plugin: the link under each reply, the background request, the `/key-points` command |
| `hooks/marks.ts` | Pure logic: the request text, reading the answer, finding marks in the reply, the 25% cap, inline markdown parsing |
| `hooks/draw.tsx` | Draws a reply with its marks |
| `hooks/blocks.ts` | Splits a reply into paragraphs (the same way aload does) |
| `hooks/tree.ts` | Finds the engine's drawing of the reply in the tree from beneath and swaps only that for the marked one, keeping lines other plugins added under it |
| `types/index.d.ts` | Types of the plugin's state |
| `tests/` | Plugin tests, with a mocked engine and model, no network |

## License

[MIT](../../LICENSE)
