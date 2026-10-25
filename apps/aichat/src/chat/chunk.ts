const BREAK_CHARS = new Set(['。', '！', '？', '!', '?', '；', ';', '，', ',', '、', ' ', '\n']);

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

/**
 * 把模型回复切成符合 QQ 单条消息长度限制的片段。
 * 优先按空行/换行切，再按句读切，最后才硬切。
 */
export function splitReply(text: string, maxChars: number): string[] {
    const limit = Math.max(1, Math.floor(maxChars));
    const normalized = text.replace(/\r\n/g, '\n').trim();

    if (normalized.length === 0) {
        return [];
    }

    if (normalized.length <= limit) {
        return [normalized];
    }

    const chunks: string[] = [];
    let current = '';

    const flush = () => {
        const trimmed = current.trim();

        if (trimmed.length > 0) {
            chunks.push(trimmed);
        }

        current = '';
    };

    for (const paragraph of normalized.split(/\n/)) {
        const line = paragraph.trimEnd();

        if (line.trim().length === 0) {
            flush();
            continue;
        }

        if (line.length > limit) {
            flush();

            for (const piece of hardSplit(line, limit)) {
                const trimmed = piece.trim();

                if (trimmed.length === 0) {
                    continue;
                }

                if (trimmed.length >= limit) {
                    chunks.push(trimmed);
                    continue;
                }

                current = trimmed;
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
