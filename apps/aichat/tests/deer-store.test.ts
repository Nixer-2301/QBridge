import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { dayKey, DeerStore } from '../src/deer/store.ts';
import { createLogger } from '../src/logger.ts';

const logger = createLogger('test', 'silent');
const dirs: string[] = [];

function tempDb(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-deer-'));

    dirs.push(dir);

    return path.join(dir, 'deer.db');
}

afterEach(() => {
    while (dirs.length > 0) {
        const dir = dirs.pop();

        if (dir) {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    }
});

function at(year: number, month: number, day: number, hour = 12): number {
    return new Date(year, month - 1, day, hour).getTime();
}

describe('dayKey', () => {
    it('按本地时间生成 YYYY-MM-DD', () => {
        expect(dayKey(new Date(2026, 9, 5, 23, 59))).toBe('2026-10-05');
    });
});

describe('DeerStore', () => {
    it('插入后能按天统计与取最近时间', () => {
        const store = new DeerStore(tempDb(), logger);

        store.insert({ userId: 1, groupId: 10, name: 'Ww', day: '2026-10-24', at: at(2026, 10, 24) });
        store.insert({ userId: 1, groupId: 10, name: 'Ww', day: '2026-10-24', at: at(2026, 10, 24, 20) });
        store.insert({ userId: 1, groupId: 10, name: 'Ww', day: '2026-10-25', at: at(2026, 10, 25) });

        expect(store.countOnDay(1, '2026-10-24')).toBe(2);
        expect(store.countOnDay(1, '2026-10-25')).toBe(1);
        expect(store.countOnDay(1, '2026-10-26')).toBe(0);
        expect(store.lastRecordedAt(1)).toBe(at(2026, 10, 25));

        store.close();
    });

    it('按区间聚合（工作日历用）', () => {
        const store = new DeerStore(tempDb(), logger);

        store.insert({ userId: 1, groupId: 10, name: 'Ww', day: '2026-10-01', at: at(2026, 10, 1) });
        store.insert({ userId: 1, groupId: 10, name: 'Ww', day: '2026-10-03', at: at(2026, 10, 3) });
        store.insert({ userId: 1, groupId: 10, name: 'Ww', day: '2026-10-03', at: at(2026, 10, 3, 15) });
        store.insert({ userId: 1, groupId: 10, name: 'Ww', day: '2026-11-01', at: at(2026, 11, 1) });

        expect(store.countsByDay(1, '2026-10-01', '2026-10-31')).toEqual([
            { day: '2026-10-01', count: 1 },
            { day: '2026-10-03', count: 2 },
        ]);
        expect(store.totalBetween(1, '2026-10-01', '2026-10-31')).toBe(3);

        store.close();
    });

    it('不同用户互不影响', () => {
        const store = new DeerStore(tempDb(), logger);

        store.insert({ userId: 1, groupId: 10, name: 'A', day: '2026-10-25', at: at(2026, 10, 25) });
        store.insert({ userId: 2, groupId: 10, name: 'B', day: '2026-10-25', at: at(2026, 10, 25) });

        expect(store.countOnDay(1, '2026-10-25')).toBe(1);
        expect(store.countOnDay(2, '2026-10-25')).toBe(1);
        expect(store.lastRecordedAt(3)).toBeUndefined();

        store.close();
    });

    it('重开数据库后数据还在', () => {
        const file = tempDb();
        const first = new DeerStore(file, logger);

        first.insert({ userId: 1, groupId: 10, name: 'Ww', day: '2026-10-25', at: at(2026, 10, 25) });
        first.close();

        const second = new DeerStore(file, logger);

        expect(second.countOnDay(1, '2026-10-25')).toBe(1);
        second.close();
    });

    it('recent 返回最近的记录', () => {
        const store = new DeerStore(tempDb(), logger);

        store.insert({ userId: 1, groupId: 10, name: 'Ww', day: '2026-10-24', at: at(2026, 10, 24) });
        store.insert({ userId: 1, groupId: 10, name: 'Ww', day: '2026-10-25', at: at(2026, 10, 25) });

        const rows = store.recent(1, 1);

        expect(rows).toHaveLength(1);
        expect(rows[0]?.day).toBe('2026-10-25');

        store.close();
    });
});
