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

## 仓库结构

| 路径 | 作用 |
|---|---|
| `.claude-plugin/marketplace.json` | 插件索引：市场名、每个插件的目录和简介 |
| `README.md`、`README.zh-CN.md` | 给人看的总览：插件一览、简介、安装方法 |
| `plugins/tag/` | 会话状态灯：一个命令加一个钩子（Python） |
| `plugins/aload/` | 点击朗读：插件代码（TypeScript）加本地助手（Python） |
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
- **平台**：只支持 macOS。Python 只用标准库：aload 用 `/usr/bin/python3`，tag 用 PATH 里的 `python3`。
- **不提交隐私**：不提交任何 Key 和个人信息。aload 的 Key 保存在用户本机的 `~/.config/aload/`。

## 开发和测试

- **校验**：
  - 市场：`claude plugin validate .`
  - 单个插件：`claude plugin validate plugins/<名字>`
- **tag**：`python3 plugins/tag/tests/test_tag.py`
- **aload**：
  - 插件测试：`claude plugin test plugins/aload`
  - 本地助手测试：`cd plugins/aload && python3 -m unittest discover -s tests`
- **在本机试用改动**：
  - **推荐把这个仓库当作本地市场添加**：`claude plugin marketplace add <仓库路径>`，然后在 `/plugin` 里安装。Claude Code 会直接读这个文件夹，改完执行 `/reload-plugins` 就生效。它和从 GitHub 添加的市场同名（都叫 `xuesinuo`），两者只能留一个。
  - **临时加载**：`claude --plugin-dir plugins/<名字>`。如果已经装了同名插件会加载两份，可以先停用，或者加上 `--setting-sources project,local` 跳过用户设置。

## 插件要点（踩过的坑）

### tag

**结构**：`commands/tag.md` 加上一个经典的 `UserPromptSubmit` 钩子 `bin/tag-hook.py`，核心逻辑在 `bin/tag.py`。

- **`commands/tag.md` 里绝不能加 `!` 去调用 tag.py。** 斜杠命令里的 `!` 会先于钩子执行，先改掉一次状态，钩子再改一次，结果是灯跳两格，提示也比实际超前一格。
- **必须直接写状态文件。** 只发 `hookSpecificOutput.sessionTitle` 点不亮灯（CC 2.1.241 实测），必须直接写 `~/.claude/jobs/<jobId>/state.json` 的 `name`。这是 Claude Code 未公开的内部结构，升级后可能失效。另外，会话进程会把内存里的标题刷回这个文件，所以 `apply_name` 写完会校验，被顶掉了就重写。
- **那行提示去不掉。** 钩子拦下输入时，Claude Code 一定会打印一行 `UserPromptSubmit operation blocked by hook`。想去掉它，只能把入口改成插件代码：用 `$.command.register` 注册命令，在 `command.run` 里自己回答，`tag.py` 的核心逻辑可以照用。
- **异常必须放行。** 钩子对每一次输入都会运行，出任何异常都必须静默放行（见 `tag-hook.py` 末尾），绝不能挡住正常的提问。
- **兼容命名空间写法。** 作为插件安装后，命令重名时会写成 `/tag:tag`，钩子的 `TRIGGER` 两种写法都认。

### aload

**结构**：插件代码在 `hooks/register.tsx`，用的是 function hooks；本地助手 `bin/aload.py` 负责合成、用 afplay 播放、管理配置和 Key。

- **插件接口还在早期阶段，版本间可能变化。** 类型声明由 Claude Code 在加载插件时生成到 `.claude-plugin/types/`（不进仓库），以那里为准。
- **默认按钮是一个链接。** 默认在每轮最终回复的末尾画一个 Markdown 链接「🔊 read aload」，用 `onLinkPress` 接住点击。只有支持超链接的终端（Ghostty、iTerm2）里，它才是蓝色带下划线、可以点；在不支持的终端里会显示网址，而且点不了。
- **怎么判断“最终回复”。** 新回复由 `turn.complete` 的 `answer` 判定；历史回复由 `$.session.messages()` 推断，任务通知和子代理回报不算作提问。
- **选中文字的处理。** 每 400ms 轮询一次 `$.ui.selection()`。`locate()` 找位置时只比对字母、数字和汉字，因为屏幕上的文字已经没有 Markdown 符号了；`speechFrom()` 从这个位置往后切出要读的各段。
- **弹面板要在点击处理里。** `ui.open` 必须在按钮这次按下的处理过程中调用，才算“用户打开的”。否则在不到 144 列的终端里，面板不会弹出来。所以点击时要先查有没有 Key，再弹输入框。
- **每段模式的排版。** 每段模式（`/aload icon paragraph|hover`）下，第一段交给引擎画，它自带一行上边距和 ⏺；后面的段用 Markdown 自己排。**不要用负边距**，相邻段一旦重叠，悬停时就会亮错段。
- **停止机制。** 结束 `$.process.spawn` 的读取循环，就会结束子进程。`aload.py stop` 则靠 PID 文件停掉全机唯一的那路声音；这里 `ps` 要加 `-ww`，否则长命令行会被截断，认不出进程。
- **豆包的报错。**
  - 403 `requested resource not granted`：Key 有效，但没开通对应的资源；
  - 401 `grant not found`：用的是新版 API Key，却又填了 App ID。
  - 遇到资源对不上，会依次试 `seed-tts-2.0`、`seed-tts-1.0`、`seed-icl-2.0`、`seed-icl-1.0`。
- **计费。** 按段落切成小块，每块不超过 220 字，边读边请求。会提前合成最多 3 块：队列里 2 块，外加 1 块已经合成好、正等着放进队列。
- **测试工具的写法。**
  - 测试里扮演引擎时，`$` 调用的结果要包成 `{ value }`；
  - 生命周期事件（如 `turn.complete`）直接返回结果；
  - 点链接要写 `press({ key, link: { href } })`。
