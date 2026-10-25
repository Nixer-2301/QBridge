import path from 'node:path';
import { showSplash } from './banner.ts';
import { formatPreflight, runPreflight } from './check.ts';
import { CooldownStore } from './chat/cooldowns.ts';
import { FaceStore } from './chat/faces.ts';
import { ChatService, SenderSlot } from './chat/service.ts';
import { ConfigStore, resolveConfigPath } from './config.ts';
import { loadEnvFile } from './env.ts';
import { createLogSink, openLogFile } from './log-sink.ts';
import { createLogger } from './logger.ts';
import { LlmClient } from './llm/client.ts';
import { ConversationStore } from './memory/store.ts';
import { PromptStore } from './prompt/store.ts';
import { startQQBot } from './qq/bot.ts';
import { Tui } from './tui/tui.ts';
import { GithubWatcher } from './watch/github.ts';

const SWEEP_INTERVAL_MS = 5 * 60 * 1_000;
const STATUS_INTERVAL_MS = 1_000;

function maskSecret(secret: string): string {
    if (secret.length === 0) {
        return '未设置（若模型服务需要鉴权会返回 401）';
    }

    return secret.length <= 6 ? '***' : `${secret.slice(0, 3)}***${secret.slice(-2)}`;
}

function formatUptime(milliseconds: number): string {
    const total = Math.max(0, Math.floor(milliseconds / 1_000));
    const hours = Math.floor(total / 3_600);
    const minutes = Math.floor((total % 3_600) / 60);
    const seconds = total % 60;
    const pad = (value: number) => String(value).padStart(2, '0');

    return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
}

async function main(): Promise<void> {
    const argv = process.argv.slice(2);
    const envLoaded = loadEnvFile(path.resolve('.env'));
    const configPath = resolveConfigPath(argv);
    const config = ConfigStore.load(configPath);

    if (argv.includes('--check')) {
        const checkLogger = createLogger('aichat', () => config.value.logging.level);
        const items = await runPreflight({
            config,
            configPath,
            baseDir: process.cwd(),
            logger: checkLogger,
        });
        const { text, ok } = formatPreflight(items);

        console.log(`\nQBridge AI Chat 预检\n${text}\n`);
        process.exitCode = ok ? 0 : 1;

        return;
    }

    // 日志文件：默认 logs/ 下按时间戳命名；QB_LOG_FILE=off 关闭。
    const logSetting = (process.env['QB_LOG_FILE'] ?? 'logs').trim();
    const logHandle =
        logSetting.toLowerCase() === 'off'
            ? undefined
            : openLogFile(path.resolve(logSetting.length > 0 ? logSetting : 'logs'));

    // 交互式终端用三段式 TUI；管道/CI 下退回纯文本（QB_PLAIN=1 或 --plain 强制纯文本）。
    const useTui =
        process.stdout.isTTY === true &&
        process.env['QB_PLAIN'] !== '1' &&
        !argv.includes('--plain');
    let stopEverything: ((reason: string) => void) | undefined;
    const tui = useTui
        ? new Tui({
              stream: process.stdout,
              input: process.stdin,
              onQuit: () => stopEverything?.('TUI 退出'),
              animateFrames: argv.includes('--no-splash') || process.env['QB_NO_SPLASH'] === '1' ? 0 : 60,
          })
        : undefined;
    const logger = createLogger(
        'aichat',
        () => config.value.logging.level,
        createLogSink(tui ? tui.sink : console, logHandle?.stream),
    );

    if (tui) {
        tui.start();
    } else if (argv.includes('--no-splash') || process.env['QB_NO_SPLASH'] === '1') {
        logger.debug('已跳过启动动画');
    } else {
        await showSplash();
    }

    const settings = config.value;

    if (envLoaded.length > 0) {
        logger.info(`已从 .env 读取 ${envLoaded.length} 个环境变量：${envLoaded.join(', ')}`);
    }

    logger.info(`配置文件：${configPath}`);

    if (logHandle) {
        logger.info(`日志文件：${logHandle.path}`);
    }
    logger.info(
        `QQ 接入：${settings.onebot.url}`,
        `token=${settings.onebot.accessToken ? '已设置' : '未设置（QBridge 未启用 token 时可留空）'}`,
    );
    logger.info(
        `模型：${settings.llm.model} @ ${settings.llm.baseUrl}`,
        `apiKey=${maskSecret(settings.llm.apiKey)}`,
    );
    logger.info(
        `触发方式：${settings.bot.trigger.requireAt ? `@${settings.bot.name}` : '所有群消息'}`,
        settings.bot.trigger.wakeWords.length > 0 ? `唤醒词=${settings.bot.trigger.wakeWords.join('/')}` : '',
    );
    logger.info(
        `上下文：最多 ${settings.context.maxMessages} 条 / ${settings.context.maxTokens} tokens（按群共享）`,
    );
    logger.info(
        `处理范围：${
            settings.bot.groups.whitelist.length > 0
                ? `白名单 ${settings.bot.groups.whitelist.join(',')}`
                : '所有群'
        }`,
        settings.bot.groups.blacklist.length > 0
            ? `黑名单 ${settings.bot.groups.blacklist.join(',')}`
            : '',
    );

    const store = new ConversationStore({
        maxMessages: settings.context.maxMessages,
        maxTokens: settings.context.maxTokens,
        maxCharsPerMessage: settings.context.maxCharsPerMessage,
        maxGroups: settings.context.maxGroups,
        idleTtlMs: settings.context.idleTtlMinutes * 60_000,
    });

    const llm = new LlmClient({
        getConfig: () => config.value.llm,
        logger: logger.child('llm'),
    });

    // 系统提示词来自 prompts/ 目录（可按群覆盖），/reload 时一并重新读取。
    const prompts = new PromptStore({
        config: settings.prompt,
        baseDir: process.cwd(),
        logger: logger.child('prompt'),
    });
    prompts.watch();

    const faces = new FaceStore(path.resolve('data/faces.json'), logger.child('faces'));
    logger.info(`表情缓存：${faces.size} 个`, faces.list().slice(0, 5).join('、'));

    for (const rule of settings.autoReplies.rules) {
        logger.info(
            `自动表情规则：用户 ${rule.userIds.join(',')} → ${rule.face ?? rule.image ?? rule.text ?? '?'}`,
            `群=${rule.groupIds.length > 0 ? rule.groupIds.join(',') : '全部'} 冷却=${rule.cooldownSeconds}s 概率=${rule.probability}`,
        );
    }

    const cooldowns = new CooldownStore(path.resolve('data/auto-replies.json'), logger.child('cooldown'));

    const stats = { events: 0, lastReply: '—' };
    const sender = new SenderSlot();
    const service = new ChatService({
        config,
        store,
        llm,
        sender,
        prompts,
        faces,
        cooldowns,
        logger: logger.child('chat'),
        onActivity: (activity) => {
            if (activity.type === 'trigger') {
                stats.events += 1;
            } else if (activity.type === 'reply') {
                stats.lastReply = `群 ${activity.groupId} · ${((activity.elapsedMs ?? 0) / 1_000).toFixed(1)}s`;
            } else {
                stats.lastReply = `群 ${activity.groupId} · 失败`;
            }
        },
    });

    const bot = await startQQBot({
        onebot: settings.onebot,
        service,
        sender,
        logger: logger.child('qq'),
    });

    const startedAt = Date.now();
    const account = bot.nickname        ? `${bot.nickname}(${bot.selfId ?? '?'})`
        : bot.selfId !== undefined
          ? String(bot.selfId)
          : '未连接';

    const updateStatus = () => {
        tui?.setStatus({
            connected: bot.client.isConnected,
            account,
            model: config.value.llm.model,
            groups: store.groupCount,
            events: stats.events,
            lastReply: stats.lastReply,
            uptime: formatUptime(Date.now() - startedAt),
            logPath: logHandle ? path.basename(logHandle.path) : 'off',
        });
    };

    updateStatus();
    const statusTimer = setInterval(updateStatus, STATUS_INTERVAL_MS);
    statusTimer.unref();

    const sweepTimer = setInterval(() => {
        const removed = store.sweep();

        if (removed > 0) {
            logger.debug(`清理了 ${removed} 个空闲群的上下文`);
        }
    }, SWEEP_INTERVAL_MS);
    sweepTimer.unref();

    // GitHub 仓库监听：新 Release / 提交 → 发到指定群。
    const github = new GithubWatcher({
        config: settings.github,
        sender,
        logger: logger.child('github'),
        statePath: path.resolve(settings.github.stateFile),
        maxReplyChars: settings.bot.maxReplyChars,
    });
    github.start();

    let stopping = false;
    const shutdown = (reason: string) => {
        if (stopping) {
            return;
        }

        stopping = true;
        logger.info(`正在退出（${reason}）`);
        clearInterval(statusTimer);
        clearInterval(sweepTimer);
        github.stop();
        bot.stop();
        prompts.close();
        tui?.stop();
        logHandle?.stream.end();

        if (tui) {
            console.log(`已退出。日志：${logHandle ? logHandle.path : '未启用文件日志'}`);
        }

        // 留一点时间让 close 帧和日志落盘。
        setTimeout(() => process.exit(0), 200).unref();
    };

    stopEverything = shutdown;

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('unhandledRejection', (reason) => {
        logger.error('未处理的 Promise 拒绝', reason);
    });
    process.on('uncaughtException', (error) => {
        logger.error('未捕获的异常', error);
    });

    logger.info('机器人已就绪，等待群消息');
}

main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);

    console.error(`启动失败：${message}`);

    if (error instanceof Error && error.stack) {
        console.error(error.stack);
    }

    process.exitCode = 1;
});



