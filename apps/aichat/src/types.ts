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

export interface VisionConfig {
    /** 是否把群消息里的图片一起发给模型。 */
    enabled: boolean;
    /** 单条消息最多带几张图。 */
    maxImages: number;
    /** 单张图片的最大字节数（本地文件转 data URI 时用）。 */
    maxBytes: number;
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
    /** 空行分隔的段落是否拆成多条消息发送（多段回复）。 */
    splitParagraphs: boolean;
    /** 整段没有换行、又超过这个字数时按句号拆成多条；0 关闭。 */
    sentenceSplitAt: number;
    /** 引用（回复）机器人消息时也触发，不必 @。 */
    triggerOnReply: boolean;
    /** 发给模型时给「正在问你」的那条消息加的标记；空字符串关闭。 */
    triggerMarker: string;
    /** 一次回复最多拆成几条消息，超出的段落并回最后一条。 */
    maxReplySegments: number;
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
    /** 提示词目录：相对进程工作目录，也可写绝对路径。 */
    dir: string;
    /** 主提示词文件（相对 dir）。 */
    main: string;
    /** 按群覆盖：群号 -> 相对 dir 的文件路径；留空则自动匹配 `groups/<群号>.md`。 */
    perGroup: Record<string, string>;
    /** 监听提示词文件变化并自动重载（默认 true）。 */
    hotReload: boolean;
    /** @deprecated 旧的内联提示词，仅在主提示词文件缺失时用于自动生成它。 */
    system?: string;
}

export type GithubKind = 'release' | 'commit';

export interface GithubTargetConfig {
    /** owner/repo */
    repo: string;
    /** 发到哪些群 */
    groupIds: number[];
    /** 监听哪类事件 */
    kinds: GithubKind[];
    /** 按事件覆盖默认模板，可用占位符见 README */
    template?: Partial<Record<GithubKind, string>>;
}

export interface GithubConfig {
    enabled: boolean;
    /** 轮询间隔（秒），最小 60 */
    intervalSeconds: number;
    /** 可选 GitHub token，用来提高 API 限额 */
    token?: string;
    /** 记录已推送事件 id 的文件，避免重启后重复发 */
    stateFile: string;
    /** 首次运行是否补发当前最新事件（默认 false） */
    postExisting: boolean;
    targets: GithubTargetConfig[];
}

export interface AppConfig {
    onebot: OneBotConfig;
    bot: BotConfig;
    context: ContextConfig;
    llm: LlmConfig;
    prompt: PromptConfig;
    vision: VisionConfig;
    github: GithubConfig;
    logging: { level: LogLevel };
}

export type ChatRole = 'system' | 'user' | 'assistant';

export type ContentPart =
    | { type: 'text'; text: string }
    | { type: 'image_url'; image_url: { url: string } };

export interface ChatMessage {
    role: ChatRole;
    /** 纯文本，或 OpenAI 兼容的多模态分段（文本 + 图片）。 */
    content: string | ContentPart[];
}



