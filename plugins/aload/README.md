# aload v0.5.0: click to read aloud

English | [简体中文](README.zh-CN.md) · [← Back to the plugin list](../../README.md)

Each final Claude reply ends with a "🔊 read aload" link. It reads only when you click, never on its own. The reply text and its layout stay exactly as they were, so reading and copying are not affected.

## Before you install

aload uses Python 3 to synthesize and play speech, so get these ready first:

| System | What it needs | How to install it |
|---|---|---|
| macOS | Python 3 (part of the Xcode Command Line Tools); playback uses the built-in `afplay` | Run `python3 --version` in a terminal. If a dialog offers to install the command line developer tools, click "Install"; or run `xcode-select --install` |
| Windows | Python 3; playback uses Python's own `winsound` | Install it from [python.org](https://www.python.org/downloads/) (keep the py launcher, which is ticked by default), or run `winget install Python.Python.3.13`. Afterwards `py -3 --version` should print a 3.x version |
| Linux | Python 3; playback uses one of `paplay`, `pw-play`, `aplay` | Debian, Ubuntu: `sudo apt install python3 pulseaudio-utils`; Fedora: `sudo dnf install python3 pulseaudio-utils` |

To click the button with the mouse you also need Claude Code's fullscreen interface and a terminal that supports hyperlinks; see [Requirements](#requirements) below.

## Install

```
/plugin marketplace add xsnuo/claude-code-plugins
/plugin install aload@xuesinuo
```

## Usage

- **From the top**: click "🔊 read aload" to read from the start to the end of that reply. Paragraphs follow on without gaps; code blocks are skipped and tables are read row by row.
- **From the middle**: select a few words with the mouse. The link changes to "🔊 read aload on selected"; click it to read from there on.
- **Stop**: while reading, the link shows "🔇 stop reading 2/5"; click it to stop. Leaving the session also stops it.
- **One voice at a time**: only one reading plays on the machine. Starting a new one anywhere stops the old one.
- **With key-points**: when both plugins are installed, "🔊 read aload" and [key-points](../key-points/README.md)' "📌 key points" each take their own line under the reply, one above the other. When one link's text gets longer or shorter, the other doesn't move.

## First use: set up a key

The first click opens a key form. The plugin really synthesizes a short "你好" to check the key, and saves it only if that works.

- **Azure Speech** (default, has a free tier): in the Azure portal, create a Speech resource with the F0 tier (500,000 characters free per month). On its "Keys and Endpoint" page, copy the key and the region (for example `eastasia`).
- **Doubao TTS 2.0**: in the Volcengine console, enable "豆包语音合成模型 2.0", then create a key under "API Key 管理". **Leave App ID empty**; only the old console uses App ID plus Access Token. If it says the key is valid but has no permission yet, the service is not fully enabled.

Switch provider with `/aload doubao` or `/aload azure`. Keys stay on your machine in `~/.config/aload/credentials.json` and never enter the conversation. On macOS and Linux the file has mode 600 (only you can read it); on Windows it relies on the permissions of your user folder. Note: the key form shows the key in plain text, so take care when sharing your screen.

## Commands

| Command | What it does |
|---|---|
| `/aload` | Show the provider, keys (last 4 characters only) and voices |
| `/aload azure` / `/aload doubao` | Switch provider; opens the key form if there is no key |
| `/aload key [provider]` | Enter a key again |
| `/aload voice <voice>` | Set the voice for the current provider, e.g. `zh-CN-YunxiNeural` |
| `/aload icon reply` / `paragraph` / `hover` | Where the button goes: end of each reply (default) / left of each paragraph / left of each paragraph, shown on hover |
| `/aload stop` | Stop reading |

## Requirements

- **The Claude Code command line (CLI)**, version 2.1.299 or later. The VS Code extension, the desktop app and other forms are not supported.
- **Claude Code's fullscreen interface**, so you can click the button and select text with the mouse.
  - Turn it on with `/tui fullscreen`, or put `"tui": "fullscreen"` in `~/.claude/settings.json`.
  - This is Claude Code's own interface mode; it has nothing to do with maximizing the terminal window.
- **A terminal that supports hyperlinks.** The button is a link: in a terminal without hyperlink support it shows a URL after the text and cannot be clicked. Terminals that work, for example:
  - macOS: iTerm2 or Ghostty (the built-in Terminal app does not);
  - Windows: Windows Terminal;
  - Linux: GNOME Terminal.

  If another terminal does support hyperlinks but isn't recognized, set the environment variable `FORCE_HYPERLINK=1` before starting Claude Code. Failing that, use `/aload icon paragraph`, which puts a clickable 🔊 to the left of each paragraph.
- **Python 3 and a player**: see [Before you install](#before-you-install) above for how to install them.
  - The plugin tries `/usr/bin/python3`, `python3`, `py -3` and `python` in turn and uses the first working Python 3.
  - To use another player, set the environment variable `ALOAD_PLAYER` before starting Claude Code, for example `mpv --no-video`; the audio file's path is added at the end.
- **macOS, Windows and Linux.** So far it has only been tested on macOS; the Windows and Linux support has not been tried on a real machine yet.

## Privacy: sensitive data is masked before anything is sent

Reading aloud sends the text to a third party (Azure or Doubao). If a reply contains a key, a password or the like, it would be sent too. So before each reading the plugin runs two checks:

1. **Claude points out sensitive data**, using your current model at medium effort. It only lists the pieces to mask instead of rewriting the text, so its answer is short.
2. **Local rules as a backstop**: well-known formats (keys starting with `sk-`, AWS access keys, GitHub tokens, JWTs, private keys, and patterns like "password: xxx" or "token=xxx") catch anything the first step missed.

Whatever is found is replaced by a word that says what it is, so it is read out as "密钥" (key), "密码" (password) and so on:

| In the reply | Replaced by |
|---|---|
| API keys, tokens, secrets, private keys, cookies | 【密钥】 (key) |
| Passwords | 【密码】 (password) |
| User IDs, account IDs, UIDs | 【UID】 |
| Phone, ID card and bank card numbers, email addresses | 【手机号】【身份证号】【银行卡号】【邮箱】 |
| Other credentials or private data | A short name Claude picks, e.g. 【会话标识】 (session ID) |

- **If the first step fails** (network trouble, an API error), that reading uses the local rules only, and a toast says so.
- **Reading the same text again** reuses the last check instead of asking Claude again.
- What is never read is never sent: code blocks are skipped, URLs are read as "链接" (link), and inline code longer than 40 characters is read as "一段代码" (a piece of code).

## Cost

- **The sensitive-data check**: one small extra request before each reading, billed at your current model's rates: a few hundred input tokens and a few dozen output tokens. With Opus it took about 3 seconds in testing, so the sound starts a moment after you click.

Both speech providers charge by the number of characters synthesized:
- **It requests as it reads**: the plugin cuts the text into chunks of up to 220 characters, paragraph by paragraph, and requests each chunk only as reading reaches it. Once you stop, no more requests are sent.
- **Stopping midway costs a little extra**: to avoid gaps it synthesizes up to 3 chunks ahead, so stopping midway costs at most a few hundred extra characters.

## Troubleshooting

The log is `~/.cache/aload/aload.log` (on Windows, `%USERPROFILE%\.cache\aload\aload.log`). It records the provider and voice of each reading, how long until the first sound, and why a reading failed.

## Development

- **Tests**: run these in this folder
  - plugin: `claude plugin test .`
  - helper: `python3 -m unittest discover -s tests` (on macOS or Linux)
- **Files**:

| File | Role |
|---|---|
| `hooks/register.tsx` | The plugin: the button at the end of replies, per-paragraph icons, `/aload`, the key form |
| `hooks/blocks.ts` | Splits a reply into paragraphs, finds the selected text, turns markdown into text to speak |
| `hooks/redact.ts` | Masks sensitive data before reading: the request to Claude, reading its answer, the local backstop rules |
| `hooks/tree.ts` | In per-paragraph mode, tells the engine's drawing of the reply apart from what other plugins added under it |
| `bin/aload.py` | Local helper: synthesizes with Azure / Doubao, plays with the player that fits the system, keeps settings and keys (Python standard library only) |
| `types/index.d.ts` | Types of the plugin's state |
| `tests/` | Plugin and helper tests; the tests use a local fake API, no network and no sound |

## License

[MIT](../../LICENSE)
