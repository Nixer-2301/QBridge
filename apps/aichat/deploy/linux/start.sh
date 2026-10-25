#!/usr/bin/env bash
# QBridge AI Chat 启动脚本（离线包，自带 Node，无需系统安装 Node.js）
#
#   bash start.sh            # 正常启动（交互终端下是 TUI，systemd 下是纯文本日志）
#   bash start.sh --check    # 只做预检：配置 / 提示词 / OneBot 连接 / 模型探针
#   bash start.sh --no-splash
#
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

NODE_BIN="$DIR/runtime/node/bin/node"

if [ ! -f "$NODE_BIN" ]; then
    echo "[x] 找不到自带 Node：$NODE_BIN" >&2
    exit 1
fi

# zip 解压会丢掉可执行位，这里兼容两种形态。
if [ ! -x "$NODE_BIN" ]; then
    chmod +x "$NODE_BIN" 2>/dev/null || true
fi

if ! "$NODE_BIN" -v >/dev/null 2>&1; then
    echo "[x] 自带 Node 无法运行（架构或 glibc 不匹配）。" >&2
    echo "    系统：$(uname -sr) / $(uname -m)" >&2
    echo "    需要 linux-x64，glibc >= 2.28（Ubuntu 20.04+ 均可）。" >&2
    exit 1
fi

if [ ! -f config/config.json ]; then
    cp config/config.example.json config/config.json
    echo "[!] 已生成 config/config.json，请填写 onebot.url 与 llm.model，然后重新运行。" >&2
    echo "    本机网络需要能访问 QBridge 的 OneBot 端口（默认 3001）。" >&2
    exit 1
fi

if [ ! -f .env ]; then
    cp .env.example .env
    chmod 600 .env 2>/dev/null || true
    echo "[!] 已生成 .env，请填入 QB_ONEBOT_TOKEN 与 LLM_API_KEY，然后重新运行。" >&2
    exit 1
fi

mkdir -p logs

exec "$NODE_BIN" app/dist/index.js "$@"
