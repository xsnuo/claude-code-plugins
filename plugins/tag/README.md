# tag: session status light

English | [简体中文](README.zh-CN.md) · [← Back to the plugin list](../../README.md)

`/tag` puts a light (⚪🔴🟡🟢⚫) at the front of the session title, so the session list shows at a glance how far each session has got. If you use a status line that shows the session name, such as claude-hud, its title changes too.

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

- **No model, no cost.** The plugin's hook catches `/tag` and handles it itself.
- **There is an extra line.** Each time, Claude Code first prints `UserPromptSubmit operation blocked by hook:`, followed by the result. This is expected: Claude Code always prints that line when a hook catches the input.
- **It may break after an update.** tag changes the title by rewriting an undocumented Claude Code file (`~/.claude/jobs/<id>/state.json`), so a Claude Code update may stop it working.
- **`/rename` removes the light.** The built-in `/rename` replaces the whole title, light included. Run `/tag` again to bring it back.
- **Unrecognized arguments become the new name.** For example, `/tag purple` renames the session to "purple".

## Migrating from a manual install

If you set up `/tag` by hand under `~/.claude` earlier, remove these three things before installing the plugin. Otherwise every `/tag` is handled twice and the light moves two steps:

1. the `~/.claude/tag/` folder;
2. `~/.claude/commands/tag.md`;
3. the `UserPromptSubmit` hook in `~/.claude/settings.json` that runs `tag-hook.py`.

## Development

- **Tests**: run `python3 tests/test_tag.py` in this folder.
- **Files**:

| File | Role |
|---|---|
| `bin/tag.py` | Core logic: works out the new title, finds the session state file and writes it; also works as a command-line tool |
| `bin/tag-hook.py` | Hook entry point: catches `/tag`, calls tag.py, replies with one line |
| `hooks/hooks.json` | Registers the hook above |
| `commands/tag.md` | Only makes `/tag` a known command. **Never add a `!` line that runs tag.py here**, or `/tag` is handled twice |
