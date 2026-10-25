import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
    buildAutoReplySegments,
    cooldownKey,
    matchAutoReply,
    toImageSource,
} from '../src/chat/auto-reply.ts';
import { createLogger } from '../src/logger.ts';
import type { FaceInfo } from '../src/qq/segments.ts';
import type { AutoReplyRuleConfig } from '../src/types.ts';

const logger = createLogger('test', 'silent');
const dirs: string[] = [];

function tempDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-auto-'));

    dirs.push(dir);

    return dir;
}

afterEach(() => {
    while (dirs.length > 0) {
        const dir = dirs.pop();

        if (dir) {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    }
});

function rule(overrides: Partial<AutoReplyRuleConfig> = {}): AutoReplyRuleConfig {
    return {
        userIds: [1609403959],
        groupIds: [628101497],
        face: '是钢卷',
        cooldownSeconds: 60,
        probability: 1,
        ...overrides,
    };
}

const face: FaceInfo = {
    summary: '是钢卷',
    emojiId: 'abc123def456',
    emojiPackageId: 42,
    key: 'key-1',
    url: 'https://gxh.vip.qq.com/club/item/parcel/item/ab/abc123def456/raw300.gif',
};

describe('matchAutoReply', () => {
    it('用户名与群都匹配时命中', () => {
        const match = matchAutoReply([rule()], { userId: 1609403959, groupId: 628101497 }, new Map(), 1_000);

        expect(match?.index).toBe(0);
    });

    it('用户不匹配不触发', () => {
        expect(
            matchAutoReply([rule()], { userId: 1, groupId: 628101497 }, new Map(), 1_000),
        ).toBeNull();
    });

    it('群不匹配不触发（配置了 groupIds 时）', () => {
        expect(
            matchAutoReply([rule()], { userId: 1609403959, groupId: 1 }, new Map(), 1_000),
        ).toBeNull();
    });

    it('groupIds 为空表示所有群', () => {
        const match = matchAutoReply(
            [rule({ groupIds: [] })],
            { userId: 1609403959, groupId: 999 },
            new Map(),
            1_000,
        );

        expect(match).not.toBeNull();
    });

    it('冷却期内不重复触发', () => {
        const cooldowns = new Map<string, number>([[cooldownKey(0, 628101497), 1_000]]);

        expect(
            matchAutoReply([rule()], { userId: 1609403959, groupId: 628101497 }, cooldowns, 30_000),
        ).toBeNull();
        expect(
            matchAutoReply([rule()], { userId: 1609403959, groupId: 628101497 }, cooldowns, 62_000),
        ).not.toBeNull();
    });

    it('冷却按群隔离', () => {
        const cooldowns = new Map<string, number>([[cooldownKey(0, 628101497), 1_000]]);

        expect(
            matchAutoReply(
                [rule({ groupIds: [] })],
                { userId: 1609403959, groupId: 111 },
                cooldowns,
                2_000,
            ),
        ).not.toBeNull();
    });

    it('probability 为 0 时不触发，1 时必触发', () => {
        expect(
            matchAutoReply([rule({ probability: 0 })], { userId: 1609403959, groupId: 628101497 }, new Map(), 1),
        ).toBeNull();

        expect(
            matchAutoReply(
                [rule({ probability: 1 })],
                { userId: 1609403959, groupId: 628101497 },
                new Map(),
                1,
                () => 0.99,
            ),
        ).not.toBeNull();
    });

    it('按顺序返回第一条命中的规则', () => {
        const rules = [rule({ userIds: [1] }), rule({ face: '冲刺' })];
        const match = matchAutoReply(rules, { userId: 1609403959, groupId: 628101497 }, new Map(), 1);

        expect(match?.index).toBe(1);
        expect(match?.rule.face).toBe('冲刺');
    });
});

describe('buildAutoReplySegments', () => {
    it('学到表情时发真正的商城表情段', () => {
        const segments = buildAutoReplySegments(rule(), face, {
            maxImageBytes: 5_242_880,
            logger,
        });

        expect(segments).toHaveLength(1);
        expect(segments?.[0]).toMatchObject({
            type: 'image',
            data: {
                emoji_id: 'abc123def456',
                emoji_package_id: 42,
                key: 'key-1',
                summary: '是钢卷',
            },
        });
    });

    it('没学到表情但配了图片时退回图片', () => {
        const dir = tempDir();
        const file = path.join(dir, 'face.gif');

        fs.writeFileSync(file, Buffer.from('GIF89a', 'ascii'));

        const segments = buildAutoReplySegments(rule({ face: undefined, image: file }), undefined, {
            maxImageBytes: 5_242_880,
            logger,
        });

        expect(segments?.[0]).toMatchObject({ type: 'image' });
        expect(String((segments?.[0] as { data: { file: string } }).data.file)).toMatch(
            /^data:image\/gif;base64,/,
        );
    });

    it('都可以时只发文字', () => {
        const segments = buildAutoReplySegments(rule({ face: undefined, text: '嗨' }), undefined, {
            maxImageBytes: 1_024,
            logger,
        });

        expect(segments).toEqual([{ type: 'text', data: { text: '嗨' } }]);
    });

    it('都没配置或不合法时返回 null', () => {
        expect(
            buildAutoReplySegments(rule({ face: undefined }), undefined, {
                maxImageBytes: 1_024,
                logger,
            }),
        ).toBeNull();

        expect(
            buildAutoReplySegments(rule({ face: undefined, image: 'C:/not/exists.gif' }), undefined, {
                maxImageBytes: 1_024,
                logger,
            }),
        ).toBeNull();
    });
});

describe('toImageSource', () => {
    it('http 链接原样返回', () => {
        expect(toImageSource('https://example.com/a.gif', 1_024)).toBe('https://example.com/a.gif');
    });

    it('本地文件转 data URI', () => {
        const dir = tempDir();
        const file = path.join(dir, 'a.png');

        fs.writeFileSync(file, Buffer.from('89504e47', 'hex'));

        expect(toImageSource(file, 1_024)).toMatch(/^data:image\/png;base64,/);
    });

    it('超过体积上限返回 null', () => {
        const dir = tempDir();
        const file = path.join(dir, 'big.gif');

        fs.writeFileSync(file, Buffer.alloc(2_048, 1));

        expect(toImageSource(file, 1_024)).toBeNull();
    });
});
