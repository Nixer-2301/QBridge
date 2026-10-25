const BREAK_CHARS = new Set(['。', '！', '？', '!', '?', '；', ';', '，', ',', '、', ' ', '\n']);
const SENTENCE_END = /(?<=[。！？!?…])\s*/u;

export interface SplitReplyOptions {
    /** 换行是否作为分段边界（真正的多段回复）。默认 true。 */
    splitParagraphs?: boolean;
    /** 一次回复最多拆成几条消息，超出的段落并回最后一条。默认 4。 */
    maxSegments?: number;
    /**
     * 整段回复没有任何换行时，超过这个字数就按句号切分。
     * 0 表示关闭。默认 80：既能让多句回复拆成几条，又不会把一句话切碎。
     */
    sentenceSplitAt?: number;
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
 * 整段没有换行时按句子切：把句子按字符预算装进若干个分组，避免一坨长句。
 * 只有一句时不切（切了也不自然）。
 */
function splitBySentences(text: string, targetGroups: number): string[] {
    const sentences = text
        .split(SENTENCE_END)
        .map((sentence) => sentence.trim())
        .filter((sentence) => sentence.length > 0);

    if (sentences.length <= 1) {
        return [text.trim()];
    }

    const groups = Math.max(2, Math.min(targetGroups, sentences.length));
    const budget = Math.ceil(text.length / groups);
    const result: string[] = [];
    let current = '';

    for (const sentence of sentences) {
        const candidate = current.length === 0 ? sentence : `${current}${sentence}`;

        if (current.length > 0 && candidate.length > budget && result.length < groups - 1) {
            result.push(current);
            current = sentence;
            continue;
        }

        current = candidate;
    }

    if (current.length > 0) {
        result.push(current);
    }

    return result;
}

/**
 * 把模型回复切成符合 QQ 单条消息长度限制的片段。
 *
 * - 换行（单换行或空行）默认都视为分段边界，每段单独发一条消息；
 * - 整段没有换行且超过 `sentenceSplitAt` 时，按句号切成 2~maxSegments 条；
 * - 段落数超过 `maxSegments` 时把后面的段落并进最后一条，避免刷屏；
 * - 最后仍按 `maxChars` 硬切，保证不超 QQ 单条上限。
 */
export function splitReply(text: string, maxChars: number, options: SplitReplyOptions = {}): string[] {
    const limit = Math.max(1, Math.floor(maxChars));
    const normalized = text.replace(/\r\n/g, '\n').trim();

    if (normalized.length === 0) {
        return [];
    }

    const maxSegments = Math.max(1, Math.floor(options.maxSegments ?? 4));
    const sentenceSplitAt = Math.max(0, Math.floor(options.sentenceSplitAt ?? 80));
    const blocks =
        options.splitParagraphs === false
            ? [normalized]
            : normalized
                  .split(/\n+/)
                  .map((block) => block.trim())
                  .filter((block) => block.length > 0);

    let segments: string[] = blocks.length > 0 ? blocks : [normalized];

    // 只有一整段、又比一句话长得多：按句号拆，模拟真人连发几条。
    if (segments.length === 1 && sentenceSplitAt > 0) {
        const single = segments[0] ?? '';

        if (single.length >= sentenceSplitAt && !single.includes('\n')) {
            const desired = Math.min(maxSegments, Math.max(2, Math.ceil(single.length / sentenceSplitAt)));

            segments = splitBySentences(single, desired);
        }
    }

    if (segments.length > maxSegments) {
        // 超出的段落并进最后一条，最后统一按长度硬切。
        const head = segments.slice(0, maxSegments - 1);
        const tail = segments.slice(maxSegments - 1).join('\n\n');

        segments = [...head, tail];
    }

    return segments.flatMap((segment) => splitBlock(segment, limit));
}
