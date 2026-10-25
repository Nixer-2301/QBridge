import { describe, expect, it } from 'vitest';
import { LogBuffer } from '../src/tui/log-buffer.ts';

describe('LogBuffer', () => {
    it('跟随模式总是显示最后几行', () => {
        const buffer = new LogBuffer(100);

        for (let index = 1; index <= 10; index += 1) {
            buffer.push(`第 ${index} 行`);
        }

        const view = buffer.window(3);

        expect(view.lines.map((line) => line.text)).toEqual(['第 8 行', '第 9 行', '第 10 行']);
        expect(view.following).toBe(true);
        expect(view.above).toBe(7);
    });

    it('向上滚动后不再跟随，并显示更早的行', () => {
        const buffer = new LogBuffer(100);

        for (let index = 1; index <= 10; index += 1) {
            buffer.push(`第 ${index} 行`);
        }

        buffer.scrollBy(2, 3);

        const view = buffer.window(3);

        expect(buffer.following).toBe(false);
        expect(view.lines.map((line) => line.text)).toEqual(['第 6 行', '第 7 行', '第 8 行']);
    });

    it('滚动范围被夹在缓冲区两端', () => {
        const buffer = new LogBuffer(100);

        for (let index = 1; index <= 5; index += 1) {
            buffer.push(`第 ${index} 行`);
        }

        buffer.scrollBy(999, 3);
        expect(buffer.offset).toBe(2);

        buffer.scrollBy(-999, 3);
        expect(buffer.offset).toBe(0);
    });

    it('回到顶部与回到底部', () => {
        const buffer = new LogBuffer(100);

        for (let index = 1; index <= 20; index += 1) {
            buffer.push(`第 ${index} 行`);
        }

        buffer.scrollToTop(5);
        expect(buffer.window(5).lines[0]?.text).toBe('第 1 行');

        buffer.follow();
        expect(buffer.window(5).lines.at(-1)?.text).toBe('第 20 行');
    });

    it('超出容量时丢弃最旧的行', () => {
        const buffer = new LogBuffer(3);

        for (let index = 1; index <= 6; index += 1) {
            buffer.push(`第 ${index} 行`);
        }

        expect(buffer.size).toBe(3);
        expect(buffer.window(3).lines.map((line) => line.text)).toEqual(['第 4 行', '第 5 行', '第 6 行']);
    });

    it('记录日志级别供着色使用', () => {
        const buffer = new LogBuffer(10);

        buffer.push('普通', 'info');
        buffer.push('警告', 'warn');
        buffer.push('错误', 'error');

        expect(buffer.window(3).lines.map((line) => line.level)).toEqual(['info', 'warn', 'error']);
    });

    it('容量为零时不会崩', () => {
        const buffer = new LogBuffer(0);

        buffer.push('a');

        expect(buffer.window(5).lines).toEqual([]);
    });
});
