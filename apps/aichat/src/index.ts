import path from 'node:path';
import { showSplash } from './banner.ts';
import { ChatService, SenderSlot } from './chat/service.ts';
import { ConfigStore, resolveConfigPath } from './config.ts';
import { loadEnvFile } from './env.ts';
import { createLogSink, openLogFile } from './log-sink.ts';
import { createLogger } from './logger.ts';
import { LlmClient } from './llm/client.ts';
import { ConversationStore } from './memory/store.ts';
import { startQQBot } from './qq/bot.ts';

const SWEEP_INTERVAL_MS = 5 * 60 * 1_000;

function maskSecret(secret: string): string {
    if (secret.length === 0) {
        return '未设置（若模型服务需要鉴权会返回 401）';
    }

    return secret.length <= 6 ? '***' : `${secret.slice(0, 3)}***${secret.slice(-2)}`;
}

async function main(): Promise<void> {
    const argv = process.argv.slice(2);
    const envLoaded = loadEnvFile(path.resolve('.env'));

    if (envLoaded.length > 0) {
        console.log(`已从 .env 读取 ${envLoaded.length} 个环境变量：${envLoaded.join(', ')}`);
    }

    const configPath = resolveConfigPath(argv);
    const config = ConfigStore.load(configPath);

    // 日志文件：默认 logs/ 下按时间戳命名；QB_LOG_FILE=off 关闭。
    const logSetting = (process.env['QB_LOG_FILE'] ?? 'logs').trim();
    const logHandle =
        logSetting.toLowerCase() === 'off'
            ? undefined
            : openLogFile(path.resolve(logSetting.length > 0 ? logSetting : 'logs'));
    const logger = createLogger(
        'aichat',
        () => config.value.logging.level,
        createLogSink(console, logHandle?.stream),
    );

    if (argv.includes('--no-splash') || process.env['QB_NO_SPLASH'] === '1') {
        logger.debug('已跳过启动动画');
    } else {
        await showSplash();
    }

    const settings = config.value;

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

    const sender = new SenderSlot();
    const service = new ChatService({
        config,
        store,
        llm,
        sender,
        logger: logger.child('chat'),
    });

    const bot = await startQQBot({
        onebot: settings.onebot,
        service,
        sender,
        logger: logger.child('qq'),
    });

    const sweepTimer = setInterval(() => {
        const removed = store.sweep();

        if (removed > 0) {
            logger.debug(`清理了 ${removed} 个空闲群的上下文`);
        }
    }, SWEEP_INTERVAL_MS);
    sweepTimer.unref();

    let stopping = false;
    const shutdown = (signal: string) => {
        if (stopping) {
            return;
        }

        stopping = true;
        logger.info(`收到 ${signal}，正在退出`);
        clearInterval(sweepTimer);
        bot.stop();
        logHandle?.stream.end();
        // 留一点时间让 close 帧和日志落盘。
        setTimeout(() => process.exit(0), 200).unref();
    };

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
