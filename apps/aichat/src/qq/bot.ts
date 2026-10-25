import { SnowLumaWebSocketClient } from '@snowluma/sdk';
import type { AnyMessageSegment } from '@snowluma/sdk';
import type { ChatService, SenderSlot } from '../chat/service.ts';
import type { Logger } from '../logger.ts';
import type { OneBotConfig } from '../types.ts';

export interface QQBotHandle {
    client: SnowLumaWebSocketClient;
    selfId: number | undefined;
    stop(): void;
}

function maskSecret(secret: string | undefined): string {    if (!secret || secret.length === 0) {
        return '未设置';
    }

    if (secret.length <= 6) {
        return '***';
    }

    return `${secret.slice(0, 3)}***${secret.slice(-2)}`;
}

/** 底层 WebSocket 抛出的错误常常没有 message，这里补一句人话。 */
function describeSocketError(error: unknown): string {
    if (error instanceof Error) {
        const message = error.message.trim();

        return message.length > 0
            ? `${error.name}: ${message}`
            : `${error.name}（连接异常中断，SDK 会按 reconnect 配置重连）`;
    }

    return String(error);
}

/**
 * 把 QBridge 的 OneBot 正向 WebSocket 接成「收群消息 → 交给 ChatService → 发群消息」。
 * 这里只做连接与收发，任何回复逻辑都在 ChatService 里。
 */
export async function startQQBot(options: {
    onebot: OneBotConfig;
    service: ChatService;
    sender: SenderSlot;
    logger: Logger;
}): Promise<QQBotHandle> {
    const { onebot, service, sender, logger } = options;

    const client = new SnowLumaWebSocketClient({
        url: onebot.url,
        ...(onebot.accessToken ? { accessToken: onebot.accessToken } : {}),
        requestTimeoutMs: onebot.requestTimeoutMs,
        reconnect: onebot.reconnect ? { minDelayMs: 1_000, maxDelayMs: 30_000 } : false,
    });

    sender.attach({
        sendGroupMessage(groupId: number, message: AnyMessageSegment[]) {
            return client.sendGroupMessage(groupId, message);
        },
    });

    client.onGroupMessage(async (event) => {
        await service.onGroupMessage(event);
    });

    client.onBotStatus((event) => {
        logger.info(`账号状态变化：${event.sub_type}`, `uin=${event.user_id}`);
    });

    // 主动关闭时底层 socket 会再抛一次错误，这里只在非关闭阶段记录，避免退出时刷无意义的报错。
    let closing = false;
    let connected = false;

    client.on('error', (error: unknown) => {
        // 连接建立之前的错误由 connect() 的拒绝统一报告，这里不重复刷屏。
        if (closing || !connected) {
            return;
        }

        logger.error('WebSocket 客户端错误', describeSocketError(error));
    });

    client.on('close', (info) => {
        if (closing) {
            return;
        }

        connected = false;
        logger.warn(
            `与 QBridge 的连接断开${info.code !== undefined ? `（code=${info.code}）` : ''}`,
            onebot.reconnect ? 'SDK 会自动重连' : 'onebot.reconnect 为 false，不会自动重连',
        );
    });

    logger.info(`正在连接 QBridge OneBot 服务 ${onebot.url}`, `token=${maskSecret(onebot.accessToken)}`);

    try {
        await client.connect();
    } catch (error) {
        if (!onebot.reconnect) {
            throw error;
        }

        // QBridge 可能比机器人后启动：SDK 已经在按退避重连，这里等它连上即可。
        logger.warn(
            '首次连接 QBridge 失败，等待自动重连；如果一直失败，请检查 QBridge 是否运行、端口与 accessToken 是否正确',
            error instanceof Error ? error.message : String(error),
        );

        await new Promise<void>((resolve) => {
            client.on('open', () => {
                resolve();
            });
        });
    }

    connected = true;

    let selfId: number | undefined;

    try {
        const login = await client.getLoginInfo();
        selfId = login.user_id;
        logger.info(`已连接 QQ 账号 ${login.nickname}(${login.user_id})`);
    } catch (error) {
        logger.warn(
            '已连接 OneBot 服务，但读取账号信息失败；如果收发消息异常，请检查 accessToken 与 QBridge 中该账号的 OneBot 配置',
            error,
        );
    }

    return {
        client,
        selfId,
        stop() {
            closing = true;
            client.close(1_000, 'shutdown');
            logger.info('已断开 OneBot 连接');
        },
    };
}
