#!/usr/bin/env python3
"""会话状态灯：把 ⚪🔴🟡🟢⚫ 之一放在会话标题首位。

纯逻辑（plan_tag）不碰文件，供两个入口共用：
  - tag-hook.py：UserPromptSubmit hook，拦下 /tag，自己调 apply_name 写盘，
    模型完全不介入。代价是会打印一行 "UserPromptSubmit operation blocked by
    hook:"（机制所限，无法去掉）。注意 hookSpecificOutput.sessionTitle 单独
    点不亮灯（CC 2.1.241 实测无效），所以必须写盘
  - 本文件的 CLI：直接改 ~/.claude/jobs/<jobId>/state.json 的 name 字段。
    给 TUI 的 ! 本地命令模式（!cctag）用，加 -q 后成功时零输出

标题改完，会话列表（读 state.json 的 name）和底部 HUD（读 transcript 里的
custom-title 记录）都会跟着变。

CLI 用法：
  tag.py            不带参数轮换：无 → ⚪ → 🔴 → 🟡 → 🟢 → ⚫ → 无
  tag.py 黄         直接指定：白|红|黄|绿|黑，也认 emoji 和 w/r/y/g/k
  tag.py 3          按格号指定：0无 1白 2红 3黄 4绿 5黑（顺序同轮换环）
  tag.py 无         摘掉灯，名字不动（也认 0/none/off/clear/x/-）
  tag.py 新名字      改名并保留当前的灯；tag.py '🟢 新名字' 可以同时换灯
  tag.py '?'        只看当前状态，不改
  tag.py -q         静音（改动成功时不打印；出错和查询照常打印）

注意：
  - 认不出的参数一律当成新名字，所以 tag.py 紫 会把会话改名成"紫"而不是报错。
    消息里带着旧标题，改错了照着改回去即可。
  - 0~5、无/none/off/clear/x/- 被参数占用，想拿它们当名字请走 /rename。
  - 内置 /rename 会整体替换标题，首位的灯会被一起抹掉，重新 /tag 一下即可。

纯逻辑测试：python3 tests/test_tag.py（在插件目录下运行）
"""
import glob
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time

LIGHTS = ["⚪", "🔴", "🟡", "🟢", "⚫"]
NAMES = {"⚪": "白", "🔴": "红", "🟡": "黄", "🟢": "绿", "⚫": "黑"}
VS16 = "️"

# 数字就是环上的格号：0 无 · 1 ⚪ · 2 🔴 · 3 🟡 · 4 🟢 · 5 ⚫（0 归 NONE_ALIASES 管）
ALIASES = {
    "⚪": "⚪", "白": "⚪", "w": "⚪", "white": "⚪", "1": "⚪",
    "🔴": "🔴", "红": "🔴", "r": "🔴", "red": "🔴", "2": "🔴",
    "🟡": "🟡", "黄": "🟡", "y": "🟡", "yellow": "🟡", "3": "🟡",
    "🟢": "🟢", "绿": "🟢", "g": "🟢", "green": "🟢", "4": "🟢",
    "⚫": "⚫", "黑": "⚫", "k": "⚫", "black": "⚫", "5": "⚫",
}
SHOW = {"?", "？", "show", "status", "h", "help"}
# 摘灯。注意这几个词因此不能再当名字用了——想叫这个名字请用 /rename
NONE_ALIASES = {"0", "无", "無", "none", "off", "clear", "x", "-"}

USAGE = ("用法：/tag 轮换 · /tag 0~5 指定（0无 1白 2红 3黄 4绿 5黑，也认中文和 emoji）· "
         "/tag <新名字> 改名（保留当前灯）· /tag ? 查看")


# ---------------------------------------------------------------- 纯逻辑

def split_light(name):
    """把标题拆成 (灯, 其余)。没灯则灯为 None。"""
    name = name or ""
    for lit in LIGHTS:
        for prefix in (lit + VS16, lit):
            if name.startswith(prefix):
                return lit, name[len(prefix):].lstrip()
    return None, name


def compose(light, rest):
    rest = (rest or "").strip()
    if light is None:
        return rest
    return f"{light} {rest}" if rest else light


def dial(light):
    """无 ⚪ 🔴 [🟡] 🟢 ⚫ 这样的一行状态盘，"无"也是环上的一格。"""
    cells = ["[无]" if light is None else "无"]
    cells += [("[" + x + "]") if x == light else x for x in LIGHTS]
    return " ".join(cells)


def describe_light(old, new):
    """把一次灯的变化说成一句话。old/new 为 None 表示没有灯。"""
    if old == new:
        return "灯不变" if new is None else f"{new} {NAMES[new]}灯不变"
    if old is None:
        return f"点灯 {new} {NAMES[new]}"
    if new is None:
        return f"摘灯 {old} {NAMES[old]} → 无"
    return f"{old} {NAMES[old]} → {new} {NAMES[new]}"


def plan_tag(name, arg):
    """返回 (新标题 or None, 给用户看的一行, 错误 or None)。新标题为 None 表示不用改。

    参数分五类：
      ? ？ show     只看当前状态，不改
      （不带参数）    沿环轮换：无 → ⚪ → 🔴 → 🟡 → 🟢 → ⚫ → 无
      白红黄绿黑      直接指定灯，名字不动
      无 none off   摘掉灯，名字不动
      其余任何文字    当作改名，保留当前的灯（相当于会留灯的 /rename）；
                    文本自带灯时以它为准，于是 "/tag 🟢 新名字" 一步到位
    """
    light, rest = split_light(name)
    a = (arg or "").strip()
    key = a.rstrip(VS16).lower()

    if key in SHOW:
        return None, f"{dial(light)}  标题：{name or '(空)'}\n{USAGE}", None

    # ---------------------------------------------- 定出目标灯 + 目标名字
    if a == "":
        # 轮换。把"没有灯"也算作环上的一格
        if light is None:
            target = LIGHTS[0]
        elif light == LIGHTS[-1]:
            target = None
        else:
            target = LIGHTS[LIGHTS.index(light) + 1]
        new_rest = rest
    elif key in NONE_ALIASES:
        target, new_rest = None, rest
    elif key in ALIASES:
        target, new_rest = ALIASES[key], rest
    else:
        # 认不出的一律当改名。文本里自带灯就用它，免得拼出两个灯的标题
        typed_light, typed_rest = split_light(a)
        if not typed_rest:
            return None, None, f"新名字不能为空（只收到 “{a}”）"
        target = typed_light if typed_light is not None else light
        new_rest = typed_rest

    # ------------------------------------------------------------ 组装
    if target == light and new_rest == rest:
        if light is None:
            return None, f"本来就没有灯 · {name or '(空)'}", None
        return None, f"{light} {NAMES[light]}灯，没变化 · {name}", None

    # 标题不能只剩一个灯：全新会话还没起名时就是这种情况，光秃秃一个灯在列表里没意义
    if not new_rest:
        if target is None:
            return None, None, f"摘掉灯之后标题就空了（当前标题只有 “{name}”），先用 /tag <新名字> 起个名字"
        return None, None, "这个会话还没有标题，先用 /tag <新名字> 给它起个名字，再点灯"

    new_name = compose(target, new_rest)
    if new_rest != rest:
        # 改了名字：把改名放在前面，灯的变化（如果有）跟在后面
        change = "改名" if target == light else f"改名 + {describe_light(light, target)}"
        msg = f"{change} · {name or '(空)'} → {new_name}"
    else:
        msg = f"{describe_light(light, target)} · {new_name}"
    return new_name, msg, None


# ------------------------------------------------------------ 会话状态文件

def _ppid_chain(limit=8):
    """当前进程往上的 pid 链。给 ! 本地命令模式兜底——那里未必有 CLAUDE_* 环境变量。"""
    chain = []
    pid = os.getpid()
    for _ in range(limit):
        if pid <= 1:
            break
        chain.append(pid)
        try:
            out = subprocess.run(["ps", "-o", "ppid=", "-p", str(pid)],
                                 capture_output=True, text=True, timeout=2).stdout.strip()
        except (OSError, subprocess.SubprocessError):
            break
        if not out.isdigit():
            break
        pid = int(out)
    return chain


def _by_pid(home, pid):
    """~/.claude/sessions/ 里的文件就是按 pid 命名的。"""
    f = os.path.join(home, "sessions", f"{pid}.json")
    if not os.path.exists(f):
        return None
    try:
        with open(f, encoding="utf-8") as fh:
            d = json.load(fh)
    except (OSError, ValueError):
        return None
    job_id = d.get("jobId")
    if job_id:
        p = os.path.join(home, "jobs", job_id, "state.json")
        if os.path.exists(p):
            return p, "job"
    return f, "session"


def find_state_file(sid=None):
    """返回 (路径, 类型)。job = jobs/<id>/state.json，session = sessions/<pid>.json。"""
    override = os.environ.get("TAG_STATE_FILE")
    if override:
        return override, "job"

    home = os.path.expanduser("~/.claude")
    sid = sid or os.environ.get("CLAUDE_CODE_SESSION_ID")

    # 先按 session id 精确定位。嵌套会话（在会话里再起一个 claude）会继承父进程的
    # CLAUDE_JOB_DIR，只认 job dir 会把灯打到父会话头上。
    if sid:
        for f in sorted(glob.glob(os.path.join(home, "sessions", "*.json"))):
            try:
                with open(f, encoding="utf-8") as fh:
                    d = json.load(fh)
            except (OSError, ValueError):
                continue
            if d.get("sessionId") != sid:
                continue
            job_id = d.get("jobId")
            if job_id:
                p = os.path.join(home, "jobs", job_id, "state.json")
                if os.path.exists(p):
                    return p, "job"
            return f, "session"

    # ! 本地命令模式下可能没有 CLAUDE_CODE_SESSION_ID，退回按进程 pid 找
    env_pid = os.environ.get("CLAUDE_PID")
    if env_pid and env_pid.isdigit():
        hit = _by_pid(home, int(env_pid))
        if hit:
            return hit
    for pid in _ppid_chain():
        hit = _by_pid(home, pid)
        if hit:
            return hit

    job_dir = os.environ.get("CLAUDE_JOB_DIR")
    if job_dir:
        p = os.path.join(job_dir, "state.json")
        if os.path.exists(p):
            if sid:
                try:
                    with open(p, encoding="utf-8") as fh:
                        d = json.load(fh)
                except (OSError, ValueError):
                    d = {}
                if sid not in (d.get("sessionId"), d.get("resumeSessionId")):
                    return None, "mismatch"
            return p, "job"
    return None, None


def load(path):
    """daemon 会高频重写这个文件，读到半截 JSON 就重试。"""
    err = None
    for _ in range(4):
        try:
            with open(path, encoding="utf-8") as fh:
                return json.load(fh)
        except ValueError as exc:
            err = exc
            time.sleep(0.06)
        except OSError as exc:
            raise RuntimeError(f"读不到会话状态文件：{exc}")
    raise RuntimeError(f"会话状态文件正在被写入，重试 4 次仍失败（{err}），稍后再试")


def save(path, data):
    d = os.path.dirname(path)
    fd, tmp = tempfile.mkstemp(dir=d, prefix=".tag-")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(data, fh, ensure_ascii=False, indent=2)
        shutil.copymode(path, tmp)
        os.replace(tmp, path)
    except BaseException:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise


def title_from_transcript(transcript_path):
    """从 transcript 里最后一条 custom-title 记录取标题（HUD 读的就是这个）。"""
    if not transcript_path or not os.path.exists(transcript_path):
        return None
    title = None
    try:
        with open(transcript_path, encoding="utf-8", errors="replace") as fh:
            for line in fh:
                if '"custom-title"' not in line:
                    continue
                try:
                    d = json.loads(line)
                except ValueError:
                    continue
                if d.get("type") == "custom-title" and isinstance(d.get("customTitle"), str):
                    title = d["customTitle"]
    except OSError:
        return None
    return title


def apply_name(path, kind, new_name):
    """把新标题写进会话状态文件。写住了返回 True。

    会话进程会周期性把自己内存里的标题刷回 state.json，连按时可能把刚写的
    名字顶掉。校验一下，被顶掉就再写，最多补三次。

    CLI 和 hook 共用这个函数——两边都必须真的写文件。hook 光靠
    hookSpecificOutput.sessionTitle 点不亮灯（实测在 CC 2.1.241 上无效），
    所以不能只发消息不写盘。
    """
    def write_once():
        d = load(path)         # 写前再读一次，尽量贴近 daemon 的最新状态
        d["name"] = new_name
        if kind == "job":
            d["nameSource"] = "user"
        save(path, d)

    write_once()
    for _ in range(3):
        time.sleep(0.12)
        try:
            if load(path).get("name") == new_name:
                return True
        except RuntimeError:
            return False
        write_once()
    return False


# ------------------------------------------------------------------- CLI

def main():
    argv = sys.argv[1:]
    # 静音模式：改动成功时什么都不打印（给 ! 本地命令模式用）。错误和查询照常输出。
    quiet = os.environ.get("TAG_QUIET") == "1"
    while argv and argv[0] in ("-q", "--quiet"):
        quiet = True
        argv = argv[1:]
    if argv and argv[0] == "--":
        argv = argv[1:]
    arg = argv[0] if argv else ""

    path, kind = find_state_file()
    if kind == "mismatch":
        print("当前进程的 session 与 CLAUDE_JOB_DIR 指向的会话不一致，拒绝写入——"
              "看起来是在别的会话里嵌套启动的，请在目标会话内直接用 /tag")
        sys.exit(1)
    if not path:
        print("定位不到当前会话的状态文件——状态灯只能在 Claude Code 会话内使用")
        sys.exit(1)

    try:
        data = load(path)
    except RuntimeError as exc:
        print(str(exc))
        sys.exit(1)

    new_name, msg, err = plan_tag(data.get("name") or "", arg)
    if err:
        print(err)
        sys.exit(1)

    if new_name is not None:
        if not apply_name(path, kind, new_name):
            print(f"灯可能没写住（会话进程正在改标题），再来一次：{msg}")
            sys.exit(1)
        if quiet:
            return
    print(msg)


if __name__ == "__main__":
    main()
