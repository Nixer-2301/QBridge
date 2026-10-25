import type { GroupSender } from '../chat/service.ts';
import type { Logger } from '../logger.ts';
import type { DeerConfig } from '../types.ts';
import type { ParsedGroupMessage } from '../qq/segments.ts';
import { renderDeerCardPng } from './card.ts';
import { dayKey } from './store.ts';
import type { DeerStore } from './store.ts';

export interface DeerHandler {
    /** 返回 true 表示这条消息已被 🦌 逻辑消费，不再走模型。 */
    handle(message: ParsedGroupMessage): Promise<boolean>;
}

export interface DeerTrackerOptions {
    config: () => DeerConfig;
    store: DeerStore;
    sender: GroupSender;
    logger: Logger;
    fontPath: string;
    now?: () => Date;
}

const SHOW_COMMAND = /^\/(?:deer|鹿)\b/i;

function startOfWeek(date: Date): Date {
    const copy = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    const offset = (copy.getDay() + 6) % 7;

    copy.setDate(copy.getDate() - offset);

    return copy;
}

/**
 * 🦌 记录：
 * - 消息里带 🦌（可配置）就记一次，120 分钟内重复只在群里提醒；
 * - 记录成功发一张「本月鹿管足迹」日历图（和参考图同款版式）；
 * - `/deer` 只看图，不计数。
 */
export class DeerTracker implements DeerHandler {
    private readonly now: () => Date;

    constructor(private readonly options: DeerTrackerOptions) {
        this.now = options.now ?? (() => new Date());
    }

    async handle(message: ParsedGroupMessage): Promise<boolean> {
        const config = this.options.config();

        if (!config.enabled) {
            return false;
        }

        if (config.groupIds.length > 0 && !config.groupIds.includes(message.groupId)) {
            return false;
        }

        const text = message.text;
        const showOnly = SHOW_COMMAND.test(text.trim());

        if (!showOnly && !text.includes(config.emoji)) {
            return false;
        }

        const at = this.now();

        if (showOnly) {
            await this.sendCard(message, at);

            return true;
        }

        const cooldownMs = Math.max(1, config.cooldownMinutes) * 60_000;
        const last = this.options.store.lastRecordedAt(message.userId);

        if (last !== undefined && at.getTime() - last < cooldownMs) {
            const remainMinutes = Math.ceil((cooldownMs - (at.getTime() - last)) / 60_000);

            await this.reply(
                message.groupId,
                `注意身体哦，${config.cooldownMinutes}分钟内只能记录一次` +
                    (remainMinutes > 0 ? `（还剩 ${remainMinutes} 分钟）` : ''),
            );
            this.options.logger.info(
                `🦌 冷却中 群=${message.groupId} 用户=${message.senderName}(${message.userId}) 剩余${remainMinutes}分钟`,
            );

            return true;
        }

        this.options.store.insert({
            userId: message.userId,
            groupId: message.groupId,
            name: message.senderName,
            day: dayKey(at),
            at: at.getTime(),
        });

        const today = this.options.store.countOnDay(message.userId, dayKey(at));

        this.options.logger.info(
            `🦌 记录成功 群=${message.groupId} 用户=${message.senderName}(${message.userId}) 今日第${today}次`,
        );

        await this.sendCard(message, at);

        return true;
    }

    private async sendCard(message: ParsedGroupMessage, at: Date): Promise<void> {
        const config = this.options.config();
        const monthStart = new Date(at.getFullYear(), at.getMonth(), 1);
        const monthEnd = new Date(at.getFullYear(), at.getMonth() + 1, 0);
        const weekStart = startOfWeek(at);
        const weekEnd = new Date(weekStart.getFullYear(), weekStart.getMonth(), weekStart.getDate() + 6);

        const monthRows = this.options.store.countsByDay(
            message.userId,
            dayKey(monthStart),
            dayKey(monthEnd),
        );
        const counts = new Map<number, number>();

        for (const row of monthRows) {
            const dayNumber = Number(row.day.slice(8, 10));

            counts.set(dayNumber, row.count);
        }

        const weekRows = this.options.store.countsByDay(message.userId, dayKey(weekStart), dayKey(weekEnd));
        const weekCounts = Array.from({ length: 7 }, () => 0);

        for (const row of weekRows) {
            const date = new Date(`${row.day}T00:00:00`);
            const index = Math.round((date.getTime() - weekStart.getTime()) / 86_400_000);

            if (index >= 0 && index < 7) {
                weekCounts[index] = row.count;
            }
        }

        const monthTotal = this.options.store.totalBetween(
            message.userId,
            dayKey(monthStart),
            dayKey(monthEnd),
        );

        try {
            const png = await renderDeerCardPng(
                {
                    name: message.senderName,
                    now: at,
                    counts,
                    weekCounts,
                    monthTotal,
                    todayCount: counts.get(at.getDate()) ?? 0,
                },
                { fontPath: this.options.fontPath },
            );

            await this.options.sender.sendGroupMessage(message.groupId, [
                { type: 'image', data: { file: `base64://${png.toString('base64')}` } },
            ]);
        } catch (error) {
            this.options.logger.error('🦌 卡片渲染/发送失败', error);
            await this.reply(
                message.groupId,
                `🦌 已记录（本月累计 ${monthTotal} 次），但日历图片生成失败`,
            );
        }

        // 冷却提示里用到的配置只读一次，避免热重载时行为不一致。
        void config;
    }

    private async reply(groupId: number, text: string): Promise<void> {
        try {
            await this.options.sender.sendGroupMessage(groupId, [{ type: 'text', data: { text } }]);
        } catch (error) {
            this.options.logger.error('🦌 文字回复失败', error);
        }
    }
}
