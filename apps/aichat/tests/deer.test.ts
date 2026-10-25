import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildDeerCardSvg, renderDeerCardPng, resolveFontPath } from '../src/deer/card.ts';
import { DeerStore } from '../src/deer/store.ts';
import { DeerTracker } from '../src/deer/tracker.ts';
import { createLogger } from '../src/logger.ts';
import type { GroupSender } from '../src/chat/service.ts';
import type { ParsedGroupMessage } from '../src/qq/segments.ts';

const logger = createLogger('test', 'silent');
const dirs: string[] = [];
const openStores: DeerStore[] = [];

function tempDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-deer-card-'));

    dirs.push(dir);

    return dir;
}

afterEach(() => {
    while (openStores.length > 0) {
        openStores.pop()?.close();
    }

    while (dirs.length > 0) {
        const dir = dirs.pop();

        if (dir) {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    }
});

function cardInput(overrides: Record<string, unknown> = {}) {
    return {
        name: 'Ww',
        now: new Date(2026, 9, 25, 23, 30),
        counts: new Map<number, number>([
            [24, 2],
            [25, 1],
        ]),
        weekCounts: [0, 0, 0, 0, 0, 2, 1],
        monthTotal: 3,
        todayCount: 1,
        ...overrides,
    };
}

describe('鹿管足迹卡片', () => {
    it('SVG 里有名字、月份和累计次数', () => {
        const svg = buildDeerCardSvg(cardInput());

        expect(svg).toContain('Ww 的本月鹿管足迹');
        expect(svg).toContain('2026年10月');
        expect(svg).toContain('本月累计 3 次');
        expect(svg).toContain('本周回顾');
        expect(svg).toContain('5次及以上');
    });

    it('特判字符会转义，避免坏掉 SVG', () => {
        const svg = buildDeerCardSvg(cardInput({ name: 'A<B>&"C"' }));

        expect(svg).toContain('A&lt;B&gt;&amp;&quot;C&quot;');
        expect(svg).not.toContain('A<B>');
    });

    it('渲染成合法 PNG', async () => {
        const png = await renderDeerCardPng(cardInput(), { fontPath: resolveFontPath(process.cwd()) });

        expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
        expect(png.length).toBeGreaterThan(10_000);

        const file = path.join(tempDir(), 'card.png');

        fs.writeFileSync(file, png);
        expect(fs.statSync(file).size).toBe(png.length);
    }, 20_000);
});

function message(overrides: Partial<ParsedGroupMessage> = {}): ParsedGroupMessage {
    return {
        groupId: 628101497,
        userId: 1609403959,
        messageId: -1,
        selfId: 3858972062,
        senderName: 'Ww',
        text: '🦌',
        mentionedSelf: false,
        images: [],
        faces: [],
        ...overrides,
    };
}

function harness(options: { cooldownMinutes?: number; enabled?: boolean; groupIds?: number[] } = {}) {
    const dir = tempDir();
    const store = new DeerStore(path.join(dir, 'deer.db'), logger);
    openStores.push(store);
    const sent: { groupId: number; message: unknown[] }[] = [];
    const sender: GroupSender = {
        async sendGroupMessage(groupId, msg) {
            sent.push({ groupId, message: msg });

            return { message_id: 1 };
        },
    };
    let clock = new Date(2026, 9, 25, 10, 0);
    const tracker = new DeerTracker({
        config: () => ({
            enabled: options.enabled ?? true,
            emoji: '🦌',
            cooldownMinutes: options.cooldownMinutes ?? 120,
            groupIds: options.groupIds ?? [],
        }),
        store,
        sender,
        logger,
        fontPath: resolveFontPath(process.cwd()),
        now: () => clock,
    });

    return {
        tracker,
        store,
        sent,
        advance(minutes: number) {
            clock = new Date(clock.getTime() + minutes * 60_000);
        },
        texts: () =>
            sent.map((item) =>
                (item.message[0] as { type: string; data: Record<string, unknown> }),
            ),
    };
}

describe('DeerTracker', () => {
    it('发 🦌 记录一次并回一张图片', async () => {
        const h = harness();

        expect(await h.tracker.handle(message())).toBe(true);

        expect(h.sent).toHaveLength(1);
        expect(h.texts()[0]?.type).toBe('image');
        expect(String(h.texts()[0]?.data['file'])).toMatch(/^base64:\/\//);
        expect(h.store.countOnDay(1609403959, '2026-10-25')).toBe(1);
    }, 20_000);

    it('120 分钟内再次发只提醒，不重复记录', async () => {
        const h = harness();

        await h.tracker.handle(message());
        h.advance(30);

        await h.tracker.handle(message({ messageId: -2 }));

        expect(h.store.countOnDay(1609403959, '2026-10-25')).toBe(1);
        expect(h.sent).toHaveLength(2);

        const second = h.texts()[1];

        expect(second?.type).toBe('text');
        expect(String(second?.data['text'])).toContain('注意身体哦，120分钟内只能记录一次');
        expect(String(second?.data['text'])).toContain('还剩 90 分钟');
    }, 20_000);

    it('超过冷却时间可以再记录', async () => {
        const h = harness();

        await h.tracker.handle(message());
        h.advance(121);

        await h.tracker.handle(message({ messageId: -3 }));

        expect(h.store.countOnDay(1609403959, '2026-10-25')).toBe(2);
        expect(h.texts()[1]?.type).toBe('image');
    }, 20_000);

    it('/deer 只看图不计数', async () => {
        const h = harness();

        expect(await h.tracker.handle(message({ text: '/deer' }))).toBe(true);

        expect(h.store.countOnDay(1609403959, '2026-10-25')).toBe(0);
        expect(h.texts()[0]?.type).toBe('image');
    }, 20_000);

    it('消息里没有 🦌 就不处理', async () => {
        const h = harness();

        expect(await h.tracker.handle(message({ text: '今天好累' }))).toBe(false);
        expect(h.sent).toHaveLength(0);
    });

    it('关闭 / 群不匹配时不处理', async () => {
        const disabled = harness({ enabled: false });

        expect(await disabled.tracker.handle(message())).toBe(false);

        const otherGroup = harness({ groupIds: [1] });

        expect(await otherGroup.tracker.handle(message())).toBe(false);
    });

    it('卡片标题用发送者昵称', async () => {
        const h = harness();

        await h.tracker.handle(message({ senderName: '小明' }));

        // 图片是 base64，这里直接验证记录里存了名字
        const rows = h.store.recent(1609403959, 1);

        expect(rows[0]?.name).toBe('小明');
    }, 20_000);
});
