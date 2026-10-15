# claude-code-plugins

English | [简体中文](README.zh-CN.md)

Claude Code plugins by xuesinuo, published as the `xuesinuo` plugin marketplace. Each plugin installs on its own, so pick only what you need.

## Plugins

| Plugin | What it does |
|---|---|
| [tag](plugins/tag/README.md) | `/tag` puts a status light ⚪🔴🟡🟢⚫ at the front of the session title, so you can see each session's state at a glance in the session list |
| [aload](plugins/aload/README.md) | A "🔊 read aload" link at the end of each reply reads it out loud only when you click, optionally starting from the text you selected (Azure / Doubao TTS 2.0) |

## About the plugins

### tag: session status light

With many background sessions it is easy to lose track of which one is waiting for you and which one is done. tag puts a light at the front of the session title. You decide what each color means.

- `/tag`: cycle to the next color.
- `/tag yellow`: set a color directly.
- `/tag new name`: rename the session and keep the light.

The plugin handles `/tag` itself, without the model, so it costs nothing.

[Details →](plugins/tag/README.md)

### aload: click to read aloud

It reads only when you click, never on its own.

- **From the top**: click "🔊 read aload" to read from the start to the end of that reply.
- **From the middle**: select a few words first, then click, to start from there.
- **Pay only for what you hear**: it calls the speech API paragraph by paragraph while reading and makes no more requests once you stop.

You need your own Azure Speech key (it has a monthly free tier) or a Doubao (Volcengine) TTS 2.0 key.

[Details →](plugins/aload/README.md)

## Install

Run these in Claude Code:

```
/plugin marketplace add xsnuo/claude-code-plugins
/plugin install tag@xuesinuo
/plugin install aload@xuesinuo
```

The first line adds the marketplace and only needs to run once. Install whichever of the other two you want.

- **Update**: `/plugin marketplace update xuesinuo`.
- **Disable or uninstall**: use `/plugin`.

## Requirements

- macOS
- python3 (the system one is fine)
- Claude Code 2.1.293 or later
- aload has extra requirements: fullscreen mode and a terminal that supports hyperlinks. See [aload's requirements](plugins/aload/README.md#requirements).
