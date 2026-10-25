# QBridge AI Chat · Linux 离线部署

这个包**自带 Node 运行时**，目标机不需要安装 Node.js。适用 Ubuntu 20.04+ / Debian 11+（glibc ≥ 2.28，x86_64）。

```
qbridge-aichat-<版本>-linux-x64/
├─ start.sh                     启动入口
├─ runtime/node/bin/node        自带 Node 24
├─ app/dist/                    编译好的机器人
├─ app/node_modules/            生产依赖（只有一个纯 JS SDK）
├─ config/config.example.json   配置模板（复制成 config.json 再改）
├─ prompts/                     系统提示词（支持热更新）
├─ .env.example                 密钥模板
├─ deploy/                      systemd 单元 + 安装脚本
└─ README-deploy.md             本文件
```

## 先决条件：QQ 与 QBridge 跑在另一台 Windows 上

本包**只负责回复后端**。QQ 登录发生在 QBridge（SnowLuma）那一侧，Ubuntu 服务器上不登录 QQ。

```
[Windows: QQ 已登录 + QBridge]
        │ ws://<Windows 的私网/Tailscale IP>:3001/  accessToken 鉴权
        ▼
[Ubuntu: 本包]
        │ HTTPS
        ▼
[模型服务：DeepSeek / 任意 OpenAI 兼容端点]
```

Windows 侧要改一处：`QBridge/config/onebot_<QQ号>.json` 里 `networks.wsServers[0].host` 从
`127.0.0.1` 改成 `0.0.0.0`（或该机器的 Tailscale IP），重启 QBridge，并在 WebUI 里确认端口 3001 正常。

> 安全：3001 的 accessToken 是唯一凭据。强烈建议只走 Tailscale / WireGuard / SSH 隧道，
> 不要把 3001 直接暴露到公网。SSH 隧道示例（在服务器上执行）：
> `ssh -N -L 3001:127.0.0.1:3001 user@windows-host`，然后 `onebot.url` 继续写 `ws://127.0.0.1:3001/`。

## 1. 解压

```bash
sudo apt install -y unzip        # 用 tar.gz 则不需要
unzip qbridge-aichat-*-linux-x64.zip -d ~/
# 或： tar -xzf qbridge-aichat-*-linux-x64.tar.gz -C ~/
cd ~/qbridge-aichat-*-linux-x64
```

zip 不带可执行位，统一用 `bash start.sh`；tar.gz 保留了 `+x`，也可以 `./start.sh`。
若目录名带版本号，后面所有命令请按实际路径替换。

## 2. 填配置

```bash
cp config/config.example.json config/config.json
cp .env.example .env && chmod 600 .env
```

编辑 `config/config.json`：

```jsonc
{
    "onebot": { "url": "ws://<Windows 的 IP 或 Tailscale IP>:3001/" },
    "llm": { "baseUrl": "https://api.deepseek.com/v1", "model": "deepseek-chat" },
    "bot": { "owners": [你的QQ号] },          // 可选：启用 /reset、/reload
    "prompt": { "dir": "prompts", "main": "system.md" }
}
```

编辑 `.env`：

```
QB_ONEBOT_TOKEN=<QBridge 里该账号的 accessToken>
LLM_API_KEY=<模型密钥>
```

token 在 Windows 的 `QBridge/config/onebot_<QQ号>.json` 里，`networks.wsServers[0].accessToken`。

## 3. 预检（强烈建议）

```bash
bash start.sh --check
```

会依次检查：配置文件 → 提示词文件 → OneBot 连接与账号信息 → 模型探针 → 图片开关。

```
[ OK ] 配置文件  /home/me/.../config/config.json
[ OK ] 提示词    system.md（无群专属）
[ OK ] OneBot    ws://100.x.x.x:3001/ → Nixer(3858972062)
[ OK ] 模型      deepseek-chat @ https://api.deepseek.com/v1（820ms，回复「在的」）
[ OK ] 图片输入  已开启（最多 4 张 / 5120 KB）
```

任何一项 `[FAIL]` 就先修它，不要急着起服务。

## 4. 前台试跑

```bash
bash start.sh
```

- 交互终端（SSH）里是**三段式 TUI**：顶部固定横幅、中间日志可滚轮滚动、底部状态框，`q` 退出。
- 管道 / systemd 下自动退化成纯文本日志，无需参数。
- 想在服务器上长期看 TUI：`tmux new -s chat` 里跑，或 `tmux attach -t chat` 回看。

## 5. 装成 systemd 服务

```bash
sudo bash deploy/install-service.sh
journalctl -u qbridge-aichat -f
```

脚本会：创建 `qbridge` 系统用户 → 复制到 `/opt/qbridge-aichat` → 安装单元 → 启动。
自定义路径：`sudo INSTALL_DIR=/srv/aichat bash deploy/install-service.sh`。

常用命令：

```bash
systemctl status qbridge-aichat
systemctl restart qbridge-aichat
journalctl -u qbridge-aichat -n 100 --no-pager
```

单元里默认 `QB_LOG_FILE=off`（日志走 journald）；想要文件日志就删掉那一行，日志会写到
`/opt/qbridge-aichat/logs/bot-<时间戳>.log`，记得配 logrotate。

## 6. 升级

```bash
sudo systemctl stop qbridge-aichat
# 备份：cp -a /opt/qbridge-aichat/{config,prompts,.env,logs} /tmp/aichat-backup/
unzip qbridge-aichat-新版本-linux-x64.zip -d ~/
sudo rsync -a --exclude config --exclude prompts --exclude .env --exclude logs \
    ~/qbridge-aichat-新版本-linux-x64/ /opt/qbridge-aichat/
sudo chown -R qbridge:qbridge /opt/qbridge-aichat
sudo systemctl start qbridge-aichat
```

`config/`、`prompts/`、`.env`、`logs/` 永远保留，不要被覆盖。

## 排查

| 现象 | 处理 |
| --- | --- |
| `自带 Node 无法运行` | 确认是 x86_64 机器（`uname -m` 应输出 `x86_64`）、glibc ≥ 2.28（`ldd --version`） |
| `Permission denied` 执行 start.sh | 用 `bash start.sh`，或 `chmod +x start.sh runtime/node/bin/node` |
| `找不到 config/config.json` | 先 `cp config/config.example.json config/config.json` 并填好 |
| 预检 OneBot 失败 | Windows 侧 `host` 是否改成 `0.0.0.0`；防火墙；`nc -vz <ip> 3001`；token 是否复制完整 |
| 预检模型 401 | `LLM_API_KEY` 错或该 key 没开通；确认 `llm.baseUrl` 与 key 是同一家 |
| 模型 429 / 超时 | 调大 `llm.retries` / `llm.timeoutMs`，或换更快模型 |
| 图片不生效 | 看日志有无 `附带图片`；模型服务商需能访问 QQ 的 `gchat.qpic.cn`，否则图片会被拒绝 |
| 群里 @ 没反应 | 检查 `bot.groups` 黑白名单；日志级别调 `debug` 看「未触发回复」 |
| 重启后不记得之前聊的 | 上下文在内存里，重启即清空，属预期行为 |

## 安全与合规

- `.env` 与 accessToken 不要提交、不要贴群；`chmod 600 .env`。
- 只在内网/Tailscale 里开 OneBot 端口，别把 3001 暴露到公网。
- 群消息会原样发给你配置的模型服务商，涉密群请先评估。
- 用测试号或小号跑，遵守《QQ 用户协议》与当地法律。
