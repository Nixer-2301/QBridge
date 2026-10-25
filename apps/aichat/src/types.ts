/** Configuration and shared domain types. */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

export interface OneBotConfig {
    /** OneBot v11 正向 WebSocket 地址，来自 QBridge 的 `config/onebot_<uin>.json`。 */
    url: string;
    accessToken?: string;
    requestTimeoutMs: number;
    reconnect: boolean;
}

export interface TriggerConfig {
    /** 是否必须 @ 机器人才回复。默认 true。 */
    requireAt: boolean;
    /** 额外的唤醒词（不需要 @ 也能触发）。空数组表示只认 @。 */
    wakeWords: string[];
}

export interface GroupsConfig {
    /** 只处理这些群。空数组表示不限制。 */
    whitelist: number[];
    /** 永不处理的群，优先级高于白名单。 */
    blacklist: number[];
}

export interface BotConfig {
    name: string;
    trigger: TriggerConfig;
    /** 未被 @ 的群消息也写入上下文，模型才知道群里刚聊了什么。 */
    recordAllGroupMessages: boolean;
    /** 回复时引用触发它的那条消息。 */
    replyQuote: boolean;
    /** 回复时额外 @ 触发者。 */
    atSender: boolean;
    groups: GroupsConfig;
    /** 允许使用 `/reset`、`/reload` 的 QQ 号。 */
    owners: number[];
    /** 单条 QQ 消息的最大字符数，超长回复会被切分。 */
    maxReplyChars: number;
    /** 多条分片之间的间隔毫秒数。 */
    chunkDelayMs: number;
    /** 模型调用失败时是否在群里提示（默认只写日志）。 */
    notifyOnError: boolean;
}

export interface ContextConfig {
    /** 单个群保留的消息条数上限。 */
    maxMessages: number;
    /** 单个群上下文（系统提示词 + 历史）的 token 预算上限。 */
    maxTokens: number;
    /** 单条消息写入上下文时截断到的最大字符数。 */
    maxCharsPerMessage: number;
    /** 最多同时记住多少个群（LRU 淘汰）。 */
    maxGroups: number;
    /** 群上下文空闲多久后丢弃（分钟）。 */
    idleTtlMinutes: number;
    /** 上下文里是否给用户消息加「昵称: 」前缀。 */
    includeSpeakerName: boolean;
}

export interface LlmConfig {
    /** OpenAI 兼容端点，可带版本前缀，如 https://api.deepseek.com/v1 。 */
    baseUrl: string;
    apiKey: string;
    model: string;
    temperature: number;
    topP: number;
    maxTokens: number;
    timeoutMs: number;
    /** 失败重试次数（不含首次请求）。 */
    retries: number;
    extraHeaders: Record<string, string>;
    /** 直接并入请求体，用于传供应商特有参数。 */
    extraBody: Record<string, unknown>;
}

export interface PromptConfig {
    system: string;
    /** 按群覆盖系统提示词，键是群号。 */
    perGroup: Record<string, string>;
}

export interface AppConfig {
    onebot: OneBotConfig;
    bot: BotConfig;
    context: ContextConfig;
    llm: LlmConfig;
    prompt: PromptConfig;
    logging: { level: LogLevel };
}

export type ChatRole = 'system' | 'user' | 'assistant';

export interface ChatMessage {
    role: ChatRole;
    content: string;
}
