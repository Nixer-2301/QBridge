import { describe, expect, it, vi } from 'vitest';
import { parseConfig } from '../src/config.ts';
import { createLogger } from '../src/logger.ts';
import { LlmClient, LlmError } from '../src/llm/client.ts';
import type { ChatMessage } from '../src/types.ts';

const logger = createLogger('test', 'silent');

function createClient(
    fetchImpl: typeof fetch,
    overrides: Record<string, unknown> = {},
    delays: number[] = [],
): LlmClient {
    const config = parseConfig(
        {
            llm: {
                baseUrl: 'https://api.example.com/v1',
                apiKey: 'sk-test',
                model: 'test-model',
                retries: 2,
                ...overrides,
            },
        },
        {},
    );

    return new LlmClient({
        getConfig: () => config.llm,
        logger,
        fetchImpl,
        retryDelayMs: 10,
        sleep: async (ms) => {
            delays.push(ms);
        },
    });
}

const messages: ChatMessage[] = [{ role: 'user', content: '你好' }];

function ok(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
    });
}

describe('LlmClient', () => {
    it('发送 OpenAI 兼容请求并取回文本', async () => {
        const fetchImpl = vi.fn(async () =>
            ok({
                model: 'test-model',
                choices: [{ message: { role: 'assistant', content: ' 你好呀 ' } }],
                usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
            }),
        ) as unknown as typeof fetch;

        const client = createClient(fetchImpl, { extraBody: { enable_thinking: false } });
        const result = await client.chat(messages);

        expect(result.text).toBe('你好呀');
        expect(result.model).toBe('test-model');
        expect(result.usage?.totalTokens).toBe(13);
        expect(result.attempts).toBe(1);

        const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
            string,
            RequestInit,
        ];

        expect(url).toBe('https://api.example.com/v1/chat/completions');
        expect(init.method).toBe('POST');

        const headers = init.headers as Record<string, string>;

        expect(headers['authorization']).toBe('Bearer sk-test');

        const body = JSON.parse(String(init.body)) as Record<string, unknown>;

        expect(body['model']).toBe('test-model');
        expect(body['stream']).toBe(false);
        expect(body['enable_thinking']).toBe(false);
        expect(body['messages']).toEqual(messages);
    });

    it('baseUrl 已经带 /chat/completions 时不重复拼接', async () => {
        const fetchImpl = vi.fn(async () =>
            ok({ choices: [{ message: { content: 'hi' } }] }),
        ) as unknown as typeof fetch;

        const client = createClient(fetchImpl, {
            baseUrl: 'https://api.example.com/v1/chat/completions',
        });

        await client.chat(messages);

        const [url] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string];

        expect(url).toBe('https://api.example.com/v1/chat/completions');
    });

    it('没有 apiKey 时不发 Authorization 头', async () => {
        const fetchImpl = vi.fn(async () =>
            ok({ choices: [{ message: { content: 'hi' } }] }),
        ) as unknown as typeof fetch;

        const client = createClient(fetchImpl, { apiKey: '' });

        await client.chat(messages);

        const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
            string,
            RequestInit,
        ];

        expect((init.headers as Record<string, string>)['authorization']).toBeUndefined();
    });

    it('支持数组形式的内容分段', async () => {
        const fetchImpl = vi.fn(async () =>
            ok({ choices: [{ message: { content: [{ text: '你好' }, { text: '世界' }] } }] }),
        ) as unknown as typeof fetch;

        const result = await createClient(fetchImpl).chat(messages);

        expect(result.text).toBe('你好世界');
    });

    it('5xx 会重试并最终成功', async () => {
        let calls = 0;
        const fetchImpl = vi.fn(async () => {
            calls += 1;

            if (calls < 3) {
                return ok({ error: 'boom' }, 500);
            }

            return ok({ choices: [{ message: { content: '重试成功' } }] });
        }) as unknown as typeof fetch;

        const delays: number[] = [];
        const client = createClient(fetchImpl, {}, delays);

        const result = await client.chat(messages);

        expect(result.text).toBe('重试成功');
        expect(result.attempts).toBe(3);
        expect(delays).toEqual([10, 20]);
    });

    it('401 不重试并抛出带状态码的错误', async () => {
        const fetchImpl = vi.fn(async () => ok({ error: 'invalid key' }, 401)) as unknown as typeof fetch;

        await expect(createClient(fetchImpl).chat(messages)).rejects.toMatchObject({
            name: 'LlmError',
            status: 401,
        });
        expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
    });

    it('重试耗尽后抛出最后一次错误', async () => {
        const fetchImpl = vi.fn(async () => ok({ error: 'down' }, 503)) as unknown as typeof fetch;

        await expect(createClient(fetchImpl).chat(messages)).rejects.toThrow(/503/);
        expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(3);
    });

    it('空回复视为可重试错误', async () => {
        const fetchImpl = vi.fn(async () => ok({ choices: [{ message: { content: '   ' } }] })) as unknown as typeof fetch;

        await expect(createClient(fetchImpl, { retries: 0 }).chat(messages)).rejects.toThrow(/空内容/);
    });

    it('响应缺少 choices 时报错', async () => {
        const fetchImpl = vi.fn(async () => ok({})) as unknown as typeof fetch;

        await expect(createClient(fetchImpl, { retries: 0 }).chat(messages)).rejects.toThrow(/choices/);
    });

    it('网络层异常会被包装并重试', async () => {
        let calls = 0;
        const fetchImpl = vi.fn(async () => {
            calls += 1;

            if (calls === 1) {
                throw new TypeError('fetch failed');
            }

            return ok({ choices: [{ message: { content: 'ok' } }] });
        }) as unknown as typeof fetch;

        const result = await createClient(fetchImpl).chat(messages);

        expect(result.text).toBe('ok');
        expect(calls).toBe(2);
    });

    it('LlmError 保留重试标记', () => {
        expect(new LlmError('x', 500, true).retriable).toBe(true);
        expect(new LlmError('x', 400).retriable).toBe(false);
    });
});
