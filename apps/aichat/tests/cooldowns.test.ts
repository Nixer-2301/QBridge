import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CooldownStore } from '../src/chat/cooldowns.ts';
import { createLogger } from '../src/logger.ts';

const logger = createLogger('test', 'silent');
const dirs: string[] = [];

function tempFile(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-cooldown-'));

    dirs.push(dir);

    return path.join(dir, 'auto-replies.json');
}

afterEach(() => {
    while (dirs.length > 0) {
        const dir = dirs.pop();

        if (dir) {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    }
});

describe('CooldownStore', () => {
    it('记录后能读回，并算出剩余冷却时间', () => {
        const store = new CooldownStore(tempFile(), logger);

        store.set('0:628101497', 1_000);

        expect(store.get('0:628101497')).toBe(1_000);
        expect(store.remainingMs('0:628101497', 120_000, 61_000)).toBe(60_000);
        expect(store.remainingMs('0:628101497', 120_000, 121_000)).toBe(0);
    });

    it('重启（新实例）后冷却仍然生效', () => {
        const file = tempFile();

        new CooldownStore(file, logger).set('0:628101497', 1_000);

        const restarted = new CooldownStore(file, logger, 2_000);

        expect(restarted.remainingMs('0:628101497', 120_000, 2_000)).toBe(119_000);
    });

    it('超过 7 天的记录被忽略', () => {
        const file = tempFile();
        const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1_000;

        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify({ '0:1': eightDaysAgo }), 'utf8');

        const store = new CooldownStore(file, logger);

        expect(store.get('0:1')).toBeUndefined();
    });

    it('文件损坏时当作没有记录', () => {
        const file = tempFile();

        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, 'not json', 'utf8');

        const store = new CooldownStore(file, logger);

        expect(store.remainingMs('0:1', 120_000, Date.now())).toBe(0);
    });

    it('没有记录时剩余时间为 0', () => {
        const store = new CooldownStore(tempFile(), logger);

        expect(store.remainingMs('missing', 120_000, Date.now())).toBe(0);
    });
});
