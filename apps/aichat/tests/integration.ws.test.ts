import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import { ChatService, SenderSlot } from '../src/chat/service.ts';
import type { ChatModel } from '../src/chat/service.ts';
import { ConfigStore, parseConfig } from '../src/config.ts';
import { createLogger } from '../src/logger.ts';
import { ConversationStore } from '../src/memory/store.ts';
import { startQQBot } from '../src/qq/bot.ts';
import type { QQBotHandle } from '../src/qq/bot.ts';
import type { ChatMessage } from '../src/types.ts';

const logger = createLogger('integration', 'silent');
const SELF_ID = 3_000_000_001;
const GROUP_ID = 123_456;
const USER_ID = 9_876_543;
const ACCESS_TOKEN = 'test-token';

interface ReceivedAction {
    action: string;
    params: Record<string, unknown>;
    echo?: string;
}

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
    while (cleanups.length > 0) {
        const cleanup = cleanups.pop();

        await cleanup?.();
    }
});

function waitFor<T>(check: () => T | undefined, timeoutMs = 3_000): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const startedAt = Date.now();

        const tick = () => {
            const value = check();

            if (value !== undefined) {
                resolve(value);
                return;
            }

            if (Date.now() - startedAt > timeoutMs) {
                reject(new Error('等待条件超时'));
                return;
            }

            setTimeout(tick, 10);
        };

        tick();
    });
}

/** 一个最小的 OneBot 正向 WS 服务端，用来验证真实 WebSocket 链路。 */
async function startFakeOneBot(): Promise<{
    port: number;
    actions: ReceivedAction[];
    connectionUrls: string[];
    sockets: WebSocket[];
}> {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    const actions: ReceivedAction[] = [];
    const connectionUrls: string[] = [];
    const sockets: WebSocket[] = [];

    await new Promise<void>((resolve) => server.once('listening', () => resolve()));

    server.on('connection', (socket, request) => {
        sockets.push(socket);
        connectionUrls.push(request.url ?? '');

        socket.on('message', (raw) => {
            let payload: Record<string, unknown>;

            try {
                payload = JSON.parse(String(raw)) as Record<string, unknown>;
            } catch {
                return;
            }

            const action = String(payload['action'] ?? '');

            if (action.length > 0) {
                actions.push({
                    action,
                    params: (payload['params'] as Record<string, unknown>) ?? {},
                    ...(typeof payload['echo'] === 'string' ? { echo: payload['echo'] } : {}),
                });
            }

            const data =
                action === 'get_login_info'
                    ? { user_id: SELF_ID, nickname: '测试机器人' }
                    : { message_id: 1 };

            socket.send(
                JSON.stringify({
                    status: 'ok',
                    retcode: 0,
                    data,
                    ...(payload['echo'] !== undefined ? { echo: payload['echo'] } : {}),
                }),
            );
        });
    });

    cleanups.push(
        () =>
            new Promise<void>((resolve) => {
                for (const socket of sockets) {
                    socket.terminate();
                }

                server.close(() => resolve());
            }),
    );

    return {
        port: (server.address() as AddressInfo).port,
        actions,
        connectionUrls,
        sockets,
    };
}

function groupMessageEvent(text: string): Record<string, unknown> {
    return {
        post_type: 'message',
        message_type: 'group',
        sub_type: 'normal',
        time: Math.floor(Date.now() / 1_000),
        self_id: SELF_ID,
        group_id: GROUP_ID,
        user_id: USER_ID,
        message_id: -42,
        message: [
            { type: 'at', data: { qq: String(SELF_ID), name: '测试机器人' } },
            { type: 'text', data: { text } },
        ],
        raw_message: `[CQ:at,qq=${SELF_ID}] ${text}`,
        font: 0,
        sender: { user_id: USER_ID, nickname: '小明', card: '' },
    };
}

async function startBot(port: number): Promise<{
    bot: QQBotHandle;
    model: { calls: ChatMessage[][] };
    sender: SenderSlot;
    store: ConversationStore;
}> {
    const appConfig = parseConfig(
        {
            onebot: {
                url: `ws://127.0.0.1:${port}/`,
                accessToken: ACCESS_TOKEN,
                requestTimeoutMs: 5_000,
                reconnect: false,
            },
            bot: { name: '测试机器人', replyQuote: true, maxReplyChars: 1_200 },
            context: { maxMessages: 20 },
        },
        {},
    );
    const config = new ConfigStore('unused.json', appConfig);
    const store = new ConversationStore({
        maxMessages: 20,
        maxTokens: 20_000,
        maxCharsPerMessage: 2_000,
        maxGroups: 10,
        idleTtlMs: 60_000,
    });

    const calls: ChatMessage[][] = [];
    const model: ChatModel = {
        chat: async (messages) => {
            calls.push(messages);
            return { text: '你好呀，我是测试机器人', attempts: 1 };
        },
    };

    const sender = new SenderSlot();
    const service = new ChatService({
        config,
        store,
        llm: model,
        sender,
        prompts: { systemFor: () => '你是测试机器人。' },
        logger,
    });
    const bot = await startQQBot({ onebot: appConfig.onebot, service, sender, logger });

    cleanups.push(() => bot.stop());

    return { bot, model: { calls }, sender, store };
}

describe('WebSocket 链路', () => {
    it('连接时带上 accessToken，并能读取登录信息', async () => {
        const fake = await startFakeOneBot();
        const { bot } = await startBot(fake.port);

        expect(fake.connectionUrls[0]).toContain(`access_token=${ACCESS_TOKEN}`);
        expect(bot.selfId).toBe(SELF_ID);
        expect(fake.actions.some((item) => item.action === 'get_login_info')).toBe(true);
    });

    it('收到 @ 消息后调用模型并通过 send_group_msg 回复', async () => {
        const fake = await startFakeOneBot();
        await startBot(fake.port);

        const socket = await waitFor(() => fake.sockets[0]);

        socket.send(JSON.stringify(groupMessageEvent('在吗')));

        const sendAction = await waitFor(() =>
            fake.actions.find((item) => item.action === 'send_group_msg'),
        );

        expect(sendAction.params['group_id']).toBe(GROUP_ID);

        const message = sendAction.params['message'] as { type: string; data: Record<string, unknown> }[];

        expect(message[0]).toEqual({ type: 'reply', data: { id: '-42' } });
        expect(message.at(-1)).toEqual({ type: 'text', data: { text: '你好呀，我是测试机器人' } });
    });

    it('未被 @ 的消息不会触发请求与回复，但会进入上下文', async () => {
        const fake = await startFakeOneBot();
        const started = await startBot(fake.port);
        const socket = await waitFor(() => fake.sockets[0]);

        socket.send(
            JSON.stringify({
                ...groupMessageEvent('今天好热'),
                message_id: -43,
                message: [{ type: 'text', data: { text: '今天好热' } }],
            }),
        );
        socket.send(
            JSON.stringify({
                ...groupMessageEvent('有人吗'),
                message_id: -44,
                message: [{ type: 'text', data: { text: '有人吗' } }],
            }),
        );

        await waitFor(() => (started.store.messages(GROUP_ID).length >= 2 ? true : undefined));

        expect(started.model.calls).toHaveLength(0);
        expect(fake.actions.some((item) => item.action === 'send_group_msg')).toBe(false);
        expect(started.store.messages(GROUP_ID).map((item) => item.content)).toEqual([
            '小明: 今天好热',
            '小明: 有人吗',
        ]);
    });

    it('发送通道在连接后立即可用', async () => {
        const fake = await startFakeOneBot();
        const { sender } = await startBot(fake.port);

        await sender.sendGroupMessage(GROUP_ID, [{ type: 'text', data: { text: '主动消息' } }]);

        const sendAction = await waitFor(() =>
            fake.actions.find((item) => item.action === 'send_group_msg'),
        );

        expect(sendAction.params['message']).toEqual([{ type: 'text', data: { text: '主动消息' } }]);
    });
});


