# 在 wezterm 窗口里启动机器人。
# 日志由程序自己写入 logs\bot-<时间戳>.log（彩色动画保留在终端里），窗口退出后不会自动关闭。
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

if (-not (Test-Path 'dist\index.js')) {
    Write-Host '未找到 dist\index.js，先构建…' -ForegroundColor Yellow
    npm run build
}

Write-Host "工作目录：$root" -ForegroundColor DarkGray
Write-Host '按 Ctrl+C 停止机器人；窗口会保留，方便查看最后的日志。' -ForegroundColor DarkGray

# 某些终端环境会设置 NO_COLOR（例如从工具链继承），这里清掉，让启动横幅保留橙黄渐变。
Remove-Item Env:NO_COLOR -ErrorAction SilentlyContinue

node dist/index.js

Write-Host ''
Write-Host ("机器人已退出（退出码 {0}）。日志：{1}" -f $LASTEXITCODE, (Join-Path $root 'logs')) -ForegroundColor Yellow
