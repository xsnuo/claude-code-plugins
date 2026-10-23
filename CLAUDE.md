# CLAUDE.md

这个仓库是 xuesinuo 的 Claude Code 插件市场：
- GitHub 地址是 `xsnuo/claude-code-plugins`，市场名是 `xuesinuo`；
- 插件的安装名是 `<插件名>@xuesinuo`；
- 每个插件放在 `plugins/` 下的一个目录里，用户按需单独安装。

## 职责

1. **维护各个插件**：修 bug、加功能、补测试。改完要先跑测试和校验（见下文“开发和测试”），通过了再提交。
2. **维护 README 文档**，有任何改动影响到插件列表、简介、用法、命令或运行要求，都要同步更新：
   - 根目录：`README.md`（英文）和 `README.zh-CN.md`（中文）；
   - 每个插件目录：同样一份英文、一份中文。
   - 中英文两版内容要一致，改一版就要同时改另一版。
   - 根 README 的结构：开头先列插件一览（插件名和一句话简介），接着是每个插件的精简介绍，然后是安装和运行要求。细节都放到插件自己的 README 里。
   - 文档之间的跳转：
     - 每份文档开头都有中英文切换；
     - 根 README 链到各插件的 README，插件 README 有“返回插件列表”链回根 README；
     - 中文文档链中文，英文文档链英文。
     - 新增文档也照此加链接。
3. **维护插件索引**：`.claude-plugin/marketplace.json` 里的 `plugins` 列表，要和 README 的插件一览保持一致，包括名字、目录和简介。
4. **发版**：改对应插件 `plugins/<名字>/.claude-plugin/plugin.json` 里的 `version`。用户执行 `/plugin marketplace update xuesinuo` 就能拿到新版本。
   - 版本号同时写在 README 上，打开就知道装的是不是新版，改 `version` 时这几处要一起改：
     - 插件自己的中英文 README 的标题，比如 `# aload v0.4.0：点击朗读`；
     - 根 README 中英文两版里，插件一览的「版本」列，以及这个插件简介的小标题。

## 仓库结构

| 路径 | 作用 |
|---|---|
| `.claude-plugin/marketplace.json` | 插件索引：市场名、每个插件的目录和简介 |
| `README.md`、`README.zh-CN.md` | 给人看的总览：插件一览、简介、安装方法 |
| `plugins/tag/` | 会话状态灯：只有插件代码（TypeScript） |
| `plugins/aload/` | 点击朗读：插件代码（TypeScript）加本地助手（Python） |
| `plugins/key-points/` | 标重点：只有插件代码（TypeScript） |
| `plugins/index/` | 对话目录：只有插件代码（TypeScript） |
| `.gitignore` | 整个仓库通用的忽略规则；每个插件的忽略规则放在各自目录下的 `.gitignore` 里 |
| `LICENSE` | MIT 许可证，覆盖整个仓库；每个插件的 `plugin.json` 里也写了 `"license": "MIT"` |

## 约定

- **一个目录一个插件**：`plugins/<名字>/` 里要有 `.claude-plugin/plugin.json`。名字用 kebab-case，也就是小写字母、数字和连字符。不要用点号，校验会警告“claude.ai 的市场同步要求 kebab-case”。
- **新增一个插件**，依次做这几件事：
  1. 建目录，写 `plugin.json`（带上 `"license": "MIT"`）；
  2. 在 `marketplace.json` 里加一项；
  3. 在根 README 中英文两版里各加一行插件一览、一段简介；
  4. 写插件自己的中英文 README；
  5. 写插件自己的 `.gitignore`。
- **语言**：代码注释和文档以中文为主（英文 README 除外），跟着现有代码的风格写。
- **平台**：
  - 只给 Claude Code 命令行（CLI）用，不管 VS Code 扩展、桌面 App；
  - macOS、Windows、Linux 通用，目前只在 macOS 上实测过。新插件、新功能也默认按三个系统做；适配 Linux 的成本如果高过 Windows，可以只做 macOS 和 Windows；
  - 插件代码里不要依赖某个系统独有的命令或路径；
  - 只有 aload 的本地助手用 Python，而且只用标准库；tag、key-points 和 index 是纯插件代码；
  - 需要提前装的东西（Python、播放器等），要在根 README 和插件 README 的「装之前要准备的」里，按系统写清怎么装。
- **不提交隐私**：不提交任何 Key 和个人信息。aload 的 Key 保存在用户本机的 `~/.config/aload/`。

## 开发和测试

- **校验**：
  - 市场：`claude plugin validate .`
  - 单个插件：`claude plugin validate plugins/<名字>`
- **tag**：`claude plugin test plugins/tag`
- **aload**：
  - 插件测试：`claude plugin test plugins/aload`
  - 本地助手测试：`cd plugins/aload && python3 -m unittest discover -s tests`（测试里的假播放器是 shell 脚本，只能在 macOS、Linux 上跑）
- **key-points**：`claude plugin test plugins/key-points`
- **index**：`claude plugin test plugins/index`
- **在本机试用改动**：
  - **推荐把这个仓库当作本地市场添加**：`claude plugin marketplace add <仓库路径>`，然后在 `/plugin` 里安装。Claude Code 会直接读这个文件夹，改完执行 `/reload-plugins` 就生效。它和从 GitHub 添加的市场同名（都叫 `xuesinuo`），两者只能留一个。
  - **临时加载**：`claude --plugin-dir plugins/<名字>`。如果已经装了同名插件会加载两份，可以先停用，或者加上 `--setting-sources project,local` 跳过用户设置。

## 插件要点（踩过的坑）

### tag

**结构**：纯插件代码。`hooks/register.ts` 用 `$.command.register` 注册 `/tag`，在 `command.run` 里自己回答；算新标题的纯逻辑在 `hooks/core.ts`。

- **必须直接写状态文件。** 只发 `hookSpecificOutput.sessionTitle` 点不亮灯（CC 2.1.241 实测），要直接改会话状态文件的 `name`。
  - 先在 `<配置目录>/sessions/*.json` 里按 session id 找到 jobId，再改 `<配置目录>/jobs/<jobId>/state.json`。
  - 这是 Claude Code 未公开的内部结构，升级后可能失效。
- **只有后台会话有状态文件。** CC 2.1.299 实测：`sessions/*.json` 只为后台会话写，前台会话里 `/tag` 会提示定位不到。
- **会话进程会把内存里的标题刷回状态文件**，所以 `applyName` 写完会校验，被顶掉了就重写。
- **配置目录**：设了 `CLAUDE_CONFIG_DIR` 就用它，否则是用户目录下的 `.claude`。Windows 上先用 `USERPROFILE`，因为 `HOME` 可能是 Git Bash 的 `/c/Users/...` 写法。
- **1.x 的坑已经不在了。** 1.x 用 Python 的 `UserPromptSubmit` 钩子拦截 `/tag`，每次多打一行 `UserPromptSubmit operation blocked by hook`，`commands/tag.md` 里也不能加 `!`。2.0 改成插件自己注册命令，这些都没有了。
- **在本机端到端试一遍**：
  1. `claude --bg --plugin-dir plugins/tag --setting-sources project,local -n 测试` 起一个空闲的后台会话，不调用模型；
  2. `claude attach <id>` 进去敲 `/tag`，同时看 `~/.claude/jobs/<id>/state.json`；
  3. 用完 `claude stop <id>`、`claude rm <id>` 收掉。

### aload

**结构**：插件代码在 `hooks/register.tsx`，用的是 function hooks；本地助手 `bin/aload.py` 负责合成、按系统选播放器播放、管理配置和 Key。

- **插件接口还在早期阶段，版本间可能变化。** 类型声明由 Claude Code 在加载插件时生成到 `.claude-plugin/types/`（不进仓库），以那里为准。
- **回复末尾的按钮不能用链接，要用 Button。** 画成链接的样子（`plain` 的 Button，里面放蓝色带下划线的 Text），但不是真的链接。
  - 以前用的是 Markdown 链接加 `onLinkPress`，偶尔点了会用浏览器打开 `https://aload.invalid/stop`。原因在 Claude Code 里（2.1.306 实测读代码）：
    - 一次点击要是没被组件接住（比如正赶上链接重画，界面结构和屏幕上那一帧对不上），而点的格子上又有链接，Claude Code 就当成普通链接点击；
    - 在 macOS 的 Ghostty、Warp 里它分不出 ⌘+点击和普通点击，于是 0.5 秒后用浏览器打开那个网址；
    - 朗读时停止链接每念一段就重画一次，最容易撞上。
  - Button 没有网址，没接住最坏只是这一下没反应；也不再要求终端支持超链接。点 Button 也不用像链接那样等 0.5 秒确认不是双击。
  - 点按钮、`$.ui.selection()` 都只在全屏界面（`/tui fullscreen`，设置里是 `"tui": "fullscreen"`）有效。这里的“全屏”是 Claude Code 的界面模式，不是窗口最大化。
- **“正在念”按消息各存一份。** `now` 是全局一份（停止、判断用）；画的时候读 `playing` 这个按消息 id 分开的 StateFamily（`memberOf(playing, e)`），念到下一段时只有正在念的那条回复重画。改的时候都走 `setNow()`。
- **怎么判断“最终回复”。** 新回复由 `turn.complete` 的 `answer` 判定；历史回复由 `$.session.messages()` 推断，任务通知和子代理回报不算作提问。
- **选中文字的处理。** 每 400ms 轮询一次 `$.ui.selection()`。`locate()` 找位置时只比对字母、数字和汉字，因为屏幕上的文字已经没有 Markdown 符号了；`speechFrom()` 从这个位置往后切出要读的各段。
- **弹面板要在点击处理里。** `ui.open` 必须在按钮这次按下的处理过程中调用，才算“用户打开的”。否则在不到 144 列的终端里，面板不会弹出来。所以点击时要先查有没有 Key，再弹输入框。
- **每段模式的排版。** 每段模式（`/aload icon paragraph|hover`）下，第一段交给引擎画，它自带一行上边距和 ⏺；后面的段用 Markdown 自己排。**不要用负边距**，相邻段一旦重叠，悬停时就会亮错段。
- **停止机制。** 结束 `$.process.spawn` 的读取循环，就会结束子进程。全机只放一路声音：
  - 正在念的 aload.py 把进程号写进 `~/.cache/aload/playing.pid`，每次心跳（0.3 秒）核对一遍；
  - 新开一路就改写这个文件，`aload.py stop` 就删掉它，旧的那路发现文件不是自己的了，就自己停下；
  - 不用 `ps`，也不给别的进程发信号，所以各个系统都一样。
- **找 Python。** 依次试 `/usr/bin/python3`、`python3`、`py -3`、`python`，跑 `-c` 看主版本号是不是 3。
  - Windows 上的 `python3` 常常是跳去微软商店的空壳（退出码 9009），会被跳过。
  - 管道统一用 UTF-8：插件传 `PYTHONUTF8=1`，`aload.py` 里也 `reconfigure` 了一遍。Windows 默认是系统代码页，中文会乱。
- **播放器和音频格式。**
  - macOS：mp3，用 afplay 放；
  - Windows：wav，用标准库的 winsound 在本进程里异步放，按 wav 的时长等它放完；
  - Linux：wav，依次找 paplay、pw-play、aplay；
  - Azure 的 wav 是 `riff-24khz-16bit-mono-pcm`；豆包这边请求 `pcm`，再自己加 wav 文件头（24kHz、16 位、单声道，已用真实接口核对过）。
- **朗读前屏蔽敏感信息**（`hooks/redact.ts`）。文字要发给第三方，所以开念前先过两道：
  - 用 `$.model.complete` 请 Claude 列出要屏蔽的片段，`effort: 'medium'`。只要片段、不让它重写全文，输出短；
  - 模型按 `CHECK_MODELS` 的顺序试：`haiku`、`sonnet`、`opus`（只写别名、不写版本号，跟着升级），最后是当前会话的模型。被拒、报错、读不懂、超时都换下一个；整个检查最多 20 秒。记住上次成功的是第几个，下次从它开始。实测 Haiku 约 1.7 秒、Opus 约 3 秒；
  - 再用本地规则兜底（常见格式的 Key、“密码：xxx”）。第一步失败时只用本地规则，并弹提示；
  - 换成【密钥】【密码】【UID】这类说明。同一段文字的结果记在内存里，再念不再问；
  - 检查期间按了停止或开了新的一次，靠 `preparing` 作废这一次，不会再去念。
- **本机朗读**（不联网、不要 Key）。厂家名跟着系统走：`aload.py` 的 `LOCAL` 在 macOS 上是 `macos`、Windows 上是 `windows`、Linux 上是 `linux`，`status` 里的 `local` 告诉插件这台电脑上是哪个，别的系统上的不列出来。
  - macOS：`/usr/bin/say -f -`，文字从标准输入给（UTF-8 中文没问题）；不加 `-v` 就用“辅助功能 → 朗读内容”里设的声音和语速。`say` 遇到不存在的声音名不报错、照样退出 0，所以设音色时先用 `say -v '?'` 核对。
  - Windows：PowerShell 里用 System.Speech，先把 `[Console]::InputEncoding` 设成 UTF-8，音色从环境变量 `ALOAD_VOICE` 传，免得引号出问题。
  - Linux：espeak-ng（或 espeak），没指定音色而文字里有中文时用 `-v cmn`。
  - 一段一个进程，停的时候结束进程；只放一路声音的规矩照旧。
  - 插件把这次用的厂家写进给 `aload.py` 的输入里，确定是本机朗读才跳过敏感信息屏蔽。
- **豆包的报错。**
  - 403 `requested resource not granted`：Key 有效，但没开通对应的资源；
  - 401 `grant not found`：用的是新版 API Key，却又填了 App ID。
  - 遇到资源对不上，会依次试 `seed-tts-2.0`、`seed-tts-1.0`、`seed-icl-2.0`、`seed-icl-1.0`。
- **计费。** 按段落切成小块，每块不超过 220 字，边读边请求。会提前合成最多 3 块：队列里 2 块，外加 1 块已经合成好、正等着放进队列。
- **测试工具的写法。**
  - 测试里扮演引擎时，`$` 调用的结果要包成 `{ value }`；
  - 生命周期事件（如 `turn.complete`）直接返回结果；
  - 点按钮写 `press({ key })`；
  - 扮演 `process.run` 时，参数在 `e.argv`，`cwd`、`env`、`stdin` 在 `e.init` 里。

### key-points

**结构**：插件代码在 `hooks/register.tsx`（回复下面的按钮、后台提问、`/key-points` 命令）。另有几个文件：
- `hooks/marks.ts`：纯逻辑；
- `hooks/draw.tsx`：画带重点的回复；
- `hooks/blocks.ts`：切段，抄自 aload。

- **后台提问用 `$.model.fork`。** 它把主对话上一次请求原样再发一次，后面接上我们的问题。这次请求走主对话的缓存，不进对话记录。
  - 它复制的是“上一次请求”，不一定包含最新这条回复，所以回复原文要附在问题里。
  - 还没有可以复制的对话时（`nothing-to-fork`，比如刚恢复的会话），退回用 `$.model.complete`，只带这条回复去问。
  - 档位：`$.model.fork` 没有 `effort` 参数，照搬主对话的设置；退回的 `$.model.complete` 固定 `effort: 'medium'`。
- **Markdown 元素没法给局部文字上色。** 含重点的段落由 `draw.tsx` 用 Text 自己逐行画，不含重点的段落仍交给 Markdown。
- **25% 由 `pick()` 强制执行**，不靠模型自觉。
- **按钮各占一行，和 aload 不做任何约定。** 两个插件都是把里层画好的树包一层，在下面加自己的一行按钮，所以上下排列。
  - 不放在同一行，是为了一个按钮的文字变长变短时，不挤动另一个，免得点歪。
  - 和 aload 一样用画成链接样子的 Button，不用 Markdown 链接，原因见 aload 一节。
  - 同一层的插件谁在外层由引擎决定，所以两行谁在上面不固定。
- **标重点时只换掉引擎画的正文。** 引擎画的回复正文，在树里是一个 `{ type: 'engine' }` 节点（`hooks/tree.ts`）。
  - 一般只把这个节点换成带标注的正文，里层插件加在下面的行原样留着。
  - 里层有插件把正文拆开自己画（引擎节点以外显示的文字里，有回复原文的片段，比如 aload 的每段模式），就整条改由 key-points 画，免得正文出现两遍。
- **aload 的每段模式反过来也照这个规矩。** 先按整条回复调一次 `next(e)`：
  - 树里没有引擎节点了，说明里层有插件把整条重画了（比如 key-points 在标重点），就让它画；
  - 否则把引擎节点以外的部分（别的插件加在下面的东西）接在最后一段后面。
- **测试工具的写法。**
  - 扮演引擎画回复时，返回 `{ type: 'engine', ref: 0 }`，和真引擎一样；
  - 测试里的 `$` 没有 `store`，要用 `on('store.get')`、`on('store.set')` 扮演；
  - 触发 `session.start` 前，要先在 `on` 里给它一个底（返回 `{ cwd }`）；
  - 桌面端会把 Text 的 `weight` 再写一份成 `bold`。

### index

**结构**：插件代码在 `hooks/register.tsx`（`/index` 命令、目录面板、后台写摘要、点击跳转）。另有几个文件：
- `hooks/turns.ts`：纯逻辑，切轮次、截断折行、摘要提示词、对号；
- `hooks/rows.ts`：记下界面画过的行；
- `hooks/jump.ts`：找到那一行、往上翻找、翻到顶上。

- **目录按 `$.session.messages()` 切。** 它不含 isMeta 的消息（技能正文、本地命令的说明），但含任务通知、`<command-name>` 行、`[Request interrupted by user]`。
  - 以引擎标签（`<task-notification>` 这类带连字符的标签）开头的、别的会话发来的，不进目录，但会结束上一轮；
  - 斜杠命令有回答才算一轮。本地命令的输出不在这里面，没法靠它认。
- **跳转用 `$.ui.scroll({ to: { requestId }, block: 'start' })`。** 只在全屏界面、而且是用户自己按下时才翻得动对话（不然 deny `not person-initiated`）。
  - 提问行的 requestId 就是消息的 uuid，但 `$.session.messages()` 不给 id，只能从 `ui.render` 的 UserMessage 里记下来；
  - 刚发出的提问先以 `placeholder` 的 id 画一次，再换成真 id；
  - 没画过的行也能直接翻过去，但第一次可能落不准（高度还没量），所以翻完看 `onScreen`，不在顶上就再翻一次。
- **全屏界面只画屏幕附近的行。** 很早的提问从没画过，就没有 id，要往上翻着找（`jump.ts`）。
  - 画的先后不可靠（先画屏幕里的，过一会儿才画上下预画的），不能拿来判断哪一行在上面；
  - 所以用对话记录里的位置：工具调用行的 requestId 就是 tool_use_id，ToolGroup 的 `calls` 带着 tool_use_id，回复按文字。挑“在目标下面、离它最近”的一行翻到屏幕底部，一屏一屏往上；
  - 大会话里一屏带长 diff 的行，画出来可能要半秒多，所以每步最多等 900ms；
  - 插件处理一次点击有 10 秒上限（`$.clock.sleep` 也算），翻找最多 7 秒，没找到就提示再点一次。
- **不要钩 `session.append` 和 `classic.*`。** 公司装的 `cc-plugin-sec-default` 排在前面，会绕过它们，还在对话里插一条提示（甚至发给模型），CC 2.1.307 实测。
- **`$.fs.read` 读不了超过 4 MiB 的文件**，会话记录文件很容易超过，所以不读它。
- **测试工具的写法。**
  - 测试工具里插件的 `$.ui.scroll` 到不了测试的钩子（直接报 no implementation），所以跳转逻辑放在 `jump.ts`，翻动、等待由调用方传进来，测试里用一个模拟的“屏幕”；
  - 测试里的 `$` 没有 `state`；后台写摘要没有可等的东西，测试里反复画目录，直到不再变；
  - `command.run` 的 `presentation` 测试里不会自动填。
