import fs from 'node:fs';
import path from 'node:path';
import type { Logger } from '../logger.ts';

export interface CooldownLookup {
    get(key: string): number | undefined;
    set(key: string, value: number): void;
}

const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000;

/**
 * 冷却时间持久化：避免重启后「刚发过」的记录丢失，导致两分钟内重复发消息。
 * 键一般是「规则索引:群号」，值是上次发送的毫秒时间戳。
 */
export class CooldownStore implements CooldownLookup {
    private readonly entries = new Map<string, number>();

    constructor(
        readonly filePath: string,
        private readonly logger: Logger,
        now: number = Date.now(),
    ) {
        this.load(now);
    }

    get(key: string): number | undefined {
        return this.entries.get(key);
    }

    set(key: string, value: number): void {
        this.entries.set(key, value);
        this.save();
    }

    /** 距离下次可发还剩多少毫秒；0 表示现在就能发。 */
    remainingMs(key: string, cooldownMs: number, now: number): number {
        const last = this.entries.get(key);

        if (last === undefined) {
            return 0;
        }

        return Math.max(0, last + cooldownMs - now);
    }

    private load(now: number): void {
        try {
            const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as unknown;

            if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
                return;
            }

            for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
                if (typeof value === 'number' && Number.isFinite(value) && now - value < MAX_AGE_MS) {
                    this.entries.set(key, value);
                }
            }
        } catch {
            // 文件不存在或损坏：当作没有冷却记录。
        }
    }

    private save(): void {
        try {
            fs.mkdirSync(path.dirname(this.filePath), { recursive: true });

            const snapshot: Record<string, number> = {};

            for (const [key, value] of this.entries) {
                snapshot[key] = value;
            }

            const tmp = `${this.filePath}.tmp`;

            fs.writeFileSync(tmp, `${JSON.stringify(snapshot, null, 4)}\n`, 'utf8');
            fs.renameSync(tmp, this.filePath);
        } catch (error) {
            this.logger.warn(
                '冷却记录写入失败',
                error instanceof Error ? error.message : String(error),
            );
        }
    }
}
