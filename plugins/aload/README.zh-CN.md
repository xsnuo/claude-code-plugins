# aload：点击朗读

[English](README.md) | 简体中文 · [← 返回插件列表](../../README.zh-CN.md)

每条 Claude 最终回复的末尾有一个「🔊 read aload」，点了才读，从不自动读。正文和排版保持原样，不影响阅读和复制。

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

## 第一次使用：设置 Key

第一次点按钮时会弹出输入框。插件会先真的合成一句“你好”来验证，通过了才保存。

- **Azure 语音**（默认，有免费额度）：在 Azure 门户创建「语音服务」资源，定价层选 F0（每月 50 万字符免费），然后到「密钥和终结点」页面，复制密钥和区域（如 `eastasia`）。
- **豆包语音 2.0**：在火山引擎控制台开通「豆包语音合成模型 2.0」，然后到「API Key 管理」创建 Key。**App ID 留空**，只有旧版控制台才需要填 App ID 加 Access Token。如果提示“Key 有效，但还没有使用权限”，说明服务还没开通完。

切换厂家用 `/aload doubao` 或 `/aload azure`。Key 只保存在本机的 `~/.config/aload/credentials.json`（权限 600），不会进入对话记录。注意：输入框里的 Key 是明文显示的，屏幕共享时小心。

## 命令

| 命令 | 作用 |
|---|---|
| `/aload` | 查看当前厂家、Key（只显示末 4 位）、音色 |
| `/aload azure` / `/aload doubao` | 切换厂家；没有 Key 会弹出输入框 |
| `/aload key [厂家]` | 重新输入 Key |
| `/aload voice <音色>` | 设置当前厂家的音色，如 `zh-CN-YunxiNeural` |
| `/aload icon reply` / `paragraph` / `hover` | 按钮放在：回复末尾（默认）/ 每段左边 / 每段左边且鼠标移上去才显示 |
| `/aload stop` | 停止朗读 |

## 运行要求

- **macOS**：用系统自带的 `/usr/bin/python3` 和 `afplay`，不用另装东西。
- **Claude Code 2.1.293 或更高版本，并开着全屏模式**（`/tui fullscreen`），这样才能用鼠标点按钮和选中文字。
- **终端要支持超链接**，Ghostty、iTerm2 等都可以。按钮本身是一个链接，在不支持超链接的终端里，按钮后面会多出一串网址，而且点不了。这种情况下可以改用 `/aload icon paragraph`。

## 费用

两家都按合成的字数计费：
- **边读边请求**：插件按段落把文字切成小块，每块不超过 220 字，读到哪块才请求哪块，停下就不再请求。
- **中途停下会多算一点**：为了不卡顿，会提前合成最多 3 小块，所以中途停下最多多算几百字。

## 排查问题

查看日志：`tail ~/.cache/aload/aload.log`。里面记录了每次朗读用的厂家和音色、多久出声，以及失败的原因。

## 开发

- **测试**：在本目录下运行
  - 插件测试：`claude plugin test .`
  - 本地助手测试：`python3 -m unittest discover -s tests`
- **文件**：

| 文件 | 作用 |
|---|---|
| `hooks/register.tsx` | 插件本体：回复末尾的按钮、每段图标、`/aload` 命令、Key 输入框 |
| `hooks/blocks.ts` | 把回复切成段，定位选中的文字，整理成朗读用的文字 |
| `bin/aload.py` | 本地助手：调用 Azure / 豆包合成，用 afplay 播放，管理配置和 Key（只用 Python 标准库） |
| `types/index.d.ts` | 插件状态的类型 |
| `tests/` | 插件测试和本地助手测试，测试时用本机模拟接口，不联网、不出声 |
