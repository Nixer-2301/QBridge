import { describe, expect, it } from 'vitest';
import {
    charWidth,
    displayWidth,
    padToWidth,
    truncateAnsiToWidth,
    truncateToWidth,
} from '../src/tui/width.ts';

describe('charWidth', () => {
    it('ASCII 占 1 列', () => {
        expect(charWidth('a')).toBe(1);
        expect(charWidth(' ')).toBe(1);
    });

    it('中文与全角符号占 2 列', () => {
        expect(charWidth('群')).toBe(2);
        expect(charWidth('，')).toBe(2);
        expect(charWidth('。')).toBe(2);
    });

    it('组合字符占 0 列', () => {
        expect(charWidth('\u0300')).toBe(0);
    });
});

describe('displayWidth', () => {
    it('中英混排按显示宽度累加', () => {
        expect(displayWidth('群 1')).toBe(4);
        expect(displayWidth('abc')).toBe(3);
    });
});

describe('truncateToWidth', () => {
    it('短文本原样返回', () => {
        expect(truncateToWidth('短文本', 10)).toBe('短文本');
    });

    it('超宽时按显示宽度截断并加省略号', () => {
        const result = truncateToWidth('一二三四五六', 7);

        expect(displayWidth(result)).toBeLessThanOrEqual(7);
        expect(result.endsWith('…')).toBe(true);
    });

    it('宽度为 0 时返回空串', () => {
        expect(truncateToWidth('abc', 0)).toBe('');
    });
});

describe('padToWidth', () => {
    it('按显示宽度补空格', () => {
        expect(padToWidth('群', 5)).toBe('群   ');
        expect(padToWidth('abcdef', 3)).toBe('abcdef');
    });
});

describe('truncateAnsiToWidth', () => {
    it('保留颜色转义且不超过宽度', () => {
        const colored = '\u001b[32m绿色文字\u001b[0m';
        const result = truncateAnsiToWidth(colored, 4);

        expect(result).toContain('\u001b[32m');
        expect(displayWidth(result.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, ''))).toBeLessThanOrEqual(4);
        expect(result.endsWith('\u001b[0m')).toBe(true);
    });

    it('不超宽时原样返回', () => {
        const colored = '\u001b[31m红色\u001b[0m';

        expect(truncateAnsiToWidth(colored, 10)).toBe(colored);
    });

    it('截断后不会再泄露颜色到后续内容', () => {
        const result = truncateAnsiToWidth('\u001b[31m' + '很长的红色文本'.repeat(3) + '\u001b[0m', 6);

        expect(result.endsWith('\u001b[0m')).toBe(true);
    });
});
