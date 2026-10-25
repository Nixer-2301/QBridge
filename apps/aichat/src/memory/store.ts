import { estimateMessageTokens } from '../llm/tokens.ts';
import type { ChatMessage } from '../types.ts';

export type HistoryRole = 'user' | 'assistant';

export interface StoredMessage {
    role: HistoryRole;
    content: string;
    tokens: number;
    at: number;
}

export interface ConversationStoreOptions {
    maxMessages: number;
    maxTokens: number;
    maxCharsPerMessage: number;
    maxGroups: number;
    idleTtlMs: number;
    now?: () => number;
}

interface GroupState {
    messages: StoredMessage[];
    updatedAt: number;
}

/** 把一条群消息压成单行上下文，保留换行但去掉多余空白。 */
export function sanitizeMessageContent(content: string, maxChars: number): string {
    const normalized = content
        .replace(/\r\n/g, '\n')
        .replace(/[ \t]+/g, ' ')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();

    if (normalized.length <= maxChars) {
        return normalized;
    }

    return `${normalized.slice(0, maxChars)}…`;
}

/**
 * 每个群一份共享上下文（多人聊天），按条数和 token 预算双上限裁剪。
 * Map 的插入顺序被用作 LRU：命中/写入时把群移到末尾。
 */
export class ConversationStore {
    private readonly groups = new Map<number, GroupState>();
    private readonly options: ConversationStoreOptions;
    private readonly now: () => number;

    constructor(options: ConversationStoreOptions) {
        this.options = options;
        this.now = options.now ?? (() => Date.now());
    }

    get groupCount(): number {
        return this.groups.size;
    }

    appendUser(groupId: number, content: string): StoredMessage | null {
        return this.append(groupId, 'user', content);
    }

    appendAssistant(groupId: number, content: string): StoredMessage | null {
        return this.append(groupId, 'assistant', content);
    }

    append(groupId: number, role: HistoryRole, content: string): StoredMessage | null {
        const normalized = sanitizeMessageContent(content, this.options.maxCharsPerMessage);

        if (normalized.length === 0) {
            return null;
        }

        const state = this.touch(groupId);
        const message: StoredMessage = {
            role,
            content: normalized,
            tokens: estimateMessageTokens(normalized),
            at: this.now(),
        };

        state.messages.push(message);
        this.trim(state);

        return message;
    }

    /** 返回可直接发给模型的副本，不暴露内部对象。 */
    messages(groupId: number): ChatMessage[] {
        const state = this.groups.get(groupId);

        if (!state) {
            return [];
        }

        return state.messages.map((message) => ({ role: message.role, content: message.content }));
    }

    historyTokens(groupId: number): number {
        const state = this.groups.get(groupId);

        if (!state) {
            return 0;
        }

        return state.messages.reduce((total, message) => total + message.tokens, 0);
    }

    lastActiveAt(groupId: number): number | undefined {
        return this.groups.get(groupId)?.updatedAt;
    }

    clear(groupId: number): boolean {
        return this.groups.delete(groupId);
    }

    clearAll(): void {
        this.groups.clear();
    }

    /** 丢弃空闲超时的群上下文，返回被清理的群数。 */
    sweep(): number {
        const deadline = this.now() - this.options.idleTtlMs;
        let removed = 0;

        for (const [groupId, state] of this.groups) {
            if (state.updatedAt <= deadline) {
                this.groups.delete(groupId);
                removed += 1;
            }
        }

        return removed;
    }

    private touch(groupId: number): GroupState {
        const existing = this.groups.get(groupId);
        const now = this.now();

        if (existing) {
            existing.updatedAt = now;
            this.groups.delete(groupId);
            this.groups.set(groupId, existing);
            return existing;
        }

        const state: GroupState = { messages: [], updatedAt: now };
        this.groups.set(groupId, state);
        this.evictOverflow();

        return state;
    }

    private evictOverflow(): void {
        while (this.groups.size > this.options.maxGroups) {
            const oldest = this.groups.keys().next();

            if (oldest.done) {
                return;
            }

            this.groups.delete(oldest.value);
        }
    }

    private trim(state: GroupState): void {
        const { maxMessages, maxTokens } = this.options;
        const { messages } = state;

        while (messages.length > maxMessages) {
            this.dropOldest(messages);
        }

        while (messages.length > 1 && messages[0]?.role === 'assistant') {
            messages.shift();
        }

        while (messages.length > 1 && this.sumTokens(messages) > maxTokens) {
            this.dropOldest(messages);
        }

        while (messages.length > 1 && messages[0]?.role === 'assistant') {
            messages.shift();
        }
    }

    /** 丢最早的一条；如果它是提问，把对应回答一起丢掉，避免留下无主回答。 */
    private dropOldest(messages: StoredMessage[]): void {
        const removed = messages.shift();

        if (removed?.role === 'user' && messages[0]?.role === 'assistant') {
            messages.shift();
        }
    }

    private sumTokens(messages: readonly StoredMessage[]): number {
        return messages.reduce((total, message) => total + message.tokens, 0);
    }
}
