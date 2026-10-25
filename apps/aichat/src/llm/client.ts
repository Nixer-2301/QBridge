import type { Logger } from '../logger.ts';
import type { ChatMessage, LlmConfig } from '../types.ts';

export class LlmError extends Error {
    readonly status: number | undefined;
    readonly retriable: boolean;

    constructor(message: string, status?: number, retriable: boolean = false) {
        super(message);
        this.name = 'LlmError';
        this.status = status;
        this.retriable = retriable;
    }
}

export interface LlmUsage {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
}

export interface LlmResult {
    text: string;
    model?: string;
    usage?: LlmUsage;
    attempts: number;
}

export interface LlmClientOptions {
    getConfig: () => LlmConfig;
    logger: Logger;
    /** 默认使用全局 fetch，测试可注入。 */
    fetchImpl?: typeof fetch;
    /** 失败重试之间的基础等待毫秒数。 */
    retryDelayMs?: number;
    sleep?: (ms: number) => Promise<void>;
}

interface CompletionPayload {
    choices?: unknown;
    model?: unknown;
    usage?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function readMessageContent(payload: CompletionPayload): string {
    if (!Array.isArray(payload.choices) || payload.choices.length === 0) {
        throw new LlmError('模型响应里没有 choices');
    }

    const first: unknown = payload.choices[0];
    const message = isRecord(first) ? first['message'] : undefined;

    if (!isRecord(message)) {
        throw new LlmError('模型响应里没有 message');
    }

    const content = message['content'];

    if (typeof content === 'string') {
        return content.trim();
    }

    if (Array.isArray(content)) {
        const parts: string[] = [];

        for (const part of content) {
            if (typeof part === 'string') {
                parts.push(part);
                continue;
            }

            if (isRecord(part) && typeof part['text'] === 'string') {
                parts.push(part['text']);
            }
        }

        return parts.join('').trim();
    }

    return '';
}

function readUsage(payload: CompletionPayload): LlmUsage | undefined {
    if (!isRecord(payload.usage)) {
        return undefined;
    }

    const usage: LlmUsage = {};
    const prompt = payload.usage['prompt_tokens'];
    const completion = payload.usage['completion_tokens'];
    const total = payload.usage['total_tokens'];

    if (typeof prompt === 'number') {
        usage.promptTokens = prompt;
    }

    if (typeof completion === 'number') {
        usage.completionTokens = completion;
    }

    if (typeof total === 'number') {
        usage.totalTokens = total;
    }

    return Object.keys(usage).length > 0 ? usage : undefined;
}

function isRetriableStatus(status: number): boolean {
    return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

/**
 * OpenAI 兼容的 /chat/completions 客户端（DeepSeek、OpenAI、Qwen、Kimi、Ollama、one-api 都走这一套）。
 * 非流式请求：QQ 消息本来就要整段发出，流式只会增加复杂度。
 */
export class LlmClient {
    private readonly options: LlmClientOptions;

    constructor(options: LlmClientOptions) {
        this.options = options;
    }

    async chat(messages: ChatMessage[], signal?: AbortSignal): Promise<LlmResult> {
        const config = this.options.getConfig();
        const maxAttempts = config.retries + 1;
        let lastError: unknown;

        for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
            try {
                const result = await this.requestOnce(config, messages, attempt, signal);

                if (result.usage) {
                    this.options.logger.debug(
                        '模型调用完成',
                        `attempts=${result.attempts}`,
                        `tokens=${result.usage.totalTokens ?? '?'}`,
                    );
                }

                return result;
            } catch (error) {
                lastError = error;

                const retriable = this.isRetriableError(error);

                if (!retriable || attempt >= maxAttempts) {
                    throw error instanceof Error ? error : new Error(String(error));
                }

                const delay = (this.options.retryDelayMs ?? 500) * 2 ** (attempt - 1);

                this.options.logger.warn(
                    `模型调用失败，${delay}ms 后重试（第 ${attempt}/${maxAttempts - 1} 次重试）`,
                    error instanceof Error ? error.message : String(error),
                );

                await this.sleep(delay);
            }
        }

        throw lastError instanceof Error ? lastError : new Error(String(lastError));
    }

    private async requestOnce(
        config: LlmConfig,
        messages: ChatMessage[],
        attempt: number,
        signal?: AbortSignal,
    ): Promise<LlmResult> {
        const fetchImpl = this.options.fetchImpl ?? fetch;
        const endpoint = /\/chat\/completions$/i.test(config.baseUrl)
            ? config.baseUrl
            : `${config.baseUrl}/chat/completions`;
        const timeoutSignal = AbortSignal.timeout(config.timeoutMs);
        const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
        const headers: Record<string, string> = {
            'content-type': 'application/json',
            ...config.extraHeaders,
        };

        if (config.apiKey.length > 0) {
            headers['authorization'] = `Bearer ${config.apiKey}`;
        }

        const body = {
            model: config.model,
            messages,
            temperature: config.temperature,
            top_p: config.topP,
            max_tokens: config.maxTokens,
            stream: false,
            ...config.extraBody,
        };

        let response: Response;

        try {
            response = await fetchImpl(endpoint, {
                method: 'POST',
                headers,
                body: JSON.stringify(body),
                signal: combined,
            });
        } catch (error) {
            if (isAbortError(error)) {
                throw error;
            }

            if (isTimeoutError(error)) {
                throw new LlmError(`模型请求超时（${config.timeoutMs}ms）`, undefined, true);
            }

            throw new LlmError(
                `无法连接模型服务 ${endpoint}：${error instanceof Error ? error.message : String(error)}`,
                undefined,
                true,
            );
        }

        if (!response.ok) {
            const detail = await this.readErrorBody(response);
            throw new LlmError(
                `模型服务返回 ${response.status}${detail.length > 0 ? `：${detail}` : ''}`,
                response.status,
                isRetriableStatus(response.status),
            );
        }

        let payload: unknown;

        try {
            payload = await response.json();
        } catch (error) {
            throw new LlmError(
                `模型响应不是合法 JSON：${error instanceof Error ? error.message : String(error)}`,
                response.status,
                false,
            );
        }

        if (!isRecord(payload)) {
            throw new LlmError('模型响应结构异常：根节点不是对象', response.status, false);
        }

        const completion = payload as CompletionPayload;
        const text = readMessageContent(completion);

        if (text.length === 0) {
            throw new LlmError('模型返回了空内容', response.status, true);
        }

        const result: LlmResult = { text, attempts: attempt };
        const model = completion.model;

        if (typeof model === 'string') {
            result.model = model;
        }

        const usage = readUsage(completion);

        if (usage) {
            result.usage = usage;
        }

        return result;
    }

    private async readErrorBody(response: Response): Promise<string> {
        try {
            const text = (await response.text()).replace(/\s+/g, ' ').trim();

            return text.length > 300 ? `${text.slice(0, 300)}…` : text;
        } catch {
            return '';
        }
    }

    private isRetriableError(error: unknown): boolean {
        if (error instanceof LlmError) {
            return error.retriable;
        }

        // fetch 的网络层异常（DNS、连接被拒等）值得重试一次。
        return error instanceof TypeError;
    }

    private sleep(ms: number): Promise<void> {
        if (this.options.sleep) {
            return this.options.sleep(ms);
        }

        return new Promise((resolve) => {
            setTimeout(resolve, ms);
        });
    }
}

function isTimeoutError(error: unknown): boolean {
    return (
        typeof error === 'object' &&
        error !== null &&
        'name' in error &&
        error.name === 'TimeoutError'
    );
}

function isAbortError(error: unknown): boolean {
    return (
        typeof error === 'object' &&
        error !== null &&
        'name' in error &&
        error.name === 'AbortError'
    );
}
