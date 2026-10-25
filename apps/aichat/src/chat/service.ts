import { message as segments } from '@snowluma/sdk';
import type { AnyMessageSegment } from '@snowluma/sdk';
import { buildAutoReplySegments, cooldownKey, matchAutoReply } from './auto-reply.ts';
import type { CooldownLookup } from './cooldowns.ts';
import { splitReply } from './chunk.ts';
import type { FaceStore } from './faces.ts';
import { buildImageParts } from './vision.ts';
import type { ConfigStore } from '../config.ts';
import type { Logger } from '../logger.ts';
import { LlmError } from '../llm/client.ts';
import type { LlmResult } from '../llm/client.ts';
import { contentText, estimateChatTokens } from '../llm/tokens.ts';
import type { ConversationStore } from '../memory/store.ts';
import type { PromptSource } from '../prompt/store.ts';
import type { ChatMessage, GroupsConfig, TriggerConfig } from '../types.ts';
import type { GroupMessageEventLike, ParsedGroupMessage } from '../qq/segments.ts';
import { formatForHistory, parseGroupMessage } from '../qq/segments.ts';

export interface GroupSender {
    sendGroupMessage(groupId: number, message: AnyMessageSegment[]): Promise<unknown>;
}

/** 只要满足这个形状即可，测试里可以直接注入假模型。 */
export interface ChatModel {
    chat(messages: ChatMessage[], signal?: AbortSignal): Promise<LlmResult>;
}

/**
 * 发送能力的占位槽：业务对象先创建，连接建立后再注入真实发送实现。
 * 没注入就发消息说明启动顺序错了，直接报错而不是静默丢弃。
 */
export class SenderSlot implements GroupSender {
    private target: GroupSender | undefined;

    attach(target: GroupSender): void {
        this.target = target;
    }

    sendGroupMessage(groupId: number, message: AnyMessageSegment[]): Promise<unknown> {
        if (!this.target) {
            return Promise.reject(new Error('发送通道尚未就绪：还未连接到 QBridge 的 OneBot 服务'));
        }

        return this.target.sendGroupMessage(groupId, message);
    }
}

/** 供终端状态栏 / 指标收集用的事件，不包含消息正文。 */
export interface ChatActivity {
    type: 'trigger' | 'reply' | 'error';
    groupId: number;
    elapsedMs?: number;
}

export interface ChatServiceOptions {
    config: ConfigStore;
    store: ConversationStore;
    llm: ChatModel;
    sender: GroupSender;
    logger: Logger;
    /** 系统提示词来源（文件驱动，可按群覆盖）。 */
    prompts: PromptSource;
    /** 商城表情缓存（用于自动回发同一个表情包） */
    faces?: FaceStore;
    /** 自动表情冷却（可持久化，避免重启后立刻又发） */
    cooldowns?: CooldownLookup;
    /** 注入随机数，便于测试 probability */
    random?: () => number;
    sleep?: (ms: number) => Promise<void>;
    onActivity?: (activity: ChatActivity) => void;
}

const COMMAND_PATTERN = /^\/([a-z][a-z0-9_-]*)(?:\s+([\s\S]*))?$/i;
const HELP_TEXT = [
    '可用命令：',
    '/ping 检查机器人是否在线',
    '/face <名称> 发送已学到的表情包',
    '/reset 清空本群上下文（仅管理员）',
    '/reload 重新加载配置文件（仅管理员）',
].join(
    '\n',
);

/** 端点明确表示请求体不合法时，才认为「不支持图片」，避免把限流/超时误判成图片问题。 */
function isImageRejected(error: unknown): boolean {
    if (!(error instanceof LlmError)) {
        return false;
    }

    return error.status === 400 || error.status === 415 || error.status === 422;
}

export function isGroupAllowed(groupId: number, groups: GroupsConfig): boolean {    if (groups.blacklist.includes(groupId)) {
        return false;
    }

    if (groups.whitelist.length > 0 && !groups.whitelist.includes(groupId)) {
        return false;
    }

    return true;
}

/** @、引用回复机器人、或被唤醒词命中才回复；`requireAt: false` 时退化为「所有群消息都回复」。 */
export function isTriggered(
    message: ParsedGroupMessage,
    trigger: TriggerConfig,
    repliedToSelf = false,
): boolean {
    if (message.mentionedSelf || repliedToSelf) {
        return true;
    }

    if (!trigger.requireAt) {
        return true;
    }

    if (trigger.wakeWords.length === 0) {
        return false;
    }

    const haystack = message.text.toLowerCase();

    return trigger.wakeWords.some((word) => haystack.includes(word.toLowerCase()));
}

export class ChatService {
    private readonly options: ChatServiceOptions;
    private readonly queues = new Map<number, Promise<void>>();
    private readonly seenMessageKeys = new Set<string>();
    private readonly seenOrder: string[] = [];
    /** 每个群最近发出去的消息 id，用来识别「引用回复机器人」的触发方式。 */
    private readonly sentIds = new Map<number, number[]>();
    /** 自动表情的冷却记录：规则索引:群号 → 上次发送时间（默认内存，可由 options 注入持久化实现） */
    private readonly autoCooldowns: CooldownLookup;

    constructor(options: ChatServiceOptions) {
        this.options = options;
        this.autoCooldowns = options.cooldowns ?? new Map<string, number>();
    }

    async onGroupMessage(event: GroupMessageEventLike): Promise<void> {
        const config = this.options.config.value;
        const logger = this.options.logger;

        // 只处理真实收到的群消息：跳过自己发出的回显与私聊。
        if (event.post_type !== undefined && event.post_type !== 'message') {
            return;
        }

        if (event.user_id === event.self_id) {
            return;
        }

        if (!isGroupAllowed(event.group_id, config.bot.groups)) {
            logger.debug(`群 ${event.group_id} 不在处理范围，忽略`);
            return;
        }

        if (this.isDuplicate(event.group_id, event.message_id)) {
            logger.debug(`消息 ${event.message_id} 已处理过，跳过重复投递`);
            return;
        }

        const parsed = parseGroupMessage(event, event.self_id);

        // 收到商城表情就记下 emoji_id/key，之后「自动表情」才能原样回发。
        if (parsed.faces.length > 0 && this.options.faces) {
            const learned = this.options.faces.remember(parsed.faces);

            if (learned) {
                logger.debug(`已缓存表情：${parsed.faces.map((face) => face.summary).join('、')}`);
            }
        }

        if (parsed.text.length === 0 && parsed.mentionedSelf) {
            parsed.text = '（@了你，但没有附带文字）';
        }

        if (parsed.text.length === 0) {
            return;
        }

        await this.maybeAutoReply(parsed);

        const repliedToSelf =
            config.bot.triggerOnReply &&
            parsed.replyToId !== undefined &&
            this.isOwnMessage(parsed.groupId, parsed.replyToId);
        const triggered = isTriggered(parsed, config.bot.trigger, repliedToSelf);

        logger.debug(
            `群消息 群=${parsed.groupId} 用户=${parsed.senderName}(${parsed.userId})`,
            `@=${parsed.mentionedSelf ? '是' : '否'} 引用机器人=${repliedToSelf ? '是' : '否'} 文本=${parsed.text.slice(0, 40)} → ${triggered ? '触发' : '忽略'}`,
        );

        if (triggered) {
            const handled = await this.handleCommand(parsed);

            if (handled) {
                return;
            }
        }

        if (config.bot.recordAllGroupMessages || triggered) {
            this.options.store.appendUser(
                parsed.groupId,
                formatForHistory(parsed, config.context.includeSpeakerName),
            );
        }

        if (!triggered) {
            return;
        }

        logger.info(
            `收到触发消息 群=${parsed.groupId} 用户=${parsed.senderName}(${parsed.userId}) 长度=${parsed.text.length}`,
            repliedToSelf && !parsed.mentionedSelf ? '（引用回复触发）' : '',
        );
        this.options.onActivity?.({ type: 'trigger', groupId: parsed.groupId });

        // 在入队前拍下历史快照：同群排队时不会把后面到达的消息算进这一次提问。
        const history = this.options.store.messages(parsed.groupId);

        await this.enqueue(parsed.groupId, () => this.reply(parsed, history));
    }

    /** 指定用户发言时回一个固定表情包（不发模型、不计入上下文）。 */
    private async maybeAutoReply(parsed: ParsedGroupMessage): Promise<void> {
        const config = this.options.config.value;
        const rules = config.autoReplies;

        if (!rules.enabled || rules.rules.length === 0) {
            return;
        }

        const now = Date.now();
        const match = matchAutoReply(
            rules.rules,
            { userId: parsed.userId, groupId: parsed.groupId },
            this.autoCooldowns,
            now,
            this.options.random,
        );

        if (!match) {
            return;
        }

        const face = match.rule.face ? this.options.faces?.get(match.rule.face) : undefined;
        const segments = buildAutoReplySegments(match.rule, face, {
            maxImageBytes: config.vision.maxBytes,
            logger: this.options.logger,
        });

        if (!segments) {
            return;
        }

        try {
            await this.send(parsed.groupId, segments);
            this.autoCooldowns.set(cooldownKey(match.index, parsed.groupId), now);
            this.options.logger.info(
                `自动表情 群=${parsed.groupId} 用户=${parsed.senderName}(${parsed.userId})`,
                match.rule.face ? `表情=${match.rule.face}` : `规则=${match.index}`,
            );
        } catch (error) {
            this.options.logger.error('自动表情发送失败', error);
        }
    }

    private async reply(parsed: ParsedGroupMessage, history: ChatMessage[]): Promise<void> {
        const config = this.options.config.value;
        const logger = this.options.logger;
        const startedAt = Date.now();

        try {
            const prompt = await this.buildPrompt(parsed.groupId, history, parsed.images);
            let result;

            try {
                result = await this.options.llm.chat(prompt.messages);
            } catch (error) {
                // 有些 OpenAI 兼容端点不接受多模态 content；退回纯文本再试一次，别让整条消息失败。
                if (!prompt.withImages || !isImageRejected(error)) {
                    throw error;
                }

                logger.warn('模型似乎不接受图片输入，改为纯文本重试', error instanceof Error ? error.message : error);
                const textOnly = await this.buildPrompt(parsed.groupId, history, []);
                result = await this.options.llm.chat(textOnly.messages);
            }

            const chunks = splitReply(result.text, config.bot.maxReplyChars, {
                splitParagraphs: config.bot.splitParagraphs,
                sentenceSplitAt: config.bot.sentenceSplitAt,
                maxSegments: config.bot.maxReplySegments,
            });

            if (chunks.length === 0) {
                logger.warn('模型返回内容为空，跳过发送');
                return;
            }

            for (let index = 0; index < chunks.length; index += 1) {
                const chunk = chunks[index];

                if (chunk === undefined) {
                    continue;
                }

                const out: AnyMessageSegment[] = [];

                if (index === 0 && config.bot.replyQuote) {
                    out.push(segments.reply(parsed.messageId));
                }

                if (config.bot.atSender) {
                    out.push(segments.at(parsed.userId));
                    out.push(segments.text(' '));
                }

                out.push(segments.text(chunk));

                await this.send(parsed.groupId, out);

                if (index < chunks.length - 1 && config.bot.chunkDelayMs > 0) {
                    await this.sleep(config.bot.chunkDelayMs);
                }
            }

            this.options.store.appendAssistant(parsed.groupId, result.text);
            logger.info(
                `回复完成 群=${parsed.groupId} 分片=${chunks.length} 字数=${result.text.length} 耗时=${Date.now() - startedAt}ms`,
            );
            this.options.onActivity?.({
                type: 'reply',
                groupId: parsed.groupId,
                elapsedMs: Date.now() - startedAt,
            });
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);

            logger.error(`回复失败 群=${parsed.groupId}`, error);
            this.options.onActivity?.({
                type: 'error',
                groupId: parsed.groupId,
                elapsedMs: Date.now() - startedAt,
            });

            if (config.bot.notifyOnError) {
                try {
                    await this.options.sender.sendGroupMessage(parsed.groupId, [
                        segments.text('刚才走神了，稍后再试一次吧。'),
                    ]);
                } catch (sendError) {
                    logger.error('发送错误提示也失败了', sendError);
                }
            }

            logger.debug(`失败原因：${reason}`);
        }
    }

    private async buildPrompt(
        groupId: number,
        snapshot: ChatMessage[],
        images: readonly string[],
    ): Promise<{ messages: ChatMessage[]; withImages: boolean }> {
        const config = this.options.config.value;
        const systemTemplate = this.options.prompts.systemFor(groupId);
        const system = systemTemplate
            .replace(/\{botName\}/g, config.bot.name)
            .replace(/\{groupId\}/g, String(groupId))
            .replace(/\{triggerMarker\}/g, config.bot.triggerMarker);
        const messages: ChatMessage[] = [{ role: 'system', content: system }, ...snapshot];

        // 整个请求（系统提示词 + 历史）都不超过 context.maxTokens，超出就从最旧的问答对开始丢。
        while (messages.length > 2 && estimateChatTokens(messages) > config.context.maxTokens) {
            messages.splice(1, 1);

            while (messages.length > 2 && messages[1]?.role === 'assistant') {
                messages.splice(1, 1);
            }
        }

        // 给「正在问你的那条」打标记：群里其他人的提问只是背景，不能抢答。
        this.markTrigger(messages, config.bot.triggerMarker);

        if (images.length === 0 || !config.vision.enabled) {
            return { messages, withImages: false };
        }

        const parts = await buildImageParts(images, {
            config: config.vision,
            logger: this.options.logger,
        });

        if (parts.length === 0) {
            return { messages, withImages: false };
        }

        const lastIndex = messages.length - 1;
        const last = messages[lastIndex];

        if (!last || last.role !== 'user') {
            return { messages, withImages: false };
        }

        messages[lastIndex] = {
            role: 'user',
            content: [{ type: 'text', text: contentText(last.content) }, ...parts],
        };

        // 图片也占 token，挂上之后重新压一次预算（从最旧的历史开始丢）。
        while (messages.length > 2 && estimateChatTokens(messages) > config.context.maxTokens) {
            messages.splice(1, 1);

            while (messages.length > 2 && messages[1]?.role === 'assistant') {
                messages.splice(1, 1);
            }
        }

        this.options.logger.info(`附带图片 ${parts.length} 张发给模型`, `群=${groupId}`);

        return { messages, withImages: true };
    }

    /** 只在当前这条提问前加标记；历史里旧消息保持原样，避免出现一堆同样的前缀。 */
    private markTrigger(messages: ChatMessage[], marker: string): void {
        const label = marker.trim();

        if (label.length === 0) {
            return;
        }

        const index = messages.length - 1;
        const last = messages[index];

        if (!last || last.role !== 'user') {
            return;
        }

        const text = contentText(last.content);

        if (text.startsWith(label)) {
            return;
        }

        messages[index] = { role: 'user', content: `${label} ${text}` };
    }

    private async handleCommand(parsed: ParsedGroupMessage): Promise<boolean> {
        const match = COMMAND_PATTERN.exec(parsed.text.trim());

        if (!match) {
            return false;
        }

        const name = (match[1] ?? '').toLowerCase();
        const config = this.options.config.value;
        const isOwner = config.bot.owners.includes(parsed.userId);

        if (name === 'ping') {
            await this.sendText(parsed, `pong · 在线 · 群 ${parsed.groupId}`);
            return true;
        }

        if (name === 'face') {
            const summary = (match[2] ?? '').trim();
            const known = this.options.faces?.list() ?? [];

            if (summary.length === 0) {
                const listed = known.length > 0 ? known.slice(-10).join('、') : '（暂无）';

                await this.sendText(parsed, `用法：/face 表情名。已学到：${listed}`);
                return true;
            }

            const found = this.options.faces?.get(summary);

            if (!found) {
                await this.sendText(parsed, `还没学到「${summary}」。让它被发一次就会自动记住。`);
                return true;
            }

            const faceSegments = buildAutoReplySegments(
                { userIds: [], groupIds: [], face: summary, cooldownSeconds: 0, probability: 1 },
                found,
                { maxImageBytes: config.vision.maxBytes, logger: this.options.logger },
            );

            if (faceSegments) {
                await this.send(parsed.groupId, faceSegments);
            }

            return true;
        }

        if (name === 'help') {
            await this.sendText(parsed, HELP_TEXT);
            return true;
        }

        if (name !== 'reset' && name !== 'reload') {
            return false;
        }

        if (!isOwner) {
            this.options.logger.debug(`非管理员尝试执行 /${name}`, `user=${parsed.userId}`);
            await this.sendText(parsed, '这个命令只有机器人管理员能用。');
            return true;
        }

        if (name === 'reset') {
            this.options.store.clear(parsed.groupId);
            await this.sendText(parsed, '本群上下文已清空。');
            this.options.logger.info(`管理员清空了群 ${parsed.groupId} 的上下文`);
            return true;
        }

        try {
            this.options.config.reload();
            this.options.prompts.reload?.();
            await this.sendText(parsed, '配置与提示词已重新加载。');
            this.options.logger.info('配置与提示词已通过 /reload 重新加载');
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            this.options.logger.error('重新加载失败', error);
            await this.sendText(parsed, `重新加载失败：${reason}`);
        }

        return true;
    }

    /** 统一出口：记下发出的 message_id，后续识别「引用回复机器人」用。 */
    private async send(groupId: number, message: AnyMessageSegment[]): Promise<void> {
        const result = await this.options.sender.sendGroupMessage(groupId, message);
        const messageId = (result as { message_id?: unknown } | null | undefined)?.message_id;

        if (typeof messageId === 'number') {
            const ids = this.sentIds.get(groupId) ?? [];

            ids.push(messageId);

            if (ids.length > 100) {
                ids.splice(0, ids.length - 100);
            }

            this.sentIds.set(groupId, ids);
        }
    }

    private isOwnMessage(groupId: number, messageId: number): boolean {
        return this.sentIds.get(groupId)?.includes(messageId) ?? false;
    }

    private async sendText(parsed: ParsedGroupMessage, text: string): Promise<void> {
        try {
            await this.send(parsed.groupId, [segments.text(text)]);
        } catch (error) {
            this.options.logger.error('发送消息失败', error);
        }
    }

    /** 去重键带上群号：不同群里出现相同 message_id 时互不影响。 */
    private isDuplicate(groupId: number, messageId: number): boolean {
        const key = `${groupId}:${messageId}`;

        if (this.seenMessageKeys.has(key)) {
            return true;
        }

        this.seenMessageKeys.add(key);
        this.seenOrder.push(key);

        if (this.seenOrder.length > 1_000) {
            const oldest = this.seenOrder.shift();

            if (oldest !== undefined) {
                this.seenMessageKeys.delete(oldest);
            }
        }

        return false;
    }

    /** 同一个群串行处理，保证上下文与回复顺序稳定；不同群互不阻塞。 */
    private enqueue(groupId: number, task: () => Promise<void>): Promise<void> {
        const previous = this.queues.get(groupId) ?? Promise.resolve();
        const next = previous.then(task, task);

        this.queues.set(groupId, next);
        void next.finally(() => {
            if (this.queues.get(groupId) === next) {
                this.queues.delete(groupId);
            }
        });

        return next;
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








