import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Logger } from '../logger.ts';

export interface DayCount {
    /** 本地日期 YYYY-MM-DD */
    day: string;
    count: number;
}

/**
 * 🦌 记录库：用 Node 内置的 node:sqlite（无原生依赖，Linux 包可直接跑）。
 * 只存原始事件（谁、哪个群、什么时候），按天/月聚合在查询时做。
 */
export class DeerStore {
    private readonly db: DatabaseSync;

    constructor(
        filePath: string,
        private readonly logger: Logger,
    ) {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        this.db = new DatabaseSync(filePath);
        this.db.exec(`
            PRAGMA journal_mode = WAL;
            CREATE TABLE IF NOT EXISTS deer_records (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                group_id INTEGER NOT NULL,
                name TEXT NOT NULL,
                day TEXT NOT NULL,
                recorded_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_deer_user_time ON deer_records(user_id, recorded_at);
            CREATE INDEX IF NOT EXISTS idx_deer_user_day ON deer_records(user_id, day);
        `);
    }

    /** 该用户最近一次记录时间（毫秒），用于 120 分钟冷却。 */
    lastRecordedAt(userId: number): number | undefined {
        const row = this.db
            .prepare('SELECT MAX(recorded_at) AS last FROM deer_records WHERE user_id = ?')
            .get(userId) as { last: number | null } | undefined;

        return row?.last ?? undefined;
    }

    insert(input: {
        userId: number;
        groupId: number;
        name: string;
        day: string;
        at: number;
    }): void {
        this.db
            .prepare(
                'INSERT INTO deer_records (user_id, group_id, name, day, recorded_at) VALUES (?, ?, ?, ?, ?)',
            )
            .run(input.userId, input.groupId, input.name, input.day, input.at);
    }

    /** 某一天的次数。 */
    countOnDay(userId: number, day: string): number {
        const row = this.db
            .prepare('SELECT COUNT(*) AS n FROM deer_records WHERE user_id = ? AND day = ?')
            .get(userId, day) as { n: number } | undefined;

        return Number(row?.n ?? 0);
    }

    /** [fromDay, toDay] 闭区间内每天的次数。 */
    countsByDay(userId: number, fromDay: string, toDay: string): DayCount[] {
        const rows = this.db
            .prepare(
                'SELECT day, COUNT(*) AS n FROM deer_records WHERE user_id = ? AND day BETWEEN ? AND ? GROUP BY day ORDER BY day',
            )
            .all(userId, fromDay, toDay) as { day: string; n: number }[];

        return rows.map((row) => ({ day: row.day, count: Number(row.n) }));
    }

    /** [fromDay, toDay] 闭区间内的总次数。 */
    totalBetween(userId: number, fromDay: string, toDay: string): number {
        const row = this.db
            .prepare(
                'SELECT COUNT(*) AS n FROM deer_records WHERE user_id = ? AND day BETWEEN ? AND ?',
            )
            .get(userId, fromDay, toDay) as { n: number } | undefined;

        return Number(row?.n ?? 0);
    }

    /** 最近 N 条记录，用于卡片底部“最近记录”。 */
    recent(userId: number, limit = 3): { day: string; at: number; name: string }[] {
        return this.db
            .prepare(
                'SELECT day, recorded_at AS at, name FROM deer_records WHERE user_id = ? ORDER BY recorded_at DESC LIMIT ?',
            )
            .all(userId, Math.max(1, limit)) as { day: string; at: number; name: string }[];
    }

    close(): void {
        try {
            this.db.close();
        } catch (error) {
            this.logger.warn('关闭 🦌 数据库失败', error instanceof Error ? error.message : String(error));
        }
    }
}

/** 本地日期键（YYYY-MM-DD），避免依赖 SQLite 的本地时区设置。 */
export function dayKey(date: Date): string {
    const pad = (value: number) => String(value).padStart(2, '0');

    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
