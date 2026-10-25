import { describe, expect, it } from 'vitest';
import { ConversationStore, sanitizeMessageContent } from '../src/memory/store.ts';

function createStore(overrides: Partial<ConstructorParameters<typeof ConversationStore>[0]> = {}) {
    let now = 1_000;

    const store = new ConversationStore({
        maxMessages: 20,
        maxTokens: 20_000,
        maxCharsPerMessage: 2_000,
        maxGroups: 10,
        idleTtlMs: 60 * 60 * 1_000,
        now: () => now,
        ...overrides,
    });

    return {
        store,
        advance(ms: number) {
            now += ms;
        },
    };
}

describe('sanitizeMessageContent', () => {
    it('压缩多余空白并保留换行', () => {
        expect(sanitizeMessageContent('  a   b\n\n\nc  ', 100)).toBe('a b\n\nc');
    });

    it('超长内容被截断并加省略号', () => {
        const result = sanitizeMessageContent('x'.repeat(50), 10);

        expect(result).toHaveLength(11);
        expect(result.endsWith('…')).toBe(true);
    });
});

describe('ConversationStore', () => {
    it('按条数上限裁剪并保持首条为提问', () => {
        const { store } = createStore({ maxMessages: 4 });

        store.appendUser(1, 'q1');
        store.appendAssistant(1, 'a1');
        store.appendUser(1, 'q2');
        store.appendAssistant(1, 'a2');
        store.appendUser(1, 'q3');
        store.appendAssistant(1, 'a3');

        const messages = store.messages(1);

        expect(messages).toHaveLength(4);
        expect(messages[0]).toEqual({ role: 'user', content: 'q2' });
        expect(messages.at(-1)).toEqual({ role: 'assistant', content: 'a3' });
    });

    it('丢弃提问时连带丢弃对应回答，避免出现无主回答', () => {
        const { store } = createStore({ maxMessages: 3 });

        store.appendUser(1, 'q1');
        store.appendAssistant(1, 'a1');
        store.appendUser(1, 'q2');
        store.appendUser(1, 'q3');

        const messages = store.messages(1);

        expect(messages.map((item) => item.content)).toEqual(['q2', 'q3']);
    });

    it('按 token 预算裁剪', () => {
        const { store } = createStore({ maxTokens: 60, maxMessages: 100 });

        for (let index = 0; index < 10; index += 1) {
            store.appendUser(1, `第${index}条消息内容`.repeat(4));
        }

        expect(store.historyTokens(1)).toBeLessThanOrEqual(60);
        expect(store.messages(1).at(-1)?.content).toContain('第9条');
    });

    it('空内容不写入上下文', () => {
        const { store } = createStore();

        expect(store.appendUser(1, '   ')).toBeNull();
        expect(store.messages(1)).toEqual([]);
    });

    it('不同群的上下文互相隔离', () => {
        const { store } = createStore();

        store.appendUser(100, '群100的消息');
        store.appendUser(200, '群200的消息');

        expect(store.messages(100)).toHaveLength(1);
        expect(store.messages(200)[0]?.content).toBe('群200的消息');
    });

    it('群数量超过上限时淘汰最久未活动的群', () => {
        const { store, advance } = createStore({ maxGroups: 2 });

        store.appendUser(1, 'a');
        advance(10);
        store.appendUser(2, 'b');
        advance(10);
        store.appendUser(3, 'c');

        expect(store.groupCount).toBe(2);
        expect(store.messages(1)).toEqual([]);
        expect(store.messages(3)).toHaveLength(1);
    });

    it('命中过的群不会被优先淘汰', () => {
        const { store, advance } = createStore({ maxGroups: 2 });

        store.appendUser(1, 'a');
        advance(10);
        store.appendUser(2, 'b');
        advance(10);
        store.messages(1);
        store.appendUser(1, 'a2');
        advance(10);
        store.appendUser(3, 'c');

        expect(store.messages(1).map((item) => item.content)).toEqual(['a', 'a2']);
        expect(store.messages(2)).toEqual([]);
    });

    it('按空闲时间清理上下文', () => {
        const { store, advance } = createStore({ idleTtlMs: 1_000 });

        store.appendUser(1, 'a');
        advance(1_500);

        expect(store.sweep()).toBe(1);
        expect(store.messages(1)).toEqual([]);
    });

    it('clear 只清空指定群', () => {
        const { store } = createStore();

        store.appendUser(1, 'a');
        store.appendUser(2, 'b');
        store.clear(1);

        expect(store.messages(1)).toEqual([]);
        expect(store.messages(2)).toHaveLength(1);
    });

    it('返回的副本修改后不影响内部状态', () => {
        const { store } = createStore();

        store.appendUser(1, 'a');
        const messages = store.messages(1);
        messages.push({ role: 'user', content: 'injected' });

        expect(store.messages(1)).toHaveLength(1);
    });
});
