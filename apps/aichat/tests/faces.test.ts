import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FaceStore } from '../src/chat/faces.ts';
import { createLogger } from '../src/logger.ts';
import type { FaceInfo } from '../src/qq/segments.ts';

const logger = createLogger('test', 'silent');
const dirs: string[] = [];

function tempFile(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-faces-'));

    dirs.push(dir);

    return path.join(dir, 'faces.json');
}

function face(overrides: Partial<FaceInfo> = {}): FaceInfo {
    return {
        summary: '是钢卷',
        emojiId: 'abc123def456',
        emojiPackageId: 42,
        key: 'key-1',
        url: 'https://gxh.vip.qq.com/club/item/parcel/item/ab/abc123def456/raw300.gif',
        ...overrides,
    };
}

afterEach(() => {
    while (dirs.length > 0) {
        const dir = dirs.pop();

        if (dir) {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    }
});

describe('FaceStore', () => {
    it('记住表情并落盘，重启后还能读回来', () => {
        const file = tempFile();

        new FaceStore(file, logger).remember([face()]);

        const reopened = new FaceStore(file, logger);

        expect(reopened.size).toBe(1);
        expect(reopened.get('是钢卷')).toMatchObject({ emojiId: 'abc123def456', emojiPackageId: 42 });
    });

    it('同一个表情重复出现不重复写入', () => {
        const store = new FaceStore(tempFile(), logger);

        expect(store.remember([face()])).toBe(true);
        expect(store.remember([face()])).toBe(false);
        expect(store.size).toBe(1);
    });

    it('emoji_id 变化时更新缓存', () => {
        const store = new FaceStore(tempFile(), logger);

        store.remember([face()]);
        store.remember([face({ emojiId: 'ffffff000000', key: 'key-2' })]);

        expect(store.get('是钢卷')?.emojiId).toBe('ffffff000000');
    });

    it('忽略缺少 emoji_id 或名字的表情', () => {
        const store = new FaceStore(tempFile(), logger);
        store.remember([face({ emojiId: '' }), face({ summary: '' })]);

        expect(store.size).toBe(0);
    });

    it('超过上限淘汰最旧的表情', () => {
        const store = new FaceStore(tempFile(), logger);

        for (let index = 0; index < 210; index += 1) {
            store.remember([face({ summary: `表情${index}`, emojiId: `id${index}` })]);
        }

        expect(store.size).toBe(200);
        expect(store.get('表情0')).toBeUndefined();
        expect(store.get('表情209')).toBeDefined();
    });

    it('文件损坏时从空缓存开始，不抛错', () => {
        const file = tempFile();

        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, '{ not json', 'utf8');

        const store = new FaceStore(file, logger);

        expect(store.size).toBe(0);
        expect(() => store.remember([face()])).not.toThrow();
    });

    it('list 返回已学到的名字', () => {
        const store = new FaceStore(tempFile(), logger);
        store.remember([face(), face({ summary: '冲刺', emojiId: 'id2' })]);

        expect(store.list().sort()).toEqual(['冲刺', '是钢卷'].sort());
    });
});
