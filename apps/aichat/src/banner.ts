/**
 * 启动横幅：block 大字「Q Bridge」+ 橙黄波浪动画。
 * 只做装饰，不影响日志输出；`QB_NO_SPLASH=1` 或 `--no-splash` 可关闭。
 *
 * 字形来自 `banner-art.ts`（pyfiglet ansi_shadow 逐字预生成），
 * 这里只负责「按窗口宽度拼字 + 上色 + 动画帧」。
 */
import { SPLASH_GLYPHS } from './banner-art.ts';

function isBlankGlyph(glyph: readonly string[]): boolean {
    return glyph.every((line) => line.trim().length === 0);
}

/**
 * 按字间距把逐字字形拼成整行：高度固定（6 行），宽度随字间距变化。
 * 词间距比字间距略大一点（+4），这样 Q 和 BRIDGE 看起来是一句话而不是两个词。
 */
export function composeSplash(gap: number): string[] {
    const height = Math.max(...SPLASH_GLYPHS.map((glyph) => glyph.length));
    const spacing = Math.max(0, Math.floor(gap));
    const letterGap = ' '.repeat(spacing);
    const wordGap = ' '.repeat(spacing + 4);
    const words: string[][][] = [[]];

    for (const glyph of SPLASH_GLYPHS) {
        if (isBlankGlyph(glyph)) {
            words.push([]);
            continue;
        }

        words[words.length - 1]?.push(glyph);
    }

    const nonEmpty = words.filter((word) => word.length > 0);

    return Array.from({ length: height }, (_unused, row) =>
        nonEmpty
            .map((word) => word.map((glyph) => glyph[row] ?? '').join(letterGap))
            .join(wordGap)
            .replace(/[ \t]+$/, ''),
    );
}

function linesWidth(lines: readonly string[]): number {
    return lines.reduce((widest, line) => Math.max(widest, line.length), 0);
}

/** 在给定终端宽度内尽可能把横幅拉宽（字间距自适应，行数不变）。 */
export function fitSplash(cols: number): string[] {
    const budget = Math.max(40, Math.floor(cols) - 2);

    // 上限 8：再宽字就会散开，字号感反而变差。
    for (let gap = 8; gap >= 0; gap -= 1) {
        const lines = composeSplash(gap);

        if (linesWidth(lines) <= budget) {
            return lines;
        }
    }

    return composeSplash(0);
}

/** 默认（80 列）下的横幅，供测试与纯文本模式使用。 */
export const SPLASH_ART: readonly string[] = composeSplash(2);

const RESET = '\u001b[0m';
const HIDE_CURSOR = '\u001b[?25l';
const SHOW_CURSOR = '\u001b[?25h';
const CLEAR = '\u001b[H\u001b[2J';

export interface SplashOptions {
    stream?: Pick<NodeJS.WriteStream, 'write'> & { isTTY?: boolean; columns?: number };
    /** 是否播放动画；默认只在 TTY 下播放。 */
    animate?: boolean;
    durationMs?: number;
    frameMs?: number;
    width?: number;
    color?: boolean;
}

/** 原脚本的色彩公式：色相 30°–70°（橙 → 亮黄），明度 0.7–1.0。 */
export function hueFor(column: number, row: number, offset: number): number {
    return 50 + Math.sin(column * 0.15 + row * 0.3 - offset * 0.12) * 20;
}

function valueFor(column: number, row: number, offset: number): number {
    return 0.85 + Math.sin(column * 0.15 + row * 0.3 - offset * 0.12) * 0.15;
}

/**
 * HSV(hue, 1, value) → RGB，和 Python `colorsys.hsv_to_rgb(hue/360, 1, val)` 等价。
 * 标准公式：f(n) = v - v * max(0, min(k, 4 - k, 1))，k = (n + H/60) mod 6，
 * R=f(5), G=f(3), B=f(1)。
 */
export function toRgb(hue: number, value: number): [number, number, number] {
    const h = ((((hue % 360) + 360) % 360) / 60) % 6;
    const channel = (n: number): number => {
        const k = (n + h) % 6;

        return value - value * Math.max(0, Math.min(k, 4 - k, 1));
    };

    return [Math.round(channel(5) * 255), Math.round(channel(3) * 255), Math.round(channel(1) * 255)];
}

/** 渲染一帧；空格不上色，超宽时按终端宽度居中。 */
export function renderFrame(
    art: readonly string[],
    offset: number,
    options: { color: boolean; width: number } = { color: true, width: 80 },
): string {
    const artWidth = art.reduce((widest, line) => Math.max(widest, line.length), 0);
    const pad = ' '.repeat(Math.max(0, Math.floor((options.width - artWidth) / 2)));

    return art
        .map((line, row) => {
            if (!options.color) {
                return `${pad}${line}`;
            }

            let colored = pad;

            for (let column = 0; column < line.length; column += 1) {
                const char = line[column] ?? '';

                if (char === ' ') {
                    colored += char;
                    continue;
                }

                const [r, g, b] = toRgb(hueFor(column, row, offset), valueFor(column, row, offset));

                colored += `\u001b[38;2;${r};${g};${b}m${char}`;
            }

            return `${colored}${RESET}`;
        })
        .join('\n');
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** 返回一帧彩色字符画（不做居中），供纯文本模式使用。 */
export function artFrame(offset: number, options: { color?: boolean } = {}): string[] {
    const width = linesWidth(SPLASH_ART);

    return renderFrame(SPLASH_ART, offset, {
        color: options.color ?? true,
        width,
    }).split('\n');
}

/**
 * 播放启动动画并保留最后一帧；非 TTY / 关闭颜色时只打印静态横幅。
 * 结束后只在横幅下方继续输出日志，不会持续清屏。
 */
export async function showSplash(options: SplashOptions = {}): Promise<void> {
    const stream = options.stream ?? process.stdout;
    const isTty = stream.isTTY === true;
    const colorEnabled =
        options.color ??
        (isTty && process.env['NO_COLOR'] === undefined && process.env['TERM'] !== 'dumb');
    const width = options.width ?? (isTty ? (stream.columns ?? 80) : 80);
    const animate = (options.animate ?? true) && isTty && colorEnabled;
    const durationMs = options.durationMs ?? 1_600;
    const frameMs = options.frameMs ?? 40;
    const art = fitSplash(width);

    if (!animate) {
        stream.write(`${renderFrame(art, 0, { color: colorEnabled, width })}\n\n`);

        return;
    }

    const frames = Math.max(1, Math.round(durationMs / frameMs));

    stream.write(HIDE_CURSOR);

    try {
        for (let frame = 0; frame < frames; frame += 1) {
            stream.write(`${CLEAR}${renderFrame(art, frame, { color: true, width })}\n`);
            await sleep(frameMs);
        }
    } finally {
        stream.write(SHOW_CURSOR);
    }

    stream.write(`${CLEAR}${renderFrame(art, frames, { color: true, width })}\n\n`);
}

