import fs from 'node:fs';
import path from 'node:path';
import type { Logger } from '../logger.ts';
import type { FaceInfo } from '../qq/segments.ts';

const MAX_FACES = 200;

/** 去掉「[是钢卷]」这类方括号，统一成可配置的名字。 */
function normalizeName(summary: string): string {
    return summary.replace(/^\[+|\]+$/g, '').trim();
}

/**
 * 商城表情的「学习缓存」：收到别人发表情包时把 emoji_id/key 等元数据记下来，
 * 之后就能原样发回去（QQ 只认 emoji_id，光有名字发不出去）。
 */
export class FaceStore {
    private readonly faces = new Map<string, FaceInfo>();

    constructor(
        readonly filePath: string,
        private readonly logger: Logger,
    ) {
        this.load();
    }

    get size(): number {
        return this.faces.size;
    }

    get(summary: string): FaceInfo | undefined {
        return this.faces.get(normalizeName(summary));
    }

    list(): string[] {
        return [...this.faces.keys()];
    }

    /** 记录新学到的表情；有变化才落盘。 */
    remember(incoming: readonly FaceInfo[]): boolean {
        let changed = false;

        for (const incomingFace of incoming) {
            const face: FaceInfo = { ...incomingFace, summary: normalizeName(incomingFace.summary) };

            if (!face.emojiId || !face.summary) {
                continue;
            }

            const existing = this.faces.get(face.summary);

            if (
                existing &&
                existing.emojiId === face.emojiId &&
                existing.key === face.key &&
                existing.emojiPackageId === face.emojiPackageId
            ) {
                continue;
            }

            // 重新插入以维持「最近见过」的顺序，超出上限时淘汰最旧的。
            this.faces.delete(face.summary);
            this.faces.set(face.summary, face);
            changed = true;
        }

        while (this.faces.size > MAX_FACES) {
            const oldest = this.faces.keys().next();

            if (oldest.done) {
                break;
            }

            this.faces.delete(oldest.value);
        }

        if (changed) {
            this.save();
        }

        return changed;
    }

    private load(): void {
        try {
            const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as unknown;

            if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
                return;
            }

            for (const [summary, value] of Object.entries(raw as Record<string, unknown>)) {
                if (!value || typeof value !== 'object') {
                    continue;
                }

                const record = value as Record<string, unknown>;

                if (typeof record['emojiId'] !== 'string' || record['emojiId'].length === 0) {
                    continue;
                }

                this.faces.set(normalizeName(summary), {
                    summary: normalizeName(summary),
                    emojiId: record['emojiId'],
                    emojiPackageId:
                        typeof record['emojiPackageId'] === 'number' ? record['emojiPackageId'] : 0,
                    key: typeof record['key'] === 'string' ? record['key'] : '',
                    url: typeof record['url'] === 'string' ? record['url'] : '',
                });
            }
        } catch {
            // 文件不存在或损坏：从空缓存开始，后续收到表情会重新学。
        }
    }

    private save(): void {
        try {
            fs.mkdirSync(path.dirname(this.filePath), { recursive: true });

            const snapshot: Record<string, FaceInfo> = {};

            for (const [summary, face] of this.faces) {
                snapshot[summary] = face;
            }

            const tmp = `${this.filePath}.tmp`;

            fs.writeFileSync(tmp, `${JSON.stringify(snapshot, null, 4)}\n`, 'utf8');
            fs.renameSync(tmp, this.filePath);
        } catch (error) {
            this.logger.warn(
                '表情缓存写入失败',
                error instanceof Error ? error.message : String(error),
            );
        }
    }
}

