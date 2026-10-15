#!/usr/bin/env python3
"""plan_tag 的纯逻辑测试，外加 hook 认不认得 /tag。不碰任何文件，在插件目录下跑：python3 tests/test_tag.py

这块代码 2026-08-28 翻过两次车（提示错位一格、改完不写盘），所以留一份测试。
新增分支时请一并补用例。
"""
import importlib.util
import os
import sys

BIN = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "bin")
sys.path.insert(0, BIN)
import tag as core  # noqa: E402

# tag-hook.py 的文件名带连字符，不能直接 import
_spec = importlib.util.spec_from_file_location("tag_hook", os.path.join(BIN, "tag-hook.py"))
hook = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(hook)

# (输入, 期望认出的参数；None = 不该拦)
TRIGGERS = [
    ("/tag", ""),
    ("/tag 黄", "黄"),
    ("/tag:tag 3", "3"),  # 作为插件安装、命令重名时的写法
    ("/tagx", None),
    ("/rename 新名字", None),
    ("说说 /tag 怎么用", None),
]

# (说明, 当前标题, 参数, 期望新标题, 期望消息里必须出现的片段)
# 期望新标题为 None = 不改标题；为 ERR = 应当报错
ERR = object()
CASES = [
    # ── 轮换（回归）
    ("轮换 无→白",      "我的会话",      "",     "⚪ 我的会话", "点灯 ⚪ 白"),
    ("轮换 白→红",      "⚪ 我的会话",   "",     "🔴 我的会话", "⚪ 白 → 🔴 红"),
    ("轮换 黄→绿",      "🟡 我的会话",   "",     "🟢 我的会话", "🟡 黄 → 🟢 绿"),
    ("轮换 黑→无",      "⚫ 我的会话",   "",     "我的会话",    "摘灯 ⚫ 黑 → 无"),
    # ── 指定颜色（回归）
    ("指定 绿",         "🟡 我的会话",   "绿",   "🟢 我的会话", "🟡 黄 → 🟢 绿"),
    ("指定 别名 g",     "🟡 我的会话",   "g",    "🟢 我的会话", "🟢 绿"),
    ("指定 emoji",      "🟡 我的会话",   "🟢",   "🟢 我的会话", "🟢 绿"),
    ("指定 同色无变化", "🟡 我的会话",   "黄",   None,          "没变化"),
    # ── 新：摘灯
    ("摘灯 无",         "🟡 我的会话",   "无",   "我的会话",    "摘灯 🟡 黄 → 无"),
    ("摘灯 none",       "🟢 我的会话",   "none", "我的会话",    "摘灯 🟢 绿 → 无"),
    ("摘灯 off",        "🔴 我的会话",   "off",  "我的会话",    "摘灯 🔴 红 → 无"),
    ("摘灯 x",          "⚪ 我的会话",   "x",    "我的会话",    "摘灯 ⚪ 白 → 无"),
    ("摘灯 但本来没灯", "我的会话",      "无",   None,          "本来就没有灯"),
    ("摘灯 会摘空",     "🟡",            "无",   ERR,           "标题就空了"),
    # ── 新：改名（保留灯）
    ("改名 保留黄灯",   "🟡 旧名字",     "新名字",      "🟡 新名字", "改名"),
    ("改名 无灯会话",   "旧名字",        "新名字",      "新名字",    "改名"),
    ("改名 多个词",     "🟡 旧名字",     "我 的 新 会话", "🟡 我 的 新 会话", "改名"),
    ("改名 同名无变化", "🟡 我的会话",   "我的会话",    None,        "没变化"),
    ("改名 给空标题起名", "",            "全新会话",    "全新会话",  "改名"),
    ("改名 带灯一步到位", "🟡 旧名字",   "🟢 新名字",   "🟢 新名字", "改名 + 🟡 黄 → 🟢 绿"),
    ("改名 带灯给无灯会话", "旧名字",    "🔴 新名字",   "🔴 新名字", "改名 + 点灯 🔴 红"),
    # ── 新：数字格号 0~5
    ("数字 0 摘灯",     "🟡 我的会话",   "0",    "我的会话",    "摘灯 🟡 黄 → 无"),
    ("数字 1 白",       "🟡 我的会话",   "1",    "⚪ 我的会话", "🟡 黄 → ⚪ 白"),
    ("数字 2 红",       "🟡 我的会话",   "2",    "🔴 我的会话", "🟡 黄 → 🔴 红"),
    ("数字 3 黄",       "🟢 我的会话",   "3",    "🟡 我的会话", "🟢 绿 → 🟡 黄"),
    ("数字 4 绿",       "🟡 我的会话",   "4",    "🟢 我的会话", "🟡 黄 → 🟢 绿"),
    ("数字 5 黑",       "🟡 我的会话",   "5",    "⚫ 我的会话", "🟡 黄 → ⚫ 黑"),
    ("数字 同色无变化", "🟡 我的会话",   "3",    None,          "没变化"),
    ("数字 0 但没灯",   "我的会话",      "0",    None,          "本来就没有灯"),
    ("超出0~5的数字不当灯", "🟡 旧名字", "6",   "🟡 6",        "改名"),
    # ── 查询
    ("查询 ?",          "🟡 我的会话",   "?",    None,          "[🟡]"),
    ("查询 盘面无序号", "🟡 我的会话",   "?",    None,          "无 ⚪ 🔴 [🟡] 🟢 ⚫"),
    ("查询 带用法",     "🟡 我的会话",   "?",    None,          "改名（保留当前灯）"),
    # ── 边界
    ("空标题点灯会光秃", "",             "黄",   ERR,           "还没有标题"),
]


def run():
    bad = 0
    for desc, name, arg, want_name, want_frag in CASES:
        new_name, msg, err = core.plan_tag(name, arg)
        if want_name is ERR:
            ok = err is not None and want_frag in err
            got = f"err={err!r}"
        else:
            ok = err is None and new_name == want_name and want_frag in (msg or "")
            got = f"name={new_name!r} msg={msg!r}"
        print(f"{'✓' if ok else '✗'} {desc:22} /tag {arg!r:16} → {got}")
        if not ok:
            bad += 1
            print(f"    期望 name={want_name!r}，消息含 {want_frag!r}")
    for text, want in TRIGGERS:
        m = hook.TRIGGER.match(text)
        got = None if not m else (m.group(1) or "")
        ok = got == want
        print(f"{'✓' if ok else '✗'} hook 认出 {text!r:22} → {got!r}")
        if not ok:
            bad += 1
            print(f"    期望 {want!r}")
    total = len(CASES) + len(TRIGGERS)
    print(f"\n{total - bad}/{total} 通过")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(run())
