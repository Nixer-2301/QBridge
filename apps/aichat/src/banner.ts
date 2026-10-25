/**
 * 启动横幅：把 z.py 里的「Q Bridge」slant 字 + 橙黄波浪动画移植到 Node。
 * 只做装饰，不影响日志输出；`QB_NO_SPLASH=1` 或 `--no-splash` 可关闭。
 */
import { SPLASH_ART_LINES } from './banner-art.ts';

export const SPLASH_ART: readonly string[] = SPLASH_ART_LINES;

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
 * R=f(5), G=f(3), B=f(1)。之前写成 H/30 且没夹住 k，导致蓝色通道恒为 255、整块发蓝。
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

/** 返回一帧彩色字符画（不做居中），供 TUI 的固定头部直接使用。 */
export function artFrame(offset: number, options: { color?: boolean } = {}): string[] {
    const width = SPLASH_ART.reduce((widest, line) => Math.max(widest, line.length), 0);

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

    if (!animate) {
        stream.write(`${renderFrame(SPLASH_ART, 0, { color: colorEnabled, width })}\n\n`);

        return;
    }

    const frames = Math.max(1, Math.round(durationMs / frameMs));

    stream.write(HIDE_CURSOR);

    try {
        for (let frame = 0; frame < frames; frame += 1) {
            stream.write(`${CLEAR}${renderFrame(SPLASH_ART, frame, { color: true, width })}\n`);
            await sleep(frameMs);
        }
    } finally {
        stream.write(SHOW_CURSOR);
    }

    stream.write(`${CLEAR}${renderFrame(SPLASH_ART, frames, { color: true, width })}\n\n`);
}

