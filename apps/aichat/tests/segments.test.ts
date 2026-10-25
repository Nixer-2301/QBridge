import { describe, expect, it } from 'vitest';
import {
    formatForHistory,
    normalizeMessageText,
    parseGroupMessage,
    senderDisplayName,
} from '../src/qq/segments.ts';
import type { GroupMessageEventLike } from '../src/qq/segments.ts';

const SELF_ID = 3_000_000_001;

function event(overrides: Partial<GroupMessageEventLike> = {}): GroupMessageEventLike {
    return {
        post_type: 'message',
        self_id: SELF_ID,
        group_id: 123_456,
        user_id: 9_876_543,
        message_id: -42,
        message: [],
        sender: { user_id: 9_876_543, nickname: '小明', card: '' },
        ...overrides,
    };
}

describe('parseGroupMessage', () => {
    it('识别 @ 自己并保留正文', () => {
        const parsed = parseGroupMessage(
            event({
                message: [
                    { type: 'at', data: { qq: String(SELF_ID), name: '小助手' } },
                    { type: 'text', data: { text: ' 今天吃什么 ' } },
                ],
            }),
        );

        expect(parsed.mentionedSelf).toBe(true);
        expect(parsed.text).toBe('今天吃什么');
        expect(parsed.groupId).toBe(123_456);
        expect(parsed.userId).toBe(9_876_543);
        expect(parsed.senderName).toBe('小明');
    });

    it('@ 别人时保留昵称而不是当成自己', () => {
        const parsed = parseGroupMessage(
            event({
                message: [
                    { type: 'at', data: { qq: '10002', name: '张三' } },
                    { type: 'text', data: { text: ' 你好' } },
                ],
            }),
        );

        expect(parsed.mentionedSelf).toBe(false);
        expect(parsed.text).toBe('@张三 你好');
    });

    it('@全体成员 用文字表示', () => {
        const parsed = parseGroupMessage(
            event({ message: [{ type: 'at', data: { qq: 'all' } }, { type: 'text', data: { text: '开会了' } }] }),
        );

        expect(parsed.mentionedSelf).toBe(false);
        expect(parsed.text).toBe('@全体成员开会了');
    });

    it('非文本消息转成占位描述', () => {
        const parsed = parseGroupMessage(
            event({
                message: [
                    { type: 'image', data: { url: 'https://example.com/a.png' } },
                    { type: 'face', data: { id: '14' } },
                    { type: 'text', data: { text: '看这个' } },
                    { type: 'json', data: { data: '{}' } },
                ],
            }),
        );

        expect(parsed.text).toBe('[图片][表情]看这个[卡片]');
    });

    it('收集图片链接供视觉模型使用', () => {
        const parsed = parseGroupMessage(
            event({
                message: [
                    { type: 'image', data: { url: 'https://gchat.qpic.cn/1.png?rkey=x', file: 'abc.png' } },
                    { type: 'text', data: { text: '看这个' } },
                    { type: 'image', data: { file: 'def.png' } },
                ],
            }),
        );

        expect(parsed.images).toEqual(['https://gchat.qpic.cn/1.png?rkey=x', 'def.png']);
        expect(parsed.text).toBe('[图片]看这个[图片]');
    });

    it('没有图片时 images 为空数组', () => {
        const parsed = parseGroupMessage(event({ message: [{ type: 'text', data: { text: 'hi' } }] }));

        expect(parsed.images).toEqual([]);
    });

    it('商城表情带上文字摘要，普通表情仍是 [表情]', () => {
        const parsed = parseGroupMessage(
            event({
                message: [
                    { type: 'mface', data: { summary: '是钢卷', text: '是钢卷' } },
                    { type: 'face', data: { id: '14' } },
                ],
            }),
        );

        expect(parsed.text).toBe('[表情:是钢卷][表情]');
    });

    it('QBridge 把商城表情发成带 emoji_id 的 image 段时，记下元数据且不喂给视觉', () => {
        const parsed = parseGroupMessage(
            event({
                message: [
                    {
                        type: 'image',
                        data: {
                            file: 'ab-ab12cd34.gif',
                            url: 'https://gxh.vip.qq.com/club/item/parcel/item/ab/ab12cd34/raw300.gif',
                            summary: '是钢卷',
                            emoji_id: 'ab12cd34ef56',
                            emoji_package_id: 42,
                            key: 'k1',
                        },
                    },
                    { type: 'text', data: { text: ' 看这个' } },
                ],
            }),
        );

        expect(parsed.text).toBe('[表情:是钢卷] 看这个');
        expect(parsed.images).toEqual([]);
        expect(parsed.faces).toEqual([
            {
                summary: '是钢卷',
                emojiId: 'ab12cd34ef56',
                emojiPackageId: 42,
                key: 'k1',
                url: 'https://gxh.vip.qq.com/club/item/parcel/item/ab/ab12cd34/raw300.gif',
            },
        ]);
    });

    it('记录被引用消息的 id', () => {
        const parsed = parseGroupMessage(
            event({ message: [{ type: 'reply', data: { id: '-42' } }, { type: 'text', data: { text: '对' } }] }),
        );

        expect(parsed.replyToId).toBe(-42);
        expect(parsed.text).toBe('对');
    });

    it('兼容 CQ 字符串格式的消息', () => {
        const parsed = parseGroupMessage(
            event({ message: `[CQ:at,qq=${SELF_ID}] 在吗` }),
        );

        expect(parsed.mentionedSelf).toBe(true);
        expect(parsed.text).toBe('在吗');
    });

    it('空消息不会抛错', () => {
        expect(parseGroupMessage(event({ message: [] })).text).toBe('');
        expect(parseGroupMessage(event({ message: null })).text).toBe('');
        expect(parseGroupMessage(event({ message: 42 })).text).toBe('');
    });

    it('忽略结构异常的消息段', () => {
        const parsed = parseGroupMessage(
            event({ message: [{ type: 'text', data: { text: 'ok' } }, 'junk', { noType: true }, null] }),
        );

        expect(parsed.text).toBe('ok');
    });
});

describe('normalizeMessageText', () => {
    it('去掉多余空行与行尾空白', () => {
        expect(normalizeMessageText('第一行   \n\n\n\n第二行  ')).toBe('第一行\n\n第二行');
    });
});

describe('senderDisplayName', () => {
    it('优先用群名片', () => {
        expect(senderDisplayName({ user_id: 1, sender: { nickname: '昵称', card: '群名片' } })).toBe('群名片');
    });

    it('没有名片时用昵称', () => {
        expect(senderDisplayName({ user_id: 1, sender: { nickname: '昵称' } })).toBe('昵称');
    });

    it('都没有时退回 QQ 号', () => {
        expect(senderDisplayName({ user_id: 12345, sender: null })).toBe('12345');
    });
});

describe('formatForHistory', () => {
    const parsed = parseGroupMessage(
        event({ message: [{ type: 'text', data: { text: '晚上好' } }] }),
    );

    it('默认带发言人名字', () => {
        expect(formatForHistory(parsed, true)).toBe('小明: 晚上好');
    });

    it('可以关闭发言人名字', () => {
        expect(formatForHistory(parsed, false)).toBe('晚上好');
    });
});
