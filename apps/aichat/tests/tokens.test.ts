import { describe, expect, it } from 'vitest';
import { estimateChatTokens, estimateMessageTokens, estimateTokens } from '../src/llm/tokens.ts';

describe('estimateTokens', () => {
    it('空文本为 0', () => {
        expect(estimateTokens('')).toBe(0);
    });

    it('中文按 0.6 token/字估算', () => {
        expect(estimateTokens('你好')).toBe(2);
        expect(estimateTokens('你好世界')).toBe(3);
    });

    it('英文按约 4 字符/token 估算', () => {
        expect(estimateTokens('abcd')).toBe(1);
        expect(estimateTokens('abcdefgh')).toBe(2);
    });

    it('混合文本不低估中文占比', () => {
        expect(estimateTokens('你好 hello')).toBeGreaterThan(estimateTokens('hello'));
    });

    it('长度增加时 token 单调不减', () => {
        const short = estimateTokens('今天天气不错');
        const long = estimateTokens(`今天天气不错，${'而且很凉快'.repeat(10)}`);

        expect(long).toBeGreaterThan(short);
    });
});

describe('estimateMessageTokens', () => {
    it('包含固定消息开销', () => {
        expect(estimateMessageTokens('')).toBe(4);
        expect(estimateMessageTokens('abcd')).toBe(5);
    });
});

describe('estimateChatTokens', () => {
    it('累加所有消息', () => {
        const total = estimateChatTokens([
            { role: 'system', content: 'abcd' },
            { role: 'user', content: 'abcd' },
        ]);

        expect(total).toBe(10);
    });
});
