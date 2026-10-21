# aload v0.6.1：点击朗读

[English](README.md) | 简体中文 · [← 返回插件列表](../../README.zh-CN.md)

每条 Claude 最终回复的末尾有一个「🔊 read aload」，点了才读，从不自动读。正文和排版保持原样，不影响阅读和复制。

声音可以来自三家：Azure 语音、豆包语音 2.0，或者电脑自带的朗读（在 Mac 上就是“辅助功能 → 朗读内容”）。电脑自带的朗读不要 Key、不联网、不花钱。

## 装之前要准备的

aload 用 Python 3 合成和播放声音，要先准备好：

| 系统 | 要什么 | 怎么装 |
|---|---|---|
| macOS | Python 3（在 Xcode 命令行工具里）；播放用系统自带的 `afplay` | 在终端里执行 `python3 --version`。如果弹窗提示安装命令行开发者工具，点“安装”；也可以直接执行 `xcode-select --install` |
| Windows | Python 3；播放用 Python 自带的 `winsound` | 从 [python.org](https://www.python.org/downloads/) 下载安装（保留默认勾选的 py 启动器），或者执行 `winget install Python.Python.3.13`。装好后执行 `py -3 --version`，能看到 3.x 的版本号就行 |
| Linux | Python 3；播放用 `paplay`、`pw-play`、`aplay` 之一；用电脑自带的朗读还要 `espeak-ng` | Debian、Ubuntu：`sudo apt install python3 pulseaudio-utils espeak-ng`；Fedora：`sudo dnf install python3 pulseaudio-utils espeak-ng` |

另外，按钮要能用鼠标点，还要开着 Claude Code 的全屏界面，见下面的[运行要求](#运行要求)。

## 安装

```
/plugin marketplace add xsnuo/claude-code-plugins
/plugin install aload@xuesinuo
```

## 用法

- **从头读**：点「🔊 read aload」，从头读到这条回复结束。段与段之间连续，不卡顿；代码块跳过，表格逐行读。
- **从中间读**：先用鼠标选中几个字，按钮会变成「🔊 read aload on selected」，点它就从选中的位置往后读。
- **停止**：读的时候按钮显示「🔇 stop reading 2/5」，点它就停。退出会话时也会自动停。
- **只放一路声音**：全机同一时间只放一路，在别处开始新的朗读，旧的会停下。
- **和 key-points 一起用**：两个插件都装了时，「🔊 read aload」和 [key-points](../key-points/README.zh-CN.md) 的「📌 key points」在回复下面各占一行，上下排列。一个按钮的文字变长变短，不会挤动另一个。

## 电脑自带的朗读：不要 Key、不联网

厂家里有一项“本机朗读”，名字跟着系统走，只有在那个系统上才会出现：

| 系统 | 切换命令 | 用的是什么 |
|---|---|---|
| macOS | `/aload macos` | 系统自带的朗读（`say`），声音和语速跟着“系统设置 → 辅助功能 → 朗读内容”走 |
| Windows | `/aload windows` | 系统自带的 System.Speech，声音跟着“设置 → 时间和语言 → 语音”走 |
| Linux | `/aload linux` | espeak-ng，要先装好（见上面的[装之前要准备的](#装之前要准备的)） |

- **不要 Key，不花钱。** 文字不出这台电脑，所以也不做下面说的敏感信息屏蔽。
- **换声音**：`/aload voice <声音名>`；写 `/aload voice default` 回到系统默认的声音。
  - Mac 上的中文声音，比如 `Tingting`（婷婷），或者 `Eddy (中文（中国大陆）)` 这样带括号的全名。
  - 在“系统设置 → 辅助功能 → 朗读内容 → 系统声音 → 管理声音”里，可以下载更自然的中文声音。
  - 在终端里执行 `say -v '?'` 能看到所有装好的声音。
- 目前只在 macOS 上实测过；Windows 和 Linux 的本机朗读还没有实测。

## 第一次使用：设置 Key

用 Azure 或豆包时，第一次点按钮会弹出输入框。插件会先真的合成一句“你好”来验证，通过了才保存。

- **Azure 语音**（默认，有免费额度）：在 Azure 门户创建「语音服务」资源，定价层选 F0（每月 50 万字符免费），然后到「密钥和终结点」页面，复制密钥和区域（如 `eastasia`）。
- **豆包语音 2.0**：在火山引擎控制台开通「豆包语音合成模型 2.0」，然后到「API Key 管理」创建 Key。**App ID 留空**，只有旧版控制台才需要填 App ID 加 Access Token。如果提示“Key 有效，但还没有使用权限”，说明服务还没开通完。

切换厂家用 `/aload doubao` 或 `/aload azure`。Key 只保存在本机的 `~/.config/aload/credentials.json`，不会进入对话记录。在 macOS 和 Linux 上，这个文件的权限是 600（只有你自己能读）；在 Windows 上，靠用户目录本身的权限保护。注意：输入框里的 Key 是明文显示的，屏幕共享时小心。

## 命令

| 命令 | 作用 |
|---|---|
| `/aload` | 查看当前厂家、Key（只显示末 4 位）、音色 |
| `/aload azure` / `/aload doubao` | 切换厂家；没有 Key 会弹出输入框 |
| `/aload macos` | 换成 Mac 自带的朗读（只在 Mac 上有；Windows 上是 `/aload windows`，Linux 上是 `/aload linux`） |
| `/aload key [厂家]` | 重新输入 Key |
| `/aload voice <音色>` | 设置当前厂家的音色，如 `zh-CN-YunxiNeural`；本机朗读写系统里的声音名，`default` 回到系统默认 |
| `/aload icon reply` / `paragraph` / `hover` | 按钮放在：回复末尾（默认）/ 每段左边 / 每段左边且鼠标移上去才显示 |
| `/aload stop` | 停止朗读 |

## 运行要求

- **Claude Code 命令行（CLI）**，2.1.299 或更高版本。不支持 VS Code 扩展、桌面 App 等其他形式。
- **开着 Claude Code 的全屏界面**，这样才能用鼠标点按钮、选中文字。
  - 打开方式：执行 `/tui fullscreen`，或者在 `~/.claude/settings.json` 里写 `"tui": "fullscreen"`。
  - 这是 Claude Code 自己的界面模式，和终端窗口是否最大化无关。
- **用什么终端都可以。** 按钮画成链接的样子（蓝色、下划线），但它是按钮，不是网址链接，所以不要求终端支持超链接，点了也不会打开浏览器。
- **Python 3 和播放器**：怎么装见上面的[装之前要准备的](#装之前要准备的)。
  - 插件会依次试 `/usr/bin/python3`、`python3`、`py -3`、`python`，用第一个能跑的 Python 3。
  - 想换播放器，可以在启动 Claude Code 前设环境变量 `ALOAD_PLAYER`，比如 `mpv --no-video`，音频文件的路径会接在最后。
- **macOS、Windows、Linux 都可以。** 目前只在 macOS 上实测过，Windows 和 Linux 的适配还没有实测。

## 隐私：送出去之前先屏蔽敏感信息

用 Azure 或豆包朗读时，要把文字发给第三方。（电脑自带的朗读不出这台电脑，跳过这一节说的检查。）回复里如果带着 Key、密码这类信息，就会一起被发出去。所以每次朗读前，插件先做两道检查：

1. **请 Claude 找出敏感信息**：用速度快的模型，固定 medium 档位。它只列出要屏蔽的片段，不重写全文，所以输出很短。
   - 按顺序试 Haiku、Sonnet、Opus，最后才用当前会话的模型。前一个用不了（账号没有这个模型、模型下架了、报错或超时），就自动换下一个。
   - 只写模型名、不写版本号，Claude 出了新版本会自动跟着用。
   - 记住上次能用的那个，下次直接从它开始。
2. **本地规则兜底**：再按常见格式（`sk-` 开头的 Key、AWS Access Key、GitHub Token、JWT、私钥，以及“密码：xxx”“token=xxx”这种写法）过一遍，抓第一步漏掉的。

找到的内容会换成说明它是什么的文字再发出去，念出来就是“密钥”“密码”这样的词：

| 原文里的 | 换成 |
|---|---|
| API Key、Token、Secret、私钥、Cookie 等 | 【密钥】 |
| 密码、口令 | 【密码】 |
| 用户 ID、账号 ID、UID | 【UID】 |
| 手机号、身份证号、银行卡号、邮箱 | 【手机号】【身份证号】【银行卡号】【邮箱】 |
| 其他凭据或隐私 | Claude 起的简短名称，比如【会话标识】 |

- **第一步没成功时**（网络问题、接口报错），这次只用本地规则屏蔽，并弹出一句提示。
- **同一段文字再念**，直接用上次检查的结果，不再问 Claude。
- 本来就不念的内容不会发出去：代码块会跳过，网址念成“链接”，超过 40 个字的行内代码念成“一段代码”。

## 费用

- **电脑自带的朗读**：不花钱，也不做敏感信息检查。
- **敏感信息检查**（只有 Azure、豆包需要）：每次朗读前多一次很小的请求，一般用 Haiku，按 Haiku 的价格计费，输入几百个 token、输出几百个 token 以内。实测 Haiku 约 1.7 秒（用 Opus 约 3 秒），所以点了之后要稍等一下才出声。

朗读接口两家都按合成的字数计费：
- **边读边请求**：插件按段落把文字切成小块，每块不超过 220 字，读到哪块才请求哪块，停下就不再请求。
- **中途停下会多算一点**：为了不卡顿，会提前合成最多 3 小块，所以中途停下最多多算几百字。

## 排查问题

查看日志：`~/.cache/aload/aload.log`（Windows 上是 `%USERPROFILE%\.cache\aload\aload.log`）。里面记录了每次朗读用的厂家和音色、多久出声，以及失败的原因。

## 开发

- **测试**：在本目录下运行
  - 插件测试：`claude plugin test .`
  - 本地助手测试：`python3 -m unittest discover -s tests`（在 macOS 或 Linux 上跑）
- **文件**：

| 文件 | 作用 |
|---|---|
| `hooks/register.tsx` | 插件本体：回复末尾的按钮、每段图标、`/aload` 命令、Key 输入框 |
| `hooks/blocks.ts` | 把回复切成段，定位选中的文字，整理成朗读用的文字 |
| `hooks/redact.ts` | 朗读前屏蔽敏感信息：问 Claude 的话、读它的回答、本地兜底规则 |
| `hooks/tree.ts` | 每段模式下，从里层画好的树里分出引擎画的正文和别的插件加在下面的东西 |
| `bin/aload.py` | 本地助手：调用 Azure / 豆包合成，按系统选播放器播放，管理配置和 Key（只用 Python 标准库） |
| `types/index.d.ts` | 插件状态的类型 |
| `tests/` | 插件测试和本地助手测试，测试时用本机模拟接口，不联网、不出声 |

## 许可证

[MIT](../../LICENSE)
