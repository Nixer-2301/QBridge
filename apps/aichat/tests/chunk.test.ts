import { describe, expect, it } from 'vitest';
import { splitReply } from '../src/chat/chunk.ts';

describe('splitReply', () => {
    it('空内容返回空数组', () => {
        expect(splitReply('   \n  ', 100)).toEqual([]);
    });

    it('短内容原样返回', () => {
        expect(splitReply('  你好呀  ', 100)).toEqual(['你好呀']);
    });

    it('按段落切分且每段不超限', () => {
        const text = ['第一段'.repeat(10), '第二段'.repeat(10), '第三段'.repeat(10)].join('\n\n');
        const chunks = splitReply(text, 50);

        expect(chunks.length).toBeGreaterThan(1);

        for (const chunk of chunks) {
            expect(chunk.length).toBeLessThanOrEqual(50);
            expect(chunk.trim()).toBe(chunk);
        }
    });

    it('超长单行也能切开', () => {
        const chunks = splitReply('啊'.repeat(1_000), 120);

        expect(chunks.length).toBeGreaterThan(5);

        for (const chunk of chunks) {
            expect(chunk.length).toBeLessThanOrEqual(120);
        }

        expect(chunks.join('')).toHaveLength(1_000);
    });

    it('优先在标点处断开', () => {
        const text = `${'甲'.repeat(30)}。${'乙'.repeat(30)}。${'丙'.repeat(30)}`;
        const chunks = splitReply(text, 40);

        for (const chunk of chunks.slice(0, -1)) {
            expect(chunk.endsWith('。')).toBe(true);
        }
    });

    it('保留原有段落分隔，不丢失内容', () => {
        const paragraphs = Array.from({ length: 8 }, (_unused, index) => `第${index}段内容`);
        const chunks = splitReply(paragraphs.join('\n'), 20);
        const merged = chunks.join('\n').replace(/\s/g, '');

        expect(merged).toBe(paragraphs.join('').replace(/\s/g, ''));
    });
});
