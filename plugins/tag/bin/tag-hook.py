#!/usr/bin/env python3
"""UserPromptSubmit hook：拦下 /tag，零模型开销地改状态灯。

拦下输入（decision=block + suppressOriginalPrompt），**自己把新标题写进会话状态
文件**，再把一行结果回给用户。整个过程不产生 API 调用，模型不参与。

为什么必须自己写盘：早先这里只发 hookSpecificOutput.sessionTitle，指望 Claude Code
去改标题——实测在 CC 2.1.241 上点不亮灯。当时是靠 commands/tag.md 里的 `!` 调
tag.py 在写盘，而那条路会先于本 hook 执行并改掉状态，导致本 hook 读到的是已经
变过的值、算出的提示比实际超前一格（实际 黄→绿，却提示 绿→黑）。
现在写盘和提示都归本 hook 一家做，两者必然一致。sessionTitle 仍然照发，
将来官方支持了也不冲突（目标名一样，幂等）。

只认 /tag（作为插件安装后，命令重名时会写成 /tag:tag，也认）。/rename、/name 一律放行
给内置命令处理。不匹配的输入直接 exit 0，什么都不做。
"""
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import tag as core  # noqa: E402

TRIGGER = re.compile(r"^/(?:tag:)?tag(?:\s+(.*))?$")


def emit(reason, title=None):
    out = {
        "decision": "block",
        "reason": reason,
        "hookSpecificOutput": {
            "hookEventName": "UserPromptSubmit",
            "suppressOriginalPrompt": True,
        },
    }
    if title is not None:
        out["hookSpecificOutput"]["sessionTitle"] = title
    sys.stdout.write(json.dumps(out, ensure_ascii=False))
    sys.exit(0)


def resolve(payload):
    """返回 (状态文件路径, 类型, 当前标题)。定位不到时路径为 None。

    标题优先读 state.json 的 name（会话列表显示的就是它），
    退而读 transcript 里最后一条 custom-title。
    """
    path, kind = core.find_state_file(payload.get("session_id"))
    name = ""
    if path:
        try:
            name = core.load(path).get("name") or ""
        except (RuntimeError, OSError):
            name = ""
    if not name:
        name = core.title_from_transcript(payload.get("transcript_path")) or ""
    return path, kind, name


def main():
    try:
        payload = json.load(sys.stdin)
    except ValueError:
        sys.exit(0)

    m = TRIGGER.match((payload.get("prompt") or "").strip())
    if not m:
        sys.exit(0)

    path, kind, title = resolve(payload)

    # 标题取不到就是空串，交给 plan_tag 处理（它会要求先起名字）
    new_name, msg, err = core.plan_tag(title, m.group(1) or "")
    if err:
        emit(err)

    # ? 查询、或目标就是当前状态：不用写盘
    if new_name is None:
        emit(msg)

    if kind == "mismatch":
        emit("当前进程的 session 与 CLAUDE_JOB_DIR 指向的会话不一致，拒绝写入——"
             "看起来是在别的会话里嵌套启动的，请在目标会话内直接用 /tag")
    if not path:
        emit("定位不到当前会话的状态文件，灯没点上——状态灯只能在 Claude Code 会话内使用")

    if not core.apply_name(path, kind, new_name):
        emit(f"灯可能没写住（会话进程正在改标题），再来一次：{msg}", new_name)

    emit(msg, new_name)


if __name__ == "__main__":
    # 这个 hook 会在每个会话的每次输入上运行。任何意外都必须静默放行，
    # 绝不能因为状态灯的问题挡住正常提问。
    try:
        main()
    except SystemExit:
        raise
    except BaseException:
        sys.exit(0)
