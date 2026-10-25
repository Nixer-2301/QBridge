import { describe, expect, it } from 'vitest';
import { splitReply } from '../src/chat/chunk.ts';

describe('splitReply', () => {
    it('空内容返回空数组', () => {
        expect(splitReply('   \n  ', 100)).toEqual([]);
    });

    it('短内容原样返回', () => {
        expect(splitReply('  你好呀  ', 100)).toEqual(['你好呀']);
    });

    it('空行分段默认拆成多条消息', () => {
        const chunks = splitReply('第一段\n\n第二段\n\n第三段', 1_200);

        expect(chunks).toEqual(['第一段', '第二段', '第三段']);
    });

    it('单换行也视为分段（模型常这样分行）', () => {
        const chunks = splitReply('第一行\n第二行\n第三行', 1_200);

        expect(chunks).toEqual(['第一行', '第二行', '第三行']);
    });

    it('关闭 splitParagraphs 后合并为一条，保留段内换行', () => {
        const chunks = splitReply('第一段\n\n第二段', 1_200, { splitParagraphs: false });

        expect(chunks).toHaveLength(1);
        expect(chunks[0]).toContain('第一段');
        expect(chunks[0]).toContain('第二段');
    });

    it('整段没有换行但超过 sentenceSplitAt 时按句号拆', () => {
        const text = '今天天气不错，适合出门走走。不过风有点大，记得带件外套。晚上可能会下雨。';
        const chunks = splitReply(text, 1_200, { sentenceSplitAt: 10 });

        expect(chunks.length).toBeGreaterThan(1);
        expect(chunks.join('')).toBe(text);
    });

    it('sentenceSplitAt=0 时不按句号拆', () => {
        const text = '第一句。第二句。第三句。';
        const chunks = splitReply(text, 1_200, { sentenceSplitAt: 0 });

        expect(chunks).toEqual([text]);
    });

    it('按句号拆分时受 maxSegments 限制', () => {
        const text = Array.from({ length: 8 }, (_unused, index) => `第${index}句话说完了。`).join('');
        const chunks = splitReply(text, 1_200, { sentenceSplitAt: 5, maxSegments: 3 });

        expect(chunks.length).toBeLessThanOrEqual(3);
        expect(chunks.join('')).toBe(text);
    });

    it('段落数超过 maxSegments 时并回最后一条', () => {
        const chunks = splitReply('A\n\nB\n\nC\n\nD\n\nE', 1_200, { maxSegments: 3 });

        expect(chunks).toHaveLength(3);
        expect(chunks[0]).toBe('A');
        expect(chunks[2]).toContain('C');
        expect(chunks[2]).toContain('E');
    });

    it('超长段落仍按字符上限切分', () => {
        const chunks = splitReply('啊'.repeat(200) + '\n\n' + '乙'.repeat(200), 120);

        expect(chunks.length).toBeGreaterThan(3);

        for (const chunk of chunks) {
            expect(chunk.length).toBeLessThanOrEqual(120);
        }
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
        const chunks = splitReply('啊'.repeat(1_000), 120, { sentenceSplitAt: 0 });

        expect(chunks.length).toBeGreaterThan(5);

        for (const chunk of chunks) {
            expect(chunk.length).toBeLessThanOrEqual(120);
        }

        expect(chunks.join('')).toHaveLength(1_000);
    });

    it('优先在标点处断开', () => {
        const text = `${'甲'.repeat(30)}。${'乙'.repeat(30)}。${'丙'.repeat(30)}`;
        const chunks = splitReply(text, 40, { sentenceSplitAt: 0 });

        for (const chunk of chunks.slice(0, -1)) {
            expect(chunk.endsWith('。')).toBe(true);
        }
    });

    it('保留原有单换行，不丢失内容', () => {
        const lines = Array.from({ length: 8 }, (_unused, index) => `第${index}行内容`);
        const chunks = splitReply(lines.join('\n'), 20);
        const merged = chunks.join('').replace(/\s/g, '');

        expect(merged).toBe(lines.join('').replace(/\s/g, ''));
    });
});
