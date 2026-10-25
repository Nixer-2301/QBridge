/** 终端显示宽度计算：CJK/emoji 占 2 列，组合字符占 0 列。 */

const ZERO_WIDTH = [
    [0x0300, 0x036f],
    [0x0483, 0x0489],
    [0x200b, 0x200f],
    [0xfe00, 0xfe0f],
    [0xfe20, 0xfe2f],
] as const;

const WIDE = [
    [0x1100, 0x115f],
    [0x2e80, 0x303e],
    [0x3041, 0x33ff],
    [0x3400, 0x4dbf],
    [0x4e00, 0x9fff],
    [0xa000, 0xa4cf],
    [0xa960, 0xa97f],
    [0xac00, 0xd7a3],
    [0xf900, 0xfaff],
    [0xfe10, 0xfe19],
    [0xfe30, 0xfe6f],
    [0xff00, 0xff60],
    [0xffe0, 0xffe6],
    [0x1f300, 0x1f64f],
    [0x1f900, 0x1f9ff],
    [0x20000, 0x3fffd],
] as const;

function inRanges(codePoint: number, ranges: readonly (readonly [number, number])[]): boolean {
    for (const [start, end] of ranges) {
        if (codePoint >= start && codePoint <= end) {
            return true;
        }
    }

    return false;
}

export function charWidth(char: string): number {
    const codePoint = char.codePointAt(0);

    if (codePoint === undefined) {
        return 0;
    }

    if (inRanges(codePoint, ZERO_WIDTH)) {
        return 0;
    }

    return inRanges(codePoint, WIDE) ? 2 : 1;
}

export function displayWidth(text: string): number {
    let width = 0;

    for (const char of text) {
        width += charWidth(char);
    }

    return width;
}

/** 按显示宽度截断，超宽时补省略号。 */
export function truncateToWidth(text: string, width: number, ellipsis = '…'): string {
    if (width <= 0) {
        return '';
    }

    if (displayWidth(text) <= width) {
        return text;
    }

    const ellipsisWidth = displayWidth(ellipsis);
    const budget = Math.max(0, width - ellipsisWidth);
    let result = '';
    let used = 0;

    for (const char of text) {
        const charSize = charWidth(char);

        if (used + charSize > budget) {
            break;
        }

        result += char;
        used += charSize;
    }

    return result + ellipsis;
}

export function padToWidth(text: string, width: number): string {
    const padding = width - displayWidth(text);

    return padding > 0 ? text + ' '.repeat(padding) : text;
}

const ANSI_SEQUENCE = /\u001b\[[0-9;?]*[A-Za-z]/y;

/**
 * 按显示宽度截断带 ANSI 颜色的文本：转义序列原样保留且不计宽度，
 * 截断后补 RESET，避免颜色泄漏到后面的边框。
 */
export function truncateAnsiToWidth(text: string, width: number, ellipsis = '…'): string {
    if (width <= 0) {
        return '\u001b[0m';
    }

    let result = '';
    let used = 0;
    let index = 0;
    let truncated = false;

    while (index < text.length) {
        const char = text[index] ?? '';

        if (char === '\u001b') {
            ANSI_SEQUENCE.lastIndex = index;
            const match = ANSI_SEQUENCE.exec(text);

            if (match) {
                result += match[0];
                index += match[0].length;
                continue;
            }
        }

        const size = charWidth(char);

        if (used + size > width) {
            truncated = true;
            break;
        }

        result += char;
        used += size;
        index += 1;
    }

    if (!truncated) {
        return text;
    }

    const budget = Math.max(0, width - displayWidth(ellipsis));

    if (used > budget) {
        // 回退到省略号能放下的位置。
        let kept = '';
        let keptWidth = 0;
        let scan = 0;

        while (scan < result.length) {
            const char = result[scan] ?? '';

            if (char === '\u001b') {
                ANSI_SEQUENCE.lastIndex = scan;
                const match = ANSI_SEQUENCE.exec(result);

                if (match) {
                    kept += match[0];
                    scan += match[0].length;
                    continue;
                }
            }

            const size = charWidth(char);

            if (keptWidth + size > budget) {
                break;
            }

            kept += char;
            keptWidth += size;
            scan += 1;
        }

        result = kept;
    }

    return `${result}${ellipsis}\u001b[0m`;
}
