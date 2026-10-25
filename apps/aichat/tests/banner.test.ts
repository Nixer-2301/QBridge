import { describe, expect, it } from 'vitest';
import { hueFor, renderFrame, showSplash, SPLASH_ART, toRgb } from '../src/banner.ts';

const ANSI = /\u001b\[/;

/** 去掉 ANSI 转义，只看文本内容。 */
function plain(text: string): string {
    return text.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '');
}

function createStream(isTTY: boolean, columns = 80) {
    const chunks: string[] = [];

    return {
        chunks,
        isTTY,
        columns,
        write(chunk: string) {
            chunks.push(chunk);
            return true;
        },
        get output() {
            return chunks.join('');
        },
    };
}

describe('启动横幅', () => {
    it('横幅内容是 6 行 slant 字', () => {
        expect(SPLASH_ART).toHaveLength(6);
        expect(SPLASH_ART.join('\n')).toContain('____');
        expect(SPLASH_ART.at(-1)?.trim()).toBe('/____/');
    });

    it('每个字符的色相落在 30° 到 70° 之间（橙 → 黄）', () => {
        for (let column = 0; column < 60; column += 1) {
            for (let row = 0; row < 6; row += 1) {
                const hue = hueFor(column, row, column + row);

                expect(hue).toBeGreaterThanOrEqual(30);
                expect(hue).toBeLessThanOrEqual(70);
            }
        }
    });

    it('彩色帧包含真彩色转义，纯文本帧不含', () => {
        expect(renderFrame(SPLASH_ART, 0, { color: true, width: 80 })).toMatch(ANSI);
        expect(renderFrame(SPLASH_ART, 0, { color: false, width: 80 })).not.toMatch(ANSI);
    });

    it('按终端宽度居中，且行数不变', () => {
        const narrow = renderFrame(SPLASH_ART, 0, { color: false, width: 56 }).split('\n');
        const wide = renderFrame(SPLASH_ART, 0, { color: false, width: 120 }).split('\n');

        expect(narrow).toHaveLength(SPLASH_ART.length);
        expect(wide).toHaveLength(SPLASH_ART.length);
        expect(wide[0]?.length).toBeGreaterThan(narrow[0]?.length ?? 0);
    });

    it('非 TTY 时只输出静态帧，不播放动画', async () => {
        const stream = createStream(false);

        await showSplash({ stream });

        expect(stream.output).not.toMatch(/\u001b\[\?25l/);
        expect(stream.output).not.toMatch(/\u001b\[H/);
        expect(plain(stream.output)).toContain('____');
    });

    it('TTY 下播放动画并清理光标状态', async () => {
        const stream = createStream(true, 80);

        // 显式开启颜色：测试环境可能设了 NO_COLOR。
        await showSplash({ stream, color: true, durationMs: 12, frameMs: 2 });

        expect(stream.output).toMatch(/\u001b\[\?25l/);
        expect(stream.output).toMatch(/\u001b\[\?25h/);
        expect(stream.chunks.length).toBeGreaterThan(3);
        expect(stream.output.trimEnd().endsWith('\u001b[0m')).toBe(true);
    });

    it('可以显式关闭动画', async () => {
        const stream = createStream(true, 80);

        await showSplash({ stream, animate: false, color: true });

        expect(stream.output).not.toMatch(/\u001b\[\?25l/);
        expect(plain(stream.output)).toContain('____');
    });

    it('NO_COLOR 环境下退化为纯文本横幅', async () => {
        const stream = createStream(true, 80);
        const previous = process.env['NO_COLOR'];

        process.env['NO_COLOR'] = '1';

        try {
            await showSplash({ stream, durationMs: 4, frameMs: 2 });

            expect(stream.output).not.toMatch(/\u001b\[\?25l/);
            expect(stream.output).not.toMatch(/38;2;/);
        } finally {
            if (previous === undefined) {
                delete process.env['NO_COLOR'];
            } else {
                process.env['NO_COLOR'] = previous;
            }
        }
    });
});


describe('横幅配色', () => {
    it('与 colorsys.hsv_to_rgb 一致：hue 50 是亮橙黄', () => {
        expect(toRgb(50, 0.85)).toEqual([217, 181, 0]);
        expect(toRgb(30, 0.85)).toEqual([217, 108, 0]);
        expect(toRgb(70, 0.85)).toEqual([181, 217, 0]);
    });

    it('整个色相区间都不会发蓝（蓝通道远低于红/绿）', () => {
        for (let hue = 30; hue <= 70; hue += 5) {
            const [r, g, b] = toRgb(hue, 0.9);

            expect(r).toBeGreaterThan(150);
            expect(g).toBeGreaterThan(80);
            expect(b).toBeLessThan(60);
        }
    });
});

