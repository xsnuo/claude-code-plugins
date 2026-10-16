# claude-code-plugins

[English](README.md) | 简体中文

xuesinuo 的 Claude Code 插件，以插件市场 `xuesinuo` 发布。每个插件单独安装，需要哪个装哪个。

## 插件一览

| 插件 | 一句话简介 |
|---|---|
| [tag](plugins/tag/README.zh-CN.md) | 用 `/tag` 给会话标题点一盏状态灯 ⚪🔴🟡🟢⚫，在会话列表里一眼看出各会话进行到哪了 |
| [aload](plugins/aload/README.zh-CN.md) | 每条回复末尾一个「🔊 read aload」，点了才朗读，可从选中处读起（Azure / 豆包语音 2.0） |
| [key-points](plugins/key-points/README.zh-CN.md) | 每条回复末尾一个「📌 key points」，点了让 Claude 挑出关注句和关注词，直接在原回复上标出来 |

## 插件简介

### tag：会话状态灯

后台会话一多，就容易忘了哪个在等你、哪个已经做完。tag 在会话标题最前面放一盏灯，颜色的含义由你自己定。

- `/tag`：轮换灯色。
- `/tag 黄`：直接指定颜色。
- `/tag 新名字`：改名，灯保留。

`/tag` 由插件直接处理，不经过模型，不消耗额度。

[详细说明 →](plugins/tag/README.zh-CN.md)

### aload：点击朗读

只在你点击时朗读，从不自动读。

- **从头读**：直接点「🔊 read aload」，从头读到这条回复结束。
- **从中间读**：先选中几个字再点，从选中处往后读。
- **省钱**：按段落分块边读边调用朗读接口，停下就不再请求。

需要自备 Azure 语音（有每月免费额度）或豆包语音 2.0 的 Key。

[详细说明 →](plugins/aload/README.zh-CN.md)

### key-points：标重点

点一下回复末尾的「📌 key points」，Claude 会结合整段对话，挑出这条回复里的关注句和关注词，直接在原回复上标出来；再点一下取消。

- **挑什么**：对话的核心、直接回答你提问的部分、需要你知晓或决策的内容。
- **不刷屏**：在后台另问一次 Claude，问答不进对话记录；原回复只改样式，不改文字。
- **不过量**：重点合计不超过正文的 25%，由插件强制执行。
- **样式可调**：字体色、背景色、下划线自由组合，关注句和关注词分开设置。

和 aload 一起装时，两个链接并排在同一行。

[详细说明 →](plugins/key-points/README.zh-CN.md)

## 安装

在 Claude Code 里依次执行：

```
/plugin marketplace add xsnuo/claude-code-plugins
/plugin install tag@xuesinuo
/plugin install aload@xuesinuo
/plugin install key-points@xuesinuo
```

第一行添加插件市场，只需执行一次；后面几行按需选装。

- **更新**：`/plugin marketplace update xuesinuo`。
- **停用或卸载**：在 `/plugin` 里操作。

## 运行要求

- macOS
- Claude Code 2.1.293 或更高版本；key-points 要 2.1.299 或更高
- tag 和 aload 要 python3（系统自带的即可）；key-points 不需要
- aload 和 key-points 另有要求：全屏模式，以及支持超链接的终端，见 [aload 的说明](plugins/aload/README.zh-CN.md#运行要求)和 [key-points 的说明](plugins/key-points/README.zh-CN.md#运行要求)

## 许可证

[MIT](LICENSE)：可以自由使用、修改和分发，只需保留版权声明。
