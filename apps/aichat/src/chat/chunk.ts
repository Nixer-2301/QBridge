const BREAK_CHARS = new Set(['。', '！', '？', '!', '?', '；', ';', '，', ',', '、', ' ', '\n']);

export interface SplitReplyOptions {
    /** 空行分隔的段落是否拆成多条消息（真正的多段回复）。默认 true。 */
    splitParagraphs?: boolean;
    /** 一次回复最多拆成几条消息，超出的段落并回最后一条。默认 4。 */
    maxSegments?: number;
}

function hardSplit(text: string, limit: number): string[] {
    const parts: string[] = [];
    let rest = text;

    while (rest.length > limit) {
        const window = rest.slice(0, limit);
        let cut = -1;

        // 尽量在句读处断开，最少保留 60% 的长度，避免切出极短碎片。
        for (let index = window.length - 1; index >= Math.floor(limit * 0.6); index -= 1) {
            const char = window[index];

            if (char !== undefined && BREAK_CHARS.has(char)) {
                cut = index + 1;
                break;
            }
        }

        if (cut <= 0) {
            cut = limit;
        }

        parts.push(rest.slice(0, cut));
        rest = rest.slice(cut);
    }

    if (rest.length > 0) {
        parts.push(rest);
    }

    return parts;
}

/** 把一段文字按长度切分成若干条 QQ 消息，段内保留单换行。 */
function splitBlock(block: string, limit: number): string[] {
    const chunks: string[] = [];
    let current = '';

    const flush = () => {
        const trimmed = current.trim();

        if (trimmed.length > 0) {
            chunks.push(trimmed);
        }

        current = '';
    };

    for (const line of block.split('\n')) {
        if (line.trim().length === 0) {
            continue;
        }

        if (line.length > limit) {
            flush();

            for (const piece of hardSplit(line, limit)) {
                const trimmed = piece.trim();

                if (trimmed.length > 0) {
                    chunks.push(trimmed);
                }
            }

            continue;
        }

        const candidate = current.length === 0 ? line : `${current}\n${line}`;

        if (candidate.length <= limit) {
            current = candidate;
            continue;
        }

        flush();
        current = line;
    }

    flush();

    return chunks;
}

/**
 * 把模型回复切成符合 QQ 单条消息长度限制的片段。
 * 开启 `splitParagraphs` 时，空行分隔的段落各自成为一条消息（多段回复）；
 * 段落数超过 `maxSegments` 时把后面的段落并进最后一条，避免刷屏。
 */
export function splitReply(text: string, maxChars: number, options: SplitReplyOptions = {}): string[] {
    const limit = Math.max(1, Math.floor(maxChars));
    const normalized = text.replace(/\r\n/g, '\n').trim();

    if (normalized.length === 0) {
        return [];
    }

    const blocks =
        options.splitParagraphs === false
            ? [normalized]
            : normalized
                  .split(/\n\s*\n/)
                  .map((block) => block.trim())
                  .filter((block) => block.length > 0);

    if (blocks.length <= 1) {
        return splitBlock(normalized, limit);
    }

    const maxSegments = Math.max(1, Math.floor(options.maxSegments ?? 4));
    const segments: string[] = [];

    for (const block of blocks) {
        if (segments.length < maxSegments) {
            segments.push(block);
            continue;
        }

        // 超出段数上限：并进最后一段，最后统一按长度硬切。
        segments[segments.length - 1] = `${segments[segments.length - 1] ?? ''}\n\n${block}`;
    }

    return segments.flatMap((segment) => splitBlock(segment, limit));
}
