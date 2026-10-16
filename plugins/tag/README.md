# tag v2.0.0: session status light

English | [简体中文](README.zh-CN.md) · [← Back to the plugin list](../../README.md)

`/tag` puts a light (⚪🔴🟡🟢⚫) at the front of the session title, so the session list (`claude agents`) shows at a glance how far each session has got. If you use a status line that shows the session name, such as claude-hud, its title changes too.

You decide what each color means. For example: 🔴 waiting for me, 🟡 in progress, 🟢 done.

## Install

```
/plugin marketplace add xsnuo/claude-code-plugins
/plugin install tag@xuesinuo
```

## Usage

| Input | Effect |
|---|---|
| `/tag` | Cycle: none → ⚪ → 🔴 → 🟡 → 🟢 → ⚫ → none |
| `/tag 0` … `/tag 5` | Pick by position: 0 none, 1 white, 2 red, 3 yellow, 4 green, 5 black |
| `/tag yellow` | Pick by color; Chinese names, emoji and w / r / y / g / k also work |
| `/tag none` | Remove the light; `off` also works |
| `/tag new name` | Rename and keep the current light; `/tag 🟢 new name` also changes the light |
| `/tag ?` | Show the current state |

## Good to know

- **No model, no cost.** The plugin answers `/tag` itself.
- **Background sessions only.** Only background sessions (started with `claude --bg` and listed in `claude agents`) have a session state file. In a regular foreground session `/tag` says it can't find the session's state file.
- **It may break after an update.** tag changes the title by rewriting an undocumented Claude Code file (`~/.claude/jobs/<id>/state.json`, or under `CLAUDE_CONFIG_DIR` when that is set), so a Claude Code update may stop it working.
- **`/rename` removes the light.** The built-in `/rename` replaces the whole title, light included. Run `/tag` again to bring it back.
- **Unrecognized arguments become the new name.** For example, `/tag purple` renames the session to "purple".

## Requirements

- **The Claude Code command line (CLI)**, version 2.1.299 or later. The VS Code extension, the desktop app and other forms are not supported.
- **macOS, Windows and Linux.** The plugin is TypeScript only: no Python and no system commands. So far it has only been tested on macOS.

## Migrating

- **From 1.x**: 1.x caught `/tag` with a Python hook, which added a `UserPromptSubmit operation blocked by hook:` line every time. 2.0 answers the command in the plugin itself, so that line is gone and Python is no longer needed. Just update the plugin.
- **From a manual install under `~/.claude`**: remove these three things before installing the plugin, otherwise the old hook grabs `/tag` first:
  1. the `~/.claude/tag/` folder;
  2. `~/.claude/commands/tag.md`;
  3. the `UserPromptSubmit` hook in `~/.claude/settings.json` that runs `tag-hook.py`.

## Development

- **Tests**: run `claude plugin test .` in this folder.
- **Files**:

| File | Role |
|---|---|
| `hooks/core.ts` | Pure logic: works out the new title and the line you see from the current title and the argument |
| `hooks/register.ts` | The plugin: registers `/tag`, finds the session state file and writes it |
| `hooks/hooks.json` | Points at the plugin code above |
| `tests/` | Plugin tests: the pure-logic cases, plus sessions simulated on an in-memory file system |

## License

[MIT](../../LICENSE)
