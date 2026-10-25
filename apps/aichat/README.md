# QBridge AI Chat

QQ 群 AI 聊天机器人**回复后端**。QQ 接入交给 [QBridge](https://github.com/Nixer-2301/QBridge)（SnowLuma 的 fork，负责 QQ 客户端 ↔ OneBot v11），本项目只做聊天逻辑：收群消息 → 组织上下文 → 调大模型 → 回群。

> 只处理**群聊**。私聊消息一律忽略。
> 默认只有**被 @** 才回复；其余群消息只用来补上下文。

```
QQ 客户端 ──Hook──> QBridge ──OneBot v11 WS──> 本项目 ──HTTPS──> 大模型 (OpenAI 兼容)
   (登录态)          (ws://127.0.0.1:3001)        (上下文/提示词/切分)      (DeepSeek / OpenAI / Qwen / Ollama…)
```

## 功能

- **仅群聊**：私聊事件直接丢弃；可按群号做白/黑名单。
- **@ 触发**：只有 @ 机器人才回复，可选附加唤醒词，也可配置成「所有群消息都回」。
- **多轮上下文**：每个群一份共享窗口（多人聊天），默认 **20 条 / 20000 tokens** 双上限，超出按「提问 + 回答」成对丢弃。
- **发言人前缀**：上下文写成 `昵称: 内容`，模型知道群里谁在说话；也可关闭。
- **系统提示词外置**：放在 `prompts/` 目录（`system.md` + `groups/<群号>.md` + `{{include}}` 片段），支持 `{botName}`、`{groupId}` 占位符，改完 `/reload` 生效，不用重启。
- **像人一样回复**：引用触发消息、按换行拆成多条消息（多段回复）、整段太长时按句号拆、同群串行保证顺序、失败自动重试。
- **管理命令**：`/reset` 清空本群上下文、`/reload` 热重载配置（仅 `bot.owners` 里列出的账号可用）。
- **可观测**：结构化日志记录连接、触发、耗时、失败原因；不打印密钥。
- **零框架依赖**：只用 `@snowluma/sdk`（官方 OneBot 客户端），其余是 Node 内置能力。

## 前置条件

1. **QBridge 已经在跑，并且 QQ 已登录**（QBridge 负责 QQ 客户端接入，本项目不处理登录）。
2. QBridge 里该账号的 **OneBot 正向 WebSocket** 已开启：默认 `ws://127.0.0.1:3001/`，`message_format = array`。
3. 拿到该账号的 **accessToken**：QBridge 运行目录下 `config/onebot_<QQ号>.json` 里的 `networks.wsServers[0].accessToken`（WebUI 的 OneBot 配置页也能看到）。
4. **Node.js ≥ 22.6**（建议 24.x，`node --version` 自查）。

> 如果 QBridge 里把该账号的 wsServers 的 `accessToken` 清空了，本项目 `onebot.accessToken` 也可以留空。

## 快速开始

```bash
cd ai-chat
pnpm install            # 或 npm install
npm run build

mkdir config            # Windows: md config
# 复制配置模板
cp config.example.json config/config.json     # Windows: copy config.example.json config\config.json
cp .env.example .env                          # Windows: copy .env.example .env
```

编辑 `config/config.json`：

```jsonc
{
    "onebot": {
        "url": "ws://127.0.0.1:3001/",   // QBridge 的正向 WS 地址
        "accessToken": "${QB_ONEBOT_TOKEN}"
    },
    "llm": {
        "baseUrl": "https://api.deepseek.com/v1",
        "apiKey": "${LLM_API_KEY}",
        "model": "deepseek-chat"
    },
    "prompt": {
        "system": "你是「{botName}」，群里的普通成员……"
    }
}
```

编辑 `.env`（已在 `.gitignore` 中，不要提交）：

```
QB_ONEBOT_TOKEN=把 onebot_<QQ号>.json 里的 accessToken 粘这里
LLM_API_KEY=sk-xxxx
```

启动（推荐 wezterm 日志窗口）：

```
双击 start-wezterm.cmd          # wezterm 新窗口 + 彩色启动动画 + 日志落盘
```

其它方式：

```bash
npm start          # 生产：跑 dist/
npm run dev        # 开发：直接跑 TypeScript 源码，改文件自动重启
node dist/index.js --no-splash --config config/config.json
```

启动时先播一段橙黄渐变的 `Q Bridge` 横幅（源自 `z.py`，已用 Node 重写，不依赖 Python），随后是日志。日志**同时**：

- 打印到终端（保留颜色，可滚动回看）；
- 由程序写入 `logs/bot-<YYYYMMDD-HHmmss>.log`（纯文本，方便事后排查）。

相关环境变量：

| 变量 | 作用 |
| --- | --- |
| `QB_LOG_FILE` | 日志目录，默认 `logs`；设为 `off` 关闭文件日志 |
| `QB_NO_SPLASH` | 设为 `1` 跳过启动动画（等价于 `--no-splash`） |

> 动画只在 TTY 下播放；如果环境里设了 `NO_COLOR`（不少工具链会设），会自动退化成纯文本横幅。`start.ps1` 会先清掉 `NO_COLOR`，所以 wezterm 窗口里是彩色的。

看到这几行就成功了：

```
INFO [aichat] 配置文件：…\config\config.json
INFO [aichat] 日志文件：…\logs\bot-20261025-002150.log
INFO [aichat:qq] 已连接 QQ 账号 昵称(QQ号)
INFO [aichat] 机器人已就绪，等待群消息
INFO [aichat:chat] 收到触发消息 群=123456 用户=小明(987654) 长度=5
INFO [aichat:chat] 回复完成 群=123456 分片=1 字数=42 耗时=1830ms
```

然后在群里 @ 它说话即可。

## CLI 界面（TUI）

在交互式终端里启动时是一个三段式界面，`top` 与 `bottom` 固定，中间日志区自己滚动：

```
┌──────────────────────────────────────────────────────────────┐
│         ____      ____             _        __               │
│        / __ \    / __ )   _____   (_)  ____/ /  ____ _   ___  │   ← 固定：Q Bridge 动画
│       / / / /   / __  |  / ___/  / /  / __  /  / __ `/  / _ \ │
│      / /_/ /   / /_/ /  / /     / /  / /_/ /  / /_/ /  /  __/ │
│      \___\_\  /_____/  /_/     /_/   \__,_/   \__, /   \___/  │
│                                              /____/           │
├──────────────────────────────────────────────────────────────┤
│ 08:21:52 已连接 QQ 账号 Nixer(3858972062)                     │   ← 中间：跟随/滚动
│ 08:21:52 机器人已就绪，等待群消息                              │
│ 08:23:10 收到触发消息 群=123456 用户=小明(987654) 长度=5       │
│ 08:23:12 回复完成 群=123456 分片=1 字数=42 耗时=1830ms         │
├──────────────────────────────────────────────────────────────┤
│ ● 已连接 Nixer(3858972062)  模型 deepseek-chat  滚动 跟随最新 │   ← 固定：状态框
│ 群 3  消息 12  最近回复 群 123456 · 1.8s  运行 00:12:34        │
│ 滚轮/PgUp/PgDn 滚动 · End 回到底部 · r 重播动画 · q 退出       │
└──────────────────────────────────────────────────────────────┘
```

| 操作 | 效果 |
| --- | --- |
| 鼠标滚轮 / `↑` `↓` | 上下滚动日志（每档 3 行） |
| `PgUp` / `PgDn` | 整屏翻页 |
| `Home` / `g` | 跳到缓冲区顶部 |
| `End` / `G` | 回到底部并恢复跟随 |
| `r` | 重播顶部动画 |
| `q` / `Ctrl+C` | 优雅退出（断开 QQ、落盘日志、还原终端） |

- 顶部字形来自 [`tools/banner/z.py`](tools/banner/z.py)（pyfiglet `slant`），动画的色相/明度公式与该脚本一致；`src/banner-art.ts` 由它生成，不依赖 Python 运行。
- 窗口高度 < 24 行时横幅自动退化成一行标题；状态框在极小窗口下压成一行，日志区始终保留。
- 日志区有 5000 行环形缓冲；CJK/emoji 按 2 列宽度裁剪，不会把边框撑歪。
- 管道/CI 场景（stdout 不是 TTY）自动退化成纯文本日志；也可强制：`--plain` 或 `QB_PLAIN=1`。

## 合并进 QBridge 仓库

本应用位于 fork 的 `apps/aichat/`，**不加入 pnpm workspace**（`packages/*` 之外），所以不会影响 Core/OneBot 的构建、测试与 CI：

```bash
cd QBridge/apps/aichat
pnpm install --ignore-workspace   # 独立依赖树，不污染根 workspace
npm run build && npm start
```

在 QBridge 仓库内运行 `pnpm` 会用到仓库声明的 Node 24.22 / pnpm 11.25（`.node-version` 与 `packageManager`），与 Core 保持一致。

## 配置说明

配置文件默认是 `config/config.json`，也可用 `--config <路径>` 或环境变量 `QB_CONFIG_PATH` 指定。所有字符串值都支持 `${ENV_NAME}` 展开；**配置项写错（拼写错误、越界）会直接启动失败并指出位置**，不会静默忽略。

### `onebot`

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `url` | `ws://127.0.0.1:3001/` | QBridge 的 OneBot 正向 WS 地址，必须是 `ws://` 或 `wss://` |
| `accessToken` | 空 | 填入 QBridge 的 token；留空则不带鉴权 |
| `requestTimeoutMs` | `60000` | 单次 OneBot 动作请求超时 |
| `reconnect` | `true` | 断线自动重连（1s 起，最长 30s 退避） |

### `bot`

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `name` | `小助手` | 机器人名字，用于系统提示词的 `{botName}` |
| `trigger.requireAt` | `true` | `true` = 只认 @（可加唤醒词）；`false` = 所有群消息都回复 |
| `trigger.wakeWords` | `[]` | 不需要 @ 也能触发的词，例如 `["小助手", "bot"]` |
| `recordAllGroupMessages` | `true` | 未触发回复的消息也写入上下文，模型才知道群里刚聊了什么 |
| `replyQuote` | `true` | 回复时引用触发消息（QQ 里的「回复」气泡） |
| `atSender` | `false` | 回复时额外 @ 触发者 |
| `groups.whitelist` | `[]` | 只处理这些群；空 = 所有群 |
| `groups.blacklist` | `[]` | 永不处理这些群，优先级高于白名单 |
| `owners` | `[]` | 可以用 `/reset`、`/reload` 的 QQ 号 |
| `maxReplyChars` | `1200` | 单条消息最大字数，超长自动切分（上限 4500） |
| `splitParagraphs` | `true` | 换行（单换行或空行）即分段，每段单独发一条消息 |
| `triggerOnReply` | `true` | 引用（回复）机器人的消息也触发，不必 @ |
| `triggerMarker` | `@你` | 发给模型时给当前提问加的前缀，帮模型分清「在问谁」；空字符串关闭 |
| `sentenceSplitAt` | `40` | 整段没有换行且超过这个字数时按句号拆；`0` 关闭 |
| `maxReplySegments` | `4` | 一次回复最多拆几条，超出的段落并回最后一条 |
| `chunkDelayMs` | `400` | 分片之间的间隔，避免刷屏 |
| `notifyOnError` | `false` | 模型调用失败时是否在群里提示一句 |

### `context`

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `maxMessages` | `20` | 单群保留的消息条数上限 |
| `maxTokens` | `20000` | 单群上下文（系统提示词 + 历史）token 预算 |
| `maxCharsPerMessage` | `2000` | 单条消息写入上下文时截断长度 |
| `maxGroups` | `200` | 最多同时记住多少个群，超出按最久未活动淘汰 |
| `idleTtlMinutes` | `720` | 群上下文空闲多久后丢弃 |
| `includeSpeakerName` | `true` | 是否给消息加 `昵称: ` 前缀 |

上下文规则：

- **按群共享**，不是按人。群里 A、B 说话都在同一个窗口，模型看到的是连贯的群聊。
- 条数与 token **双上限**同时生效；裁剪从最旧的问答对开始，永远保留最新的提问。
- token 用「中文 ≈ 0.6 token/字、其它 ≈ 4 字符/token」估算并**取上界**，宁可早裁也不超模型窗口。
- 纯图片/表情/语音等非文本消息以 `[图片]`、`[表情]`、`[语音]` 占位写入，模型不会看到空白。
- 上下文保存在**内存**里，进程重启后清空（`/reset` 可手动清空单个群）。

### `llm`

任何 OpenAI 兼容端点都能用（DeepSeek、OpenAI、通义、Kimi、one-api、本地 Ollama/vLLM）。

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `baseUrl` | `https://api.deepseek.com/v1` | 会自动拼 `/chat/completions`；已带该后缀则原样使用 |
| `apiKey` | 空 | 留空则不发 `Authorization`（本地 Ollama 常用） |
| `model` | `deepseek-chat` | 模型名 |
| `temperature` | `0.8` | 0–2 |
| `topP` | `1` | 0–1 |
| `maxTokens` | `1024` | 回复长度上限 |
| `timeoutMs` | `60000` | 单次请求超时 |
| `retries` | `1` | 失败重试次数（429/5xx/超时/网络错误才重试） |
| `extraHeaders` | `{}` | 额外请求头 |
| `extraBody` | `{}` | 直接并入请求体，例如 `{"enable_thinking": false}` |

常见端点示例：

```jsonc
// OpenAI
{ "baseUrl": "https://api.openai.com/v1", "model": "gpt-4o-mini" }
// 通义千问（DashScope 兼容模式）
{ "baseUrl": "https://dashscope.aliyuncs.com/compatible-mode/v1", "model": "qwen-plus" }
// 本地 Ollama
{ "baseUrl": "http://127.0.0.1:11434/v1", "apiKey": "", "model": "qwen2.5:7b" }
```

### `prompt`

系统提示词**不在 JSON 里**，而是放在 `prompts/` 目录（可版本管理、可 diff、可复用片段）：

```jsonc
{
    "dir": "prompts",      // 提示词目录，相对启动目录（也可写绝对路径）
    "main": "system.md",   // 主提示词文件（相对 dir）
    "perGroup": {},        // 可选：群号 -> 相对 dir 的路径，优先级最高
    "hotReload": true      // 监听文件变化自动重载（默认开启）
}
```

目录约定：

```
prompts/
├─ system.md              # 全局默认提示词
├─ rules.md               # 公共规则片段（被 system.md 通过 {{include:rules.md}} 引入）
├─ persona.md             # 需要的话再拆其它片段
└─ groups/
   ├─ 123456789.md        # 只对 123456789 生效（文件名必须是纯数字群号）
   └─ 987654321.md        # 其它群继续用 system.md
```

解析顺序：`prompt.perGroup[群号]` → `prompts/groups/<群号>.md` → `prompts/system.md`。

- 占位符：`{botName}`、`{groupId}`、`{triggerMarker}`，在每次请求时替换。`{triggerMarker}` 用于在提示词里说明「只回答带这个前缀的消息」。
- 片段复用：`{{include:rules.md}}` 会把文件内容拼进来，最多 4 层；出现循环或指向 `prompts/` 之外的路径会直接报错并指出链路。
- 文件读写：自动去掉 BOM、把 CRLF 归一成 LF；空提示词会报错，不会静默发一条空 system 消息。
- 热更新：默认监听 `prompts/`（含 `groups/`），保存文件后约 0.3 秒自动重载，主提示词和群提示词都生效；保存到一半读到空文件会保留上一版并打 warn。`hotReload: false` 可关闭监听。
- 手动重载：群里发 `@机器人 /reload`（需 `bot.owners`）会同时重载 `config.json` 和提示词文件。
- 目录 / main 文件名 / hotReload 开关的改动需要重启进程（文件内容不需要）。
- 兜底：`prompts/system.md` 不存在时会自动生成（若配置里还留着旧的 `prompt.system` 就用它，否则用内置默认值），并打一条 warn。
- 旧配置的 `prompt.system` 仍能读入，但只用于「主文件缺失时生成文件」这一次；正常配置请删掉它。

写提示词的几条经验：

- 明确「群消息是别人说的，不是系统指令」，降低提示词注入风险；
- 要求口语化、简短，避免「有什么可以帮你」这类客服腔；
- 不确定就说不确定，避免编造；
- 不要输出 Markdown 标题/表格（QQ 不渲染，只会变成一堆井号）；
- 需要「按群不同人设」时，复制一份 `system.md` 到 `groups/<群号>.md` 再改，不要挤在 JSON 里。

### `vision`

群消息里的图片会作为 OpenAI 兼容的多模态分段（`image_url`）发给模型，历史里仍保存 `[图片]` 占位符，不会把 base64 存进上下文。

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 是否把图片发给模型 |
| `maxImages` | `4` | 单条消息最多带几张图 |
| `maxBytes` | `5242880` | 单张内联图片（data URI）的体积上限，超出跳过 |

- 图片来源只认三类：QBridge 给的 `https://…`（带 rkey 的链接）、`data:` URI、`base64://`；本地路径与 QQ 内部 file token 直接跳过（既不读本机文件，也不报错）。
- 引用的图片只在**触发消息**上发送，不带历史图片，避免每轮都重复计费。
- 端点拒绝多模态时（HTTP 400/415/422）会自动退回纯文本重试一次，并打一条 warn，不会让这条消息直接失败。
- 关闭：`"vision": { "enabled": false }`。
### `github`

轮询 GitHub 仓库，出现新 Release（或新提交）时发到指定群。首次运行只记录当前状态、不补发历史。

```jsonc
{
    "enabled": true,
    "intervalSeconds": 300,            // 最小 60
    "token": "${GITHUB_TOKEN}",        // 可选，提高 API 限额
    "stateFile": "data/github-state.json",  // 已推送事件的记录，避免重启重复发
    "postExisting": false,             // 首次运行是否补发当前事件
    "targets": [
        {
            "repo": "rikkahub/rikkahub",
            "groupIds": [628101497],
            "kinds": ["release"],      // release / commit，可同时监听
            "template": {              // 可选：按事件覆盖模板
                "release": "🐙新版本 {tag}\n{body}\n{url}"
            }
        }
    ]
}
```

| 占位符 | release | commit |
| --- | --- | --- |
| `{repo}` | owner/repo | owner/repo |
| `{tag}` | Release tag | — |
| `{title}` | Release 标题 | 提交标题（首行） |
| `{body}` | 更新说明（截断 500 字） | 提交正文 |
| `{author}` | Release 作者 | 提交者 |
| `{url}` | Release 页面 | commit 页面 |
| `{sha}` | — | 短 sha |
| `{date}` | — | 提交时间 |

默认模板就是「🐙Github检测到Release / 🏷[tag] / 标题 / 说明 / 提交者 / 链接 / ---」这套版式。
监听提交把 `kinds` 改成 `["commit"]`，或 `["release","commit"]` 两个都要。

- 轮询走 GitHub REST API（`/releases`、`/commits`），未认证限额 60 次/小时，`intervalSeconds` 别小于 60；填 `GITHUB_TOKEN` 可放宽到 5000。
- 状态文件记录 `repo:kind → 最近事件 id`，重启不会重复推送；写失败会在日志里报错但不影响其它目标。
- 正文字数超过 `bot.maxReplyChars` 会按 QQ 限制自动切成几条发。

### `autoReplies`

指定用户发言时，自动回一个**固定表情包**（不走模型、不计入上下文）。

```jsonc
{
    "enabled": true,
    "rules": [
        {
            "userIds": [1609403959],       // 触发用户
            "groupIds": [628101497],       // 生效群；空数组 = 所有群
            "face": "是钢卷",               // 商城表情的文字摘要
            "image": "",                    // 可选兜底：本地路径 / http(s) / base64
            "text": "",                     // 可选兜底：一句话
            "cooldownSeconds": 60,          // 同群同规则冷却
            "probability": 1                // 命中概率，1 = 必发
        }
    ]
}
```

**表情是「先学后发」的**：QQ 只认 `emoji_id`，光有名字发不出去。所以机器人会把收到的商城表情元数据
（`emoji_id` / `emoji_package_id` / `key`）缓存到 `data/faces.json`：

- 目标用户第一次发表情包时，机器人立刻学会，并按规则原样回发同一个表情；
- 之后该用户任何消息都会命中规则（受冷却限制）；
- 没学过就配了规则也没关系：日志会提示「还没学到表情 X」，收到一次后自动可用；
- 手动补发：`@机器人 /face 是钢卷`（`/face` 不带名字会列出已学到的表情）。

兜底顺序：商城表情 → `image` → `text`。三者都没有（或图片读不到）时只写一条 warn，不发消息。
`image` 支持本地文件（自动转 data URI，可跨机器）、http(s) 链接、`base64://`。

### `logging`

`level`：`debug` / `info` / `warn` / `error` / `silent`，默认 `info`。`debug` 会为**每条**群消息打一行「@=是/否 引用机器人=是/否 文本=… → 触发/忽略」，排查「为什么没回」时打开它，然后 `/reload` 或重启。

## 管理命令

在群里 `@机器人` 后发送（只有 `bot.owners` 里的账号有效）：

| 命令 | 作用 |
| --- | --- |
| `/reset` | 清空**本群**上下文 |
| `/reload` | 重新读取 `config/config.json`（提示词、模型、触发规则等即时生效） |
| `/ping` | 立即回 `pong · 在线`，用来验证「消息能否到达机器人」，不走模型 |
| `/face <名称>` | 发送已学到的商城表情；不带名字会列出缓存 |
| `/help` | 查看命令 |

## 不用 QQ 也能测

### 1. 离线自检（推荐先跑这个）

```bash
npm run build
node tools/smoke.mjs
```

它会起一个假 OneBot 服务端 + 假模型服务，用**真实机器人进程**跑一遍「连接 → 收到 @ → 组上下文 → 调模型 → 发群消息」，最后打印每项检查结果。不需要 QQ、QBridge、真实密钥。

### 2. 交互式假服务端

```bash
node tools/mock-onebot.mjs
```

另开一个终端，把 `onebot.url` 指向 `ws://127.0.0.1:3001/` 启动机器人，然后：

- 直接输入文字 → 以「@机器人 + 文本」的群消息发过去；
- `/say 文字` → 发一条不 @ 的普通群消息（只进上下文，不回复）；
- `/quit` 退出。

### 3. 自动化测试

```bash
npm test          # 210 个用例：配置、上下文裁剪、切分、模型重试、服务流程、真实 WS、TUI 布局与滚动
npm run typecheck
```

## 部署

### Linux 离线包（推荐：目标机不需要装 Node）

```bash
npm run pack:linux            # 产出 build/qbridge-aichat-<版本>-linux-x64.{zip,tar.gz,sha256}
```

包内自带 Node 24（linux-x64）、编译好的 `app/dist`、生产依赖、`prompts/`、systemd 单元和安装脚本：

```
qbridge-aichat-<版本>-linux-x64/
├─ start.sh                  # bash start.sh / bash start.sh --check
├─ runtime/node/bin/node     # 自带运行时
├─ app/{dist,node_modules}
├─ config/config.example.json
├─ prompts/
├─ deploy/{install-service.sh,qbridge-aichat.service,README-deploy.md}
└─ VERSION
```

服务器上三步：

```bash
unzip qbridge-aichat-*-linux-x64.zip && cd qbridge-aichat-*-linux-x64
cp config/config.example.json config/config.json && cp .env.example .env && chmod 600 .env
bash start.sh --check          # 配置 / 提示词 / OneBot / 模型 / 图片 五项预检
bash start.sh                  # 前台跑；确认没问题后 sudo bash deploy/install-service.sh
```

详细步骤、跨机网络（QBridge 在 Windows、访问 3001 的隧道做法）、升级与排查见
[`deploy/linux/README-deploy.md`](deploy/linux/README-deploy.md)。

> QQ 登录仍然发生在 QBridge 那一侧（Windows + QQ 客户端）。本包只跑回复后端，
> 通过 `ws://<Windows IP>:3001/` 连过去。

### PM2

```bash
pm2 start dist/index.js --name qbridge-aichat --cwd /path/to/ai-chat
pm2 logs qbridge-aichat
```

### systemd

```ini
[Unit]
Description=QBridge AI Chat
After=network.target

[Service]
WorkingDirectory=/opt/ai-chat
ExecStart=/usr/bin/node dist/index.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

### Windows

用 `nssm install QBridgeAIChat "C:\Program Files\nodejs\node.exe" "dist\index.js"`，或在任务计划程序里设置「登录时启动」。

> 机器人和 QBridge 通常跑在同一台机器；`onebot.url` 保持 `127.0.0.1` 最安全，不要为了「方便」把 OneBot 端口暴露到公网。

## 排查

| 现象 | 原因与处理 |
| --- | --- |
| `找不到配置文件` | 没复制 `config.example.json` 到 `config/config.json` |
| `引用未定义的环境变量 XXX` | `.env` / 系统环境里缺这个变量；变量名要和配置里 `${...}` 一致 |
| `无法连接 ws://127.0.0.1:3001` | QBridge 没启动、该账号 OneBot 未开启、端口/路径不一致。`onebot.reconnect=true` 时机器人不会退出，会一直按退避重连，等 QBridge 起来自动接上 |
| 连上了但 `读取账号信息失败` | `accessToken` 不对；去 QBridge 的 `config/onebot_<QQ号>.json` 重新复制 |
| 模型 `401` | `LLM_API_KEY` 错或没配；错误信息会打印状态码和服务端返回片段 |
| 模型 `429` / 超时 | 触发限流或网络慢；调大 `llm.retries` / `timeoutMs` |
| @ 了没反应 | 检查 `bot.groups` 黑名单、是否 @ 的是机器人而不是 @全体；`logging.level` 调 `debug` 看是否「未触发回复」 |
| 回复很长被拆成多条 | 正常行为，由 `bot.maxReplyChars` 控制；想更短就调小 |
| 机器人不记得刚才说的话 | 上下文在内存里，重启会清空；`recordAllGroupMessages` 关闭时未 @ 的消息不进上下文 |
| 群里回复很慢 | 模型首 token 慢；换更快模型或调小 `llm.maxTokens`；非流式请求必须等整段生成完 |

`npm run dev` 下修改源码会自动重启，但 `dist/` 需要在 `npm start` 前手动 `npm run build`。

## 目录结构

```
ai-chat/
  config.example.json   配置模板
  .env.example          环境变量模板
  start-wezterm.cmd     双击：在 wezterm 窗口里启动（日志窗口）
  start.ps1             wezterm 窗口实际执行的脚本
  logs/                 运行日志（bot-<时间戳>.log，已被 git 忽略）
  src/
    index.ts            启动入口：读配置、装配、连 QQ、优雅退出
    check.ts            --check 预检：配置/提示词/OneBot/模型/图片
    banner.ts           启动横幅（z.py 的 Node 移植，TUI 头部）
    banner-art.ts       横幅字符画（由 tools/banner/z.py 生成）
    log-sink.ts         终端 + 文件双写日志
    tui/
      tui.ts            三段式界面：固定头/尾 + 可滚动日志 + 输入解析
      layout.ts         区域划分（含窗口过矮时的退化规则）
      log-buffer.ts     5000 行环形缓冲与滚动偏移
      width.ts          CJK 宽度计算与 ANSI 安全截断
      ansi.ts           ANSI 常量与转义
    config.ts           配置解析/校验/热重载
    types.ts            配置与领域类型
    prompt/
      store.ts          提示词文件加载：include、按群覆盖、路径校验
    logger.ts           带级别与作用域的结构化日志
    env.ts              极简 .env 读取
    qq/
      bot.ts            QBridge OneBot WS 接入（收发只在这里）
      segments.ts       OneBot 消息段解析、@ 检测、非文本占位
    watch/
      github.ts         轮询 Release/提交并按模板发群
    chat/
      service.ts        编排：触发判定 → 上下文 → 模型 → 切分 → 发送
      chunk.ts          长回复切分
    memory/
      store.ts          按群的上下文窗口（LRU + TTL + token 预算）
    llm/
      client.ts         OpenAI 兼容 /chat/completions 客户端（超时/重试）
      tokens.ts         token 估算
  tests/                单元测试 + 真实 WebSocket 链路测试
  deploy/linux/         Linux 离线包模板：start.sh / systemd 单元 / 安装脚本 / 部署文档
  tools/
    smoke.mjs           离线端到端自检
    mock-onebot.mjs     交互式假 OneBot 服务端
    pack-linux.mjs      打 Linux 离线包（自带 Node，产出 zip/tar.gz/sha256）
    lib/tar-modes.mjs   tar 权限修正（Windows bsdtar 写不出 +x）
    banner/z.py         CLI 横幅的 Python 原稿（字形与配色基准）
  build/                打包产物（已 git 忽略）
```

## 安全与合规

- 群消息会**原样发送**到你配置的模型服务商，涉及隐私的群请先评估。
- `config/config.json`、`.env` 已在 `.gitignore` 中；`accessToken`、`apiKey` 不要提交、不要贴到公开 issue。
- 本项目只做回复逻辑，QQ 接入与协议行为由 QBridge 负责；请遵守《QQ 用户协议》与所在地法律，使用自己的账号、别打扰无关的群。

## 已知限制

- 上下文只在内存，进程重启即清空（需要持久化可在 `ConversationStore` 后接 SQLite/Redis）。
- 非流式请求：模型生成完整回复后才发群消息，长回复感知延迟较高。
- 语音/视频/文件仍只以占位符进入上下文；图片已支持（见 `vision` 配置），但需要模型本身支持多模态。
- 没有 Web 管理界面：改配置用文件 + `/reload`。











