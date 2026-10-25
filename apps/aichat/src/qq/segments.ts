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

export interface FaceInfo {
    /** 商城表情的文字摘要，例如「是钢卷」 */
    summary: string;
    /** 十六进制 emoji GUID，发送时必须 */
    emojiId: string;
    emojiPackageId: number;
    key: string;
    url: string;
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
    /** 消息里的图片源（http 链接 / base64 / 本地路径），供视觉模型使用。 */
    images: string[];
    /** 消息里的商城表情元数据，用于「原样回发同一个表情包」 */
    faces: FaceInfo[];
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
    const images: string[] = [];
    const faces: FaceInfo[] = [];

    for (const segment of segments) {
        if (segment.type === 'text') {
            text += readString(segment.data, 'text');
            continue;
        }

        if (segment.type === 'mface') {
            // 商城表情带文字摘要（例如「是钢卷」），比统一的 [表情] 更有信息量。
            const summary =
                readString(segment.data, 'summary').trim() ||
                readString(segment.data, 'text').trim() ||
                readString(segment.data, 'name').trim();

            text += summary.length > 0 ? `[表情:${summary}]` : '[表情]';
            continue;
        }

        if (segment.type === 'image') {
            // QBridge 把商城表情也作为 image 段发出，并带上 emoji_id/key：
            // 这类段要单独记下来，才能「原样回发同一个表情包」，也不要喂给视觉模型。
            const emojiId = readString(segment.data, 'emoji_id').trim();

            if (emojiId.length > 0) {
                const rawSummary = readString(segment.data, 'summary').trim();
                const face: FaceInfo = {
                    // QBridge 的 summary 是「[是钢卷]」这种带方括号的写法，去掉便于按名字配置
                    summary: rawSummary.replace(/^\[+|\]+$/g, '').trim() || '未命名表情',
                    emojiId,
                    emojiPackageId: Number(readString(segment.data, 'emoji_package_id') || '0') || 0,
                    key: readString(segment.data, 'key'),
                    url: readString(segment.data, 'url').trim(),
                };

                faces.push(face);
                text += `[表情:${face.summary}]`;
                continue;
            }

            const url = readString(segment.data, 'url').trim();
            const file = readString(segment.data, 'file').trim();
            const source = url.length > 0 ? url : file;

            if (source.length > 0) {
                images.push(source);
            }

            text += PLACEHOLDERS['image'] ?? '[图片]';
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
        images,
        faces,
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



