import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ChatService, SenderSlot } from '../src/chat/service.ts';
import type { ChatModel, GroupSender } from '../src/chat/service.ts';
import { ConfigStore, parseConfig } from '../src/config.ts';
import { createLogger } from '../src/logger.ts';
import { ConversationStore } from '../src/memory/store.ts';
import type { GroupMessageEventLike } from '../src/qq/segments.ts';
import type { AppConfig, ChatMessage } from '../src/types.ts';

const logger = createLogger('test', 'silent');
const SELF_ID = 3_000_000_001;
const GROUP_ID = 123_456;
const USER_ID = 9_876_543;

interface Harness {
    service: ChatService;
    store: ConversationStore;
    model: { calls: ChatMessage[][]; chat: ChatModel['chat'] };
    sender: { sent: { groupId: number; message: unknown[] }[]; sendGroupMessage: GroupSender['sendGroupMessage'] };
    config: ConfigStore;
}

function createHarness(
    overrides: Record<string, unknown> = {},
    options: {
        reply?: string | ((messages: ChatMessage[]) => string);
        failWith?: Error;
        filePath?: string;
        systemFor?: (groupId: number) => string;
        reloadPrompts?: () => void;
    } = {},
): Harness {
    const appConfig: AppConfig = parseConfig(overrides, {});
    const config = new ConfigStore(options.filePath ?? path.resolve('config/config.json'), appConfig);
    const store = new ConversationStore({
        maxMessages: appConfig.context.maxMessages,
        maxTokens: appConfig.context.maxTokens,
        maxCharsPerMessage: appConfig.context.maxCharsPerMessage,
        maxGroups: appConfig.context.maxGroups,
        idleTtlMs: appConfig.context.idleTtlMinutes * 60_000,
    });

    const calls: ChatMessage[][] = [];
    const model: Harness['model'] = {
        calls,
        chat: async (messages) => {
            calls.push(messages);

            if (options.failWith) {
                throw options.failWith;
            }

            const reply =
                typeof options.reply === 'function'
                    ? options.reply(messages)
                    : (options.reply ?? '默认回复');

            return { text: reply, attempts: 1 };
        },
    };

    const sent: { groupId: number; message: unknown[] }[] = [];
    const sender: Harness['sender'] = {
        sent,
        sendGroupMessage: async (groupId, message) => {
            sent.push({ groupId, message });
            return {};
        },
    };

    const service = new ChatService({
        config,
        store,
        llm: model,
        sender,
        prompts: {
            systemFor: options.systemFor ?? (() => '你是测试助手。'),
            reload: options.reloadPrompts,
        },
        logger,
        sleep: async () => {},
    });

    return { service, store, model, sender, config };
}

function event(overrides: Partial<GroupMessageEventLike> = {}): GroupMessageEventLike {
    return {
        post_type: 'message',
        self_id: SELF_ID,
        group_id: GROUP_ID,
        user_id: USER_ID,
        message_id: -10,
        message: [{ type: 'text', data: { text: '普通消息' } }],
        sender: { user_id: USER_ID, nickname: '小明', card: '' },
        ...overrides,
    };
}

function atSelf(
    text: string,
    messageId = -10,
    userId = USER_ID,
    groupId = GROUP_ID,
): GroupMessageEventLike {
    return event({
        message_id: messageId,
        user_id: userId,
        group_id: groupId,
        message: [
            { type: 'at', data: { qq: String(SELF_ID), name: '小助手' } },
            { type: 'text', data: { text } },
        ],
    });
}

function textsOf(message: unknown[]): string[] {
    return message
        .filter((segment): segment is { type: string; data: { text: string } } => {
            return (
                typeof segment === 'object' &&
                segment !== null &&
                (segment as { type?: string }).type === 'text'
            );
        })
        .map((segment) => segment.data.text);
}

describe('ChatService 触发规则', () => {
    it('@ 机器人时调用模型并回复', async () => {
        const harness = createHarness({}, { reply: '在的' });

        await harness.service.onGroupMessage(atSelf(' 在吗 '));

        expect(harness.model.calls).toHaveLength(1);

        const prompt = harness.model.calls[0] ?? [];

        expect(prompt[0]?.role).toBe('system');
        expect(prompt.at(-1)).toEqual({ role: 'user', content: '小明: 在吗' });

        expect(harness.sender.sent).toHaveLength(1);
        expect(harness.sender.sent[0]?.groupId).toBe(GROUP_ID);

        const segments = harness.sender.sent[0]?.message ?? [];

        expect(segments[0]).toEqual({ type: 'reply', data: { id: '-10' } });
        expect(segments.at(-1)).toEqual({ type: 'text', data: { text: '在的' } });
    });

    it('未 @ 的消息只记录上下文，不回复', async () => {
        const harness = createHarness();

        await harness.service.onGroupMessage(event({ message: [{ type: 'text', data: { text: '今天好热' } }] }));

        expect(harness.model.calls).toHaveLength(0);
        expect(harness.sender.sent).toHaveLength(0);
        expect(harness.store.messages(GROUP_ID)[0]?.content).toBe('小明: 今天好热');
    });

    it('关闭 recordAllGroupMessages 后，未触发的消息不进上下文', async () => {
        const harness = createHarness({ bot: { recordAllGroupMessages: false } });

        await harness.service.onGroupMessage(event({ message: [{ type: 'text', data: { text: '闲聊' } }] }));

        expect(harness.store.messages(GROUP_ID)).toEqual([]);
    });

    it('requireAt=false 时所有群消息都会回复', async () => {
        const harness = createHarness({ bot: { trigger: { requireAt: false } } });

        await harness.service.onGroupMessage(event({ message: [{ type: 'text', data: { text: '嗯' } }] }));

        expect(harness.model.calls).toHaveLength(1);
    });

    it('配置唤醒词后不带 @ 也能触发', async () => {
        const harness = createHarness({ bot: { trigger: { wakeWords: ['小助手'] } } });

        await harness.service.onGroupMessage(event({ message: [{ type: 'text', data: { text: '小助手 讲个笑话' } }] }));

        expect(harness.model.calls).toHaveLength(1);
    });

    it('只 @ 不写字也能触发', async () => {
        const harness = createHarness({}, { reply: '怎么了？' });

        await harness.service.onGroupMessage(
            event({ message: [{ type: 'at', data: { qq: String(SELF_ID) } }] }),
        );

        expect(harness.model.calls).toHaveLength(1);
        expect(harness.model.calls[0]?.at(-1)?.content).toContain('没有附带文字');
    });
});

describe('ChatService 过滤', () => {
    it('忽略自己发出的消息', async () => {
        const harness = createHarness();

        await harness.service.onGroupMessage(atSelf('自问自答', -11, SELF_ID));

        expect(harness.model.calls).toHaveLength(0);
    });

    it('忽略 message_sent 回显', async () => {
        const harness = createHarness();

        await harness.service.onGroupMessage({ ...atSelf('回显'), post_type: 'message_sent' });

        expect(harness.model.calls).toHaveLength(0);
    });

    it('黑名单群不处理', async () => {
        const harness = createHarness({ bot: { groups: { blacklist: [GROUP_ID] } } });

        await harness.service.onGroupMessage(atSelf('在吗'));

        expect(harness.model.calls).toHaveLength(0);
        expect(harness.store.messages(GROUP_ID)).toEqual([]);
    });

    it('白名单只处理列出的群', async () => {
        const harness = createHarness({ bot: { groups: { whitelist: [999] } } });

        await harness.service.onGroupMessage(atSelf('在吗'));

        expect(harness.model.calls).toHaveLength(0);
    });

    it('同一条消息重复投递只回复一次', async () => {
        const harness = createHarness();

        await harness.service.onGroupMessage(atSelf('在吗', -20));
        await harness.service.onGroupMessage(atSelf('在吗', -20));

        expect(harness.model.calls).toHaveLength(1);
    });

    it('不同群里相同的 message_id 互不影响', async () => {
        const harness = createHarness();

        await harness.service.onGroupMessage(atSelf('A群消息', -20, USER_ID, 111));
        await harness.service.onGroupMessage(atSelf('B群消息', -20, USER_ID, 222));

        expect(harness.model.calls).toHaveLength(2);
        expect(harness.sender.sent.map((item) => item.groupId)).toEqual([111, 222]);
    });
});

describe('ChatService 上下文', () => {
    it('多轮对话带上历史，并滚动保留最近若干条', async () => {
        const harness = createHarness({ context: { maxMessages: 4 } });

        await harness.service.onGroupMessage(atSelf('第一问', -1));
        await harness.service.onGroupMessage(event({ message_id: -2, message: [{ type: 'text', data: { text: '插一句' } }] }));
        await harness.service.onGroupMessage(atSelf('第二问', -3));

        const lastPrompt = harness.model.calls.at(-1) ?? [];
        const contents = lastPrompt.map((item) => item.content);

        expect(contents.some((content) => content.includes('第一问'))).toBe(true);
        expect(contents.some((content) => content.includes('默认回复'))).toBe(true);
        expect(contents.some((content) => content.includes('插一句'))).toBe(true);
    });

    it('上下文按群隔离', async () => {
        const harness = createHarness();

        await harness.service.onGroupMessage(atSelf('A群问题', -1, USER_ID, 111));
        await harness.service.onGroupMessage(atSelf('B群问题', -2, USER_ID, 222));

        const lastPrompt = harness.model.calls.at(-1) ?? [];

        expect(lastPrompt.some((item) => item.content.includes('A群问题'))).toBe(false);
        expect(lastPrompt.some((item) => item.content.includes('B群问题'))).toBe(true);
    });

    it('超过 token 预算时丢弃最旧的历史', async () => {
        const harness = createHarness({ context: { maxTokens: 200, maxMessages: 20 } });

        for (let index = 0; index < 8; index += 1) {
            harness.store.appendUser(GROUP_ID, `历史消息${index}：${'很长的内容'.repeat(10)}`);
            harness.store.appendAssistant(GROUP_ID, `历史回复${index}`);
        }

        await harness.service.onGroupMessage(atSelf('现在的问题', -99));

        const prompt = harness.model.calls[0] ?? [];

        expect(prompt.at(-1)?.content).toContain('现在的问题');
        expect(prompt.some((item) => item.content.includes('历史消息0'))).toBe(false);
        expect(prompt.length).toBeLessThan(17);
    });

    it('系统提示词来自提示词文件，并替换 {botName}/{groupId} 占位符', async () => {
        const harness = createHarness(
            { bot: { name: '阿桥' } },
            { systemFor: (groupId) => `本群 ${groupId} 只聊游戏，你是{botName}` },
        );

        await harness.service.onGroupMessage(atSelf('开黑吗'));

        expect(harness.model.calls[0]?.[0]?.content).toBe(`本群 ${GROUP_ID} 只聊游戏，你是阿桥`);
    });

    it('可以关闭发言人名字前缀', async () => {
        const harness = createHarness({ context: { includeSpeakerName: false } });

        await harness.service.onGroupMessage(atSelf('你好'));

        expect(harness.model.calls[0]?.at(-1)).toEqual({ role: 'user', content: '你好' });
    });
});

describe('ChatService 发送', () => {
    it('长回复按 maxReplyChars 切分，只有首片带引用', async () => {
        const longReply = '这是很长的一段回复。'.repeat(20);
        const harness = createHarness({ bot: { maxReplyChars: 50 } }, { reply: longReply });

        await harness.service.onGroupMessage(atSelf('说长点', -30));

        expect(harness.sender.sent.length).toBeGreaterThan(3);

        for (const item of harness.sender.sent) {
            const text = textsOf(item.message).join('');

            expect(text.length).toBeLessThanOrEqual(50);
        }

        expect(harness.sender.sent[0]?.message[0]).toEqual({ type: 'reply', data: { id: '-30' } });
        expect(harness.sender.sent[1]?.message[0]).toMatchObject({ type: 'text' });

        const joined = harness.sender.sent.flatMap((item) => textsOf(item.message)).join('');

        expect(joined).toHaveLength(longReply.length);
    });

    it('atSender 开启时回复里带上 @', async () => {
        const harness = createHarness({ bot: { atSender: true } });

        await harness.service.onGroupMessage(atSelf('在吗'));

        const segments = harness.sender.sent[0]?.message ?? [];

        expect(segments[0]).toEqual({ type: 'reply', data: { id: '-10' } });
        expect(segments[1]).toEqual({ type: 'at', data: { qq: String(USER_ID) } });
    });

    it('模型失败时不发送，并记录日志', async () => {
        const harness = createHarness({}, { failWith: new Error('模型炸了') });

        await harness.service.onGroupMessage(atSelf('在吗'));

        expect(harness.sender.sent).toHaveLength(0);
        expect(harness.store.messages(GROUP_ID)).toHaveLength(1);
    });

    it('notifyOnError 开启时向群里提示失败', async () => {
        const harness = createHarness({ bot: { notifyOnError: true } }, { failWith: new Error('模型炸了') });

        await harness.service.onGroupMessage(atSelf('在吗'));

        expect(harness.sender.sent).toHaveLength(1);
        expect(textsOf(harness.sender.sent[0]?.message ?? [])[0]).toContain('走神');
    });

    it('模型回复为空时不发送', async () => {
        const harness = createHarness({}, { reply: '   ' });

        await harness.service.onGroupMessage(atSelf('在吗'));

        expect(harness.sender.sent).toHaveLength(0);
    });
});

describe('ChatService 管理命令', () => {
    it('管理员 /reset 清空本群上下文', async () => {
        const harness = createHarness({ bot: { owners: [USER_ID] } });

        await harness.service.onGroupMessage(atSelf('先聊两句', -1));
        await harness.service.onGroupMessage(atSelf('/reset', -2));

        expect(harness.store.messages(GROUP_ID)).toEqual([]);
        expect(textsOf(harness.sender.sent.at(-1)?.message ?? [])[0]).toContain('已清空');
    });

    it('非管理员 /reset 被拒绝且不清空上下文', async () => {
        const harness = createHarness({ bot: { owners: [111] } });

        await harness.service.onGroupMessage(atSelf('记住这句话', -1));
        await harness.service.onGroupMessage(atSelf('/reset', -2));

        // 上下文 = 触发消息 + 上一次回复，没有被 /reset 清掉。
        expect(harness.store.messages(GROUP_ID)).toHaveLength(2);
        expect(textsOf(harness.sender.sent.at(-1)?.message ?? [])[0]).toContain('管理员');
    });

    it('/help 返回命令列表', async () => {
        const harness = createHarness();

        await harness.service.onGroupMessage(atSelf('/help'));

        expect(textsOf(harness.sender.sent[0]?.message ?? [])[0]).toContain('/reset');
        expect(harness.model.calls).toHaveLength(0);
    });

    it('管理员 /reload 重新读取配置文件', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-aichat-'));
        const configPath = path.join(dir, 'config.json');
        const write = (name: string) => {
            fs.writeFileSync(configPath, JSON.stringify({ bot: { name, owners: [USER_ID] } }), 'utf8');
        };

        write('旧名字');

        const config = ConfigStore.load(configPath);
        const harness = createHarness({}, { filePath: configPath });
        // 用真实 ConfigStore 覆盖，保证 /reload 读取的是临时文件。
        const service = new ChatService({
            config,
            store: harness.store,
            llm: harness.model,
            prompts: { systemFor: () => '你是测试助手。' },
            sender: harness.sender,
            logger,
        });

        write('新名字');
        await service.onGroupMessage(atSelf('/reload', -5));

        expect(config.value.bot.name).toBe('新名字');
        expect(textsOf(harness.sender.sent.at(-1)?.message ?? [])[0]).toContain('已重新加载');

        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('管理员 /reload 同时重新加载提示词', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-aichat-'));
        const configPath = path.join(dir, 'config.json');

        fs.writeFileSync(configPath, JSON.stringify({ bot: { owners: [USER_ID] } }), 'utf8');

        const config = ConfigStore.load(configPath);
        const harness = createHarness({}, { filePath: configPath });
        let reloaded = 0;
        const service = new ChatService({
            config,
            store: harness.store,
            llm: harness.model,
            sender: harness.sender,
            prompts: {
                systemFor: () => '你是测试助手。',
                reload: () => {
                    reloaded += 1;
                },
            },
            logger,
        });

        await service.onGroupMessage(atSelf('/reload', -7));

        expect(reloaded).toBe(1);
        expect(textsOf(harness.sender.sent.at(-1)?.message ?? [])[0]).toContain('提示词已重新加载');

        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('配置损坏时 /reload 报错且不崩溃', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-aichat-'));
        const configPath = path.join(dir, 'config.json');

        fs.writeFileSync(configPath, JSON.stringify({ bot: { owners: [USER_ID] } }), 'utf8');

        const config = ConfigStore.load(configPath);
        const harness = createHarness({}, { filePath: configPath });
        const service = new ChatService({
            config,
            store: harness.store,
            llm: harness.model,
            prompts: { systemFor: () => '你是测试助手。' },
            sender: harness.sender,
            logger,
        });

        fs.writeFileSync(configPath, '{ invalid json', 'utf8');
        await service.onGroupMessage(atSelf('/reload', -6));

        expect(textsOf(harness.sender.sent.at(-1)?.message ?? [])[0]).toContain('重新加载失败');

        fs.rmSync(dir, { recursive: true, force: true });
    });
});

describe('ChatService 并发', () => {
    it('同群消息串行处理，不会打乱顺序', async () => {
        const order: string[] = [];
        const harness = createHarness({}, {
            reply: (messages) => {
                const last = messages.at(-1)?.content ?? '';
                order.push(last);
                return `回复:${last}`;
            },
        });

        await Promise.all([
            harness.service.onGroupMessage(atSelf('第一条', -1)),
            harness.service.onGroupMessage(atSelf('第二条', -2)),
        ]);

        expect(order).toHaveLength(2);
        expect(order[0]).toContain('第一条');
        expect(order[1]).toContain('第二条');
    });
});

describe('SenderSlot', () => {
    it('未注入发送实现时抛出可观测错误而不是静默丢弃', async () => {
        const slot = new SenderSlot();

        await expect(
            slot.sendGroupMessage(GROUP_ID, [{ type: 'text', data: { text: 'hi' } }]),
        ).rejects.toThrow(/尚未就绪/);
    });

    it('注入后转发给真实发送实现', async () => {
        const slot = new SenderSlot();
        const send = vi.fn(async () => ({}));

        slot.attach({ sendGroupMessage: send });
        await slot.sendGroupMessage(GROUP_ID, [{ type: 'text', data: { text: 'hi' } }]);

        expect(send).toHaveBeenCalledWith(GROUP_ID, [{ type: 'text', data: { text: 'hi' } }]);
    });
});


