# claude-code-plugins

[English](README.md) | 简体中文

xuesinuo 的 Claude Code 插件，以插件市场 `xuesinuo` 发布。每个插件单独安装，需要哪个装哪个。

都是给 Claude Code 命令行（CLI）用的，macOS、Windows、Linux 通用。

## 插件一览

| 插件 | 版本 | 一句话简介 |
|---|---|---|
| [tag](plugins/tag/README.zh-CN.md) | v2.0.0 | 用 `/tag` 给会话标题点一盏状态灯 ⚪🔴🟡🟢⚫，在会话列表里一眼看出各会话进行到哪了 |
| [aload](plugins/aload/README.zh-CN.md) | v0.6.1 | 每条回复末尾一个「🔊 read aload」，点了才朗读，可从选中处读起（Azure / 豆包语音 2.0 / 电脑自带的朗读） |
| [key-points](plugins/key-points/README.zh-CN.md) | v0.2.2 | 每条回复末尾一个「📌 key points」，点了让 Claude 挑出关注句和关注词，直接在原回复上标出来 |
| [index](plugins/index/README.zh-CN.md) | v0.1.0 | 用 `/index` 在右侧弹出本次会话的目录，每轮一项：提问缩略、回答摘要，点一项就跳到那次提问 |

## 插件简介

### tag v2.0.0：会话状态灯

后台会话一多，就容易忘了哪个在等你、哪个已经做完。tag 在会话标题最前面放一盏灯，颜色的含义由你自己定。

- `/tag`：轮换灯色。
- `/tag 黄`：直接指定颜色。
- `/tag 新名字`：改名，灯保留。

`/tag` 由插件直接处理，不经过模型，不消耗额度。只对后台会话（`claude agents` 里的会话）有效。

[详细说明 →](plugins/tag/README.zh-CN.md)

### aload v0.6.1：点击朗读

只在你点击时朗读，从不自动读。

- **从头读**：直接点「🔊 read aload」，从头读到这条回复结束。
- **从中间读**：先选中几个字再点，从选中处往后读。
- **省钱**：按段落分块边读边调用朗读接口，停下就不再请求。
- **不外泄敏感信息**：送去朗读前，先让 Claude 把 Key、密码、UID 这类内容换成【密钥】【密码】【UID】，再用本地规则兜底。
- **电脑自带的朗读**：Mac 上执行 `/aload macos`，用系统自带的朗读，不要 Key、不联网、不花钱（Windows、Linux 上也有对应的一项）。

用 Azure 语音（有每月免费额度）或豆包语音 2.0 时，需要自备 Key。Windows 和 Linux 上还要有 Python 3。

[详细说明 →](plugins/aload/README.zh-CN.md)

### key-points v0.2.2：标重点

点一下回复末尾的「📌 key points」，Claude 会结合整段对话，挑出这条回复里的关注句和关注词，直接在原回复上标出来；再点一下取消。

- **挑什么**：对话的核心、直接回答你提问的部分、需要你知晓或决策的内容。
- **不刷屏**：在后台另问一次 Claude，问答不进对话记录；原回复只改样式，不改文字。
- **不过量**：重点合计不超过正文的 25%，由插件强制执行。
- **样式可调**：字体色、背景色、下划线自由组合，关注句和关注词分开设置。

和 aload 一起装时，两个按钮在回复下面上下各占一行，互不影响。

[详细说明 →](plugins/key-points/README.zh-CN.md)

### index v0.1.0：对话目录

对话一长，想回头看前面某一轮就得一屏一屏往上翻。执行 `/index`，右侧弹出本次会话的目录，点一项，左边的对话就跳到那次提问。

- **一轮一项**：上面是你那次提问的缩略，下面是回答的一句话摘要。
- **摘要**：在后台请 Claude（haiku）来写，一轮一次，只在目录打开时写；写过的记在本机，不再重写。`/index summary off` 改用回答的第一句，不花钱。
- **跳转**：太早的提问，插件会先往上翻着找，一般一两秒。

[详细说明 →](plugins/index/README.zh-CN.md)

## 装之前要准备的

**只有 aload 要先装 Python 3**，tag、key-points 和 index 不用另装任何程序。

| 系统 | aload 要什么 | 怎么装 |
|---|---|---|
| macOS | Python 3（在 Xcode 命令行工具里） | 在终端里执行 `python3 --version`。如果弹窗提示安装命令行开发者工具，点“安装”；也可以直接执行 `xcode-select --install` |
| Windows | Python 3 | 从 [python.org](https://www.python.org/downloads/) 下载安装（保留默认勾选的 py 启动器），或者执行 `winget install Python.Python.3.13`。装好后执行 `py -3 --version`，能看到 3.x 的版本号就行 |
| Linux | Python 3、放声音的命令；用电脑自带的朗读还要 espeak-ng | Debian、Ubuntu：`sudo apt install python3 pulseaudio-utils espeak-ng`；Fedora：`sudo dnf install python3 pulseaudio-utils espeak-ng` |

**aload、key-points 的按钮和 index 的目录要用鼠标点**，所以要开着 Claude Code 的全屏界面：执行 `/tui fullscreen`，或者在 `~/.claude/settings.json` 里写 `"tui": "fullscreen"`。这是 Claude Code 自己的界面模式，和窗口是否最大化无关。用什么终端都可以。

## 安装

在 Claude Code 里依次执行：

```
/plugin marketplace add xsnuo/claude-code-plugins
/plugin install tag@xuesinuo
/plugin install aload@xuesinuo
/plugin install key-points@xuesinuo
/plugin install index@xuesinuo
```

第一行添加插件市场，只需执行一次；后面几行按需选装。

- **更新**：`/plugin marketplace update xuesinuo`。
- **停用或卸载**：在 `/plugin` 里操作。

## 运行要求

- **Claude Code 命令行（CLI）**，2.1.299 或更高版本（index 要 2.1.307 或更高）。不支持 VS Code 扩展、桌面 App 等其他形式。
- **macOS、Windows、Linux 都可以。** 目前只在 macOS 上实测过，Windows 和 Linux 的适配还没有实测。
- **要提前装的东西**：见上面的[装之前要准备的](#装之前要准备的)。

细节见各插件的说明：[tag](plugins/tag/README.zh-CN.md#运行要求)、[aload](plugins/aload/README.zh-CN.md#运行要求)、[key-points](plugins/key-points/README.zh-CN.md#运行要求)、[index](plugins/index/README.zh-CN.md#运行要求)。

## 许可证

[MIT](LICENSE)：可以自由使用、修改和分发，只需保留版权声明。
