# aload: click to read aloud

English | [简体中文](README.zh-CN.md) · [← Back to the plugin list](../../README.md)

Each final Claude reply ends with a "🔊 read aload" link. It reads only when you click, never on its own. The reply text and its layout stay exactly as they were, so reading and copying are not affected.

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

## First use: set up a key

The first click opens a key form. The plugin really synthesizes a short "你好" to check the key, and saves it only if that works.

- **Azure Speech** (default, has a free tier): in the Azure portal, create a Speech resource with the F0 tier (500,000 characters free per month). On its "Keys and Endpoint" page, copy the key and the region (for example `eastasia`).
- **Doubao TTS 2.0**: in the Volcengine console, enable "豆包语音合成模型 2.0", then create a key under "API Key 管理". **Leave App ID empty**; only the old console uses App ID plus Access Token. If it says the key is valid but has no permission yet, the service is not fully enabled.

Switch provider with `/aload doubao` or `/aload azure`. Keys stay on your machine in `~/.config/aload/credentials.json` (mode 600) and never enter the conversation. Note: the key form shows the key in plain text, so take care when sharing your screen.

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

- **macOS**: it uses the system `/usr/bin/python3` and `afplay`; nothing else to install.
- **Claude Code 2.1.293 or later in fullscreen mode** (`/tui fullscreen`), so you can click the button and select text with the mouse.
- **A terminal that supports hyperlinks**, such as Ghostty or iTerm2. The button is a link: in a terminal without hyperlink support it shows a URL after the text and cannot be clicked. In that case, use `/aload icon paragraph`.

## Cost

Both providers charge by the number of characters synthesized:
- **It requests as it reads**: the plugin cuts the text into chunks of up to 220 characters, paragraph by paragraph, and requests each chunk only as reading reaches it. Once you stop, no more requests are sent.
- **Stopping midway costs a little extra**: to avoid gaps it synthesizes up to 3 chunks ahead, so stopping midway costs at most a few hundred extra characters.

## Troubleshooting

See the log with `tail ~/.cache/aload/aload.log`. It records the provider and voice of each reading, how long until the first sound, and why a reading failed.

## Development

- **Tests**: run these in this folder
  - plugin: `claude plugin test .`
  - helper: `python3 -m unittest discover -s tests`
- **Files**:

| File | Role |
|---|---|
| `hooks/register.tsx` | The plugin: the button at the end of replies, per-paragraph icons, `/aload`, the key form |
| `hooks/blocks.ts` | Splits a reply into paragraphs, finds the selected text, turns markdown into text to speak |
| `bin/aload.py` | Local helper: synthesizes with Azure / Doubao, plays with afplay, keeps settings and keys (Python standard library only) |
| `types/index.d.ts` | Types of the plugin's state |
| `tests/` | Plugin and helper tests; the tests use a local fake API, no network and no sound |

## License

[MIT](../../LICENSE)
