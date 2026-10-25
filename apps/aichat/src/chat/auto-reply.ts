import fs from 'node:fs';
import path from 'node:path';
import type { AnyMessageSegment } from '@snowluma/sdk';
import type { Logger } from '../logger.ts';
import type { FaceInfo } from '../qq/segments.ts';
import type { AutoReplyRuleConfig } from '../types.ts';
import type { CooldownLookup } from './cooldowns.ts';

const MIME_BY_EXT: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.bmp': 'image/bmp',
};

export interface AutoReplyInput {
    userId: number;
    groupId: number;
}

export interface AutoReplyMatch {
    rule: AutoReplyRuleConfig;
    index: number;
}

export function cooldownKey(index: number, groupId: number): string {
    return `${index}:${groupId}`;
}

/**
 * 找出命中的「自动表情」规则：用户匹配 → 群匹配 → 冷却 → 概率。
 * 命中后由调用方发送，并写入冷却时间。
 */
export function matchAutoReply(
    rules: readonly AutoReplyRuleConfig[],
    input: AutoReplyInput,
    cooldowns: CooldownLookup,
    now: number,
    random: () => number = Math.random,
): AutoReplyMatch | null {
    for (const [index, rule] of rules.entries()) {
        if (!rule.userIds.includes(input.userId)) {
            continue;
        }

        if (rule.groupIds.length > 0 && !rule.groupIds.includes(input.groupId)) {
            continue;
        }

        const last = cooldowns.get(cooldownKey(index, input.groupId));

        if (last !== undefined && now - last < rule.cooldownSeconds * 1_000) {
            continue;
        }

        if (rule.probability < 1 && random() >= rule.probability) {
            continue;
        }

        return { rule, index };
    }

    return null;
}

/** 本地文件 / base64 / http 统一成 OneBot 能发的 image 源；本地文件转 base64:// 以支持跨机器。 */
export function toImageSource(source: string, maxBytes: number): string | null {
    const value = source.trim();

    if (value.length === 0) {
        return null;
    }

    if (/^(https?:\/\/|base64:\/\/|data:)/i.test(value)) {
        return value;
    }

    try {
        const stat = fs.statSync(value);

        if (!stat.isFile() || stat.size > maxBytes) {
            return null;
        }

        const mime = MIME_BY_EXT[path.extname(value).toLowerCase()] ?? 'image/gif';

        return `data:${mime};base64,${fs.readFileSync(value).toString('base64')}`;
    } catch {
        return null;
    }
}

export interface FaceLookup {
    get(summary: string): FaceInfo | undefined;
    list(): string[];
}

/**
 * 从表情池里随机挑一个「已经学到」的表情。
 * - `["*"]` 表示使用全部已学表情；
 * - 池子多于一个时避开上一次发过的，避免看起来像复读；
 * - 都没学到就返回 undefined，由调用方决定降级。
 */
export function pickFace(
    candidates: readonly string[],
    store: FaceLookup | undefined,
    lastUsed: string | undefined,
    random: () => number = Math.random,
): FaceInfo | undefined {
    if (!store || candidates.length === 0) {
        return undefined;
    }

    const names = candidates.includes('*') ? store.list() : candidates;
    const available = names
        .map((name) => store.get(name))
        .filter((face): face is FaceInfo => face !== undefined);

    if (available.length === 0) {
        return undefined;
    }

    const withoutLast =
        available.length > 1 && lastUsed !== undefined
            ? available.filter((face) => face.summary !== lastUsed)
            : available;
    const pool = withoutLast.length > 0 ? withoutLast : available;
    const index = Math.min(pool.length - 1, Math.max(0, Math.floor(random() * pool.length)));

    return pool[index];
}

/**
 * 组装一条自动回复：优先发商城表情（需要先学到 emoji_id），其次图片，最后文字。
 * 都不可用时返回 null，由调用方决定是否提示。
 */
export function buildAutoReplySegments(
    rule: AutoReplyRuleConfig,
    face: FaceInfo | undefined,
    options: { maxImageBytes: number; logger: Logger },
): AnyMessageSegment[] | null {
    if (face) {
        // QBridge 收到带 emoji_id 的 image 段会还原成真正的商城表情（见 element-codecs）。
        return [
            {
                type: 'image',
                data: {
                    emoji_id: face.emojiId,
                    emoji_package_id: face.emojiPackageId,
                    key: face.key,
                    summary: face.summary,
                },
            } as unknown as AnyMessageSegment,
        ];
    }

    const wanted = rule.faces ?? (rule.face ? [rule.face] : []);

    if (wanted.length > 0) {
        options.logger.warn(
            `表情池里还没有可用的表情（${wanted.join('、')}），先让它们被发一次，或配置 image 兜底`,
            '收到该表情后会自动缓存 emoji_id',
        );
    }

    if (rule.image) {
        const source = toImageSource(rule.image, options.maxImageBytes);

        if (source) {
            return [{ type: 'image', data: { file: source } } as unknown as AnyMessageSegment];
        }

        options.logger.warn(`自动回复图片不可用：${rule.image}`);
    }

    if (rule.text) {
        return [{ type: 'text', data: { text: rule.text } } as unknown as AnyMessageSegment];
    }

    return null;
}

