import { fromCQString } from '@snowluma/sdk';

export interface GroupMessageEventLike {
    post_type?: string;
    self_id: number;
    group_id: number;
    user_id: number;
    message_id: number;
    message: unknown;
    sender?: {
        user_id?: number;
        nickname?: string;
        card?: string;
    } | null;
}

export interface ParsedGroupMessage {
    groupId: number;
    userId: number;
    messageId: number;
    selfId: number;
    senderName: string;
    text: string;
    mentionedSelf: boolean;
    replyToId?: number;
}

/** 非文本消息在上下文里的占位描述，让模型知道「这里有张图」而不是看到空白。 */
const PLACEHOLDERS: Record<string, string> = {
    image: '[图片]',
    mface: '[表情]',
    face: '[表情]',
    record: '[语音]',
    video: '[视频]',
    file: '[文件]',
    json: '[卡片]',
    xml: '[卡片]',
    forward: '[聊天记录]',
    node: '[聊天记录]',
    poke: '[戳一戳]',
    share: '[链接]',
    music: '[音乐]',
    location: '[位置]',
    contact: '[名片]',
    markdown: '[富文本]',
    dice: '[骰子]',
    rps: '[猜拳]',
    shake: '[窗口抖动]',
};

interface RawSegment {
    type: string;
    data: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** SDK 的 fromCQString 返回 MessageChain（带 toSegments），这里统一成数组再解析。 */
function toSegmentArray(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value;
    }

    if (isRecord(value) && typeof value['toSegments'] === 'function') {
        try {
            const items = (value['toSegments'] as () => unknown)();

            if (Array.isArray(items)) {
                return items;
            }
        } catch {
            return [];
        }
    }

    return value;
}

function toSegmentList(message: unknown): RawSegment[] {
    let source: unknown = message;

    if (typeof source === 'string') {
        try {
            source = fromCQString(source);
        } catch {
            return [{ type: 'text', data: { text: message } }];
        }
    }

    source = toSegmentArray(source);

    if (!Array.isArray(source)) {
        return isRecord(source) && typeof source['type'] === 'string'
            ? [{ type: source['type'], data: isRecord(source['data']) ? source['data'] : {} }]
            : [];
    }

    const segments: RawSegment[] = [];

    for (const item of source) {
        if (!isRecord(item) || typeof item['type'] !== 'string') {
            continue;
        }

        segments.push({
            type: item['type'],
            data: isRecord(item['data']) ? item['data'] : {},
        });
    }

    return segments;
}

function readString(data: Record<string, unknown>, key: string): string {
    const value = data[key];

    if (typeof value === 'string') {
        return value;
    }

    if (typeof value === 'number') {
        return String(value);
    }

    return '';
}

/** 收敛换行与空白，避免把 QQ 里的排版噪音原样塞进提示词。 */
export function normalizeMessageText(text: string): string {
    return text
        .replace(/\r\n/g, '\n')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

export function senderDisplayName(event: {
    user_id: number;
    sender?: { nickname?: string; card?: string } | null;
}): string {
    const card = event.sender?.card?.trim();
    const nickname = event.sender?.nickname?.trim();

    return card && card.length > 0 ? card : nickname && nickname.length > 0 ? nickname : String(event.user_id);
}

export function parseGroupMessage(
    event: GroupMessageEventLike,
    selfId: number = event.self_id,
): ParsedGroupMessage {
    const segments = toSegmentList(event.message);
    let text = '';
    let mentionedSelf = false;
    let replyToId: number | undefined;

    for (const segment of segments) {
        if (segment.type === 'text') {
            text += readString(segment.data, 'text');
            continue;
        }

        if (segment.type === 'at') {
            const qq = readString(segment.data, 'qq');

            if (qq === String(selfId)) {
                mentionedSelf = true;
                continue;
            }

            const name = readString(segment.data, 'name');

            if (qq === 'all' || qq === '') {
                text += '@全体成员';
            } else {
                text += `@${name.length > 0 ? name : qq}`;
            }

            continue;
        }

        if (segment.type === 'reply') {
            const raw = readString(segment.data, 'id');
            const parsed = Number(raw);

            if (raw.length > 0 && Number.isFinite(parsed)) {
                replyToId = parsed;
            }

            continue;
        }

        text += PLACEHOLDERS[segment.type] ?? `[${segment.type}]`;
    }

    const parsedMessage: ParsedGroupMessage = {
        groupId: event.group_id,
        userId: event.user_id,
        messageId: event.message_id,
        selfId,
        senderName: senderDisplayName(event),
        text: normalizeMessageText(text),
        mentionedSelf,
    };

    if (replyToId !== undefined) {
        parsedMessage.replyToId = replyToId;
    }

    return parsedMessage;
}

/** 以「昵称: 内容」写入上下文；多人共用一份窗口时模型才知道谁在说话。 */
export function formatForHistory(message: ParsedGroupMessage, includeSpeakerName: boolean): string {
    if (!includeSpeakerName) {
        return message.text;
    }

    return `${message.senderName}: ${message.text}`;
}
