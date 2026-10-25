import type { ChatMessage } from '../types.ts';

/**
 * 中文字符大致 0.6 token，其它字符约 4 字符/token。
 * 这里只用于上下文预算裁剪，宁可略高估，避免超出模型窗口。
 */
const CJK_PATTERN =
    /[\u1100-\u11ff\u2e80-\u303f\u3040-\u30ff\u3130-\u318f\u3400-\u4dbf\u4e00-\u9fff\ua960-\ua97f\uac00-\ud7ff\uf900-\ufaff\ufe10-\ufe4f\uff00-\uffef\u{20000}-\u{2ffff}]/u;

/** 每条消息的固定开销（role 标记、分隔符等）。 */
export const MESSAGE_OVERHEAD_TOKENS = 4;

export function estimateTokens(text: string): number {
    if (text.length === 0) {
        return 0;
    }

    let cjk = 0;
    let other = 0;

    for (const char of text) {
        if (CJK_PATTERN.test(char)) {
            cjk += 1;
        } else {
            other += 1;
        }
    }

    return Math.ceil(cjk * 0.6 + other * 0.25);
}

export function estimateMessageTokens(content: string): number {
    return estimateTokens(content) + MESSAGE_OVERHEAD_TOKENS;
}

export function estimateChatTokens(messages: readonly ChatMessage[]): number {
    let total = 0;

    for (const message of messages) {
        total += estimateMessageTokens(message.content);
    }

    return total;
}
