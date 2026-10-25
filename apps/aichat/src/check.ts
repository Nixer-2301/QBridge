import { SnowLumaWebSocketClient } from '@snowluma/sdk';
import type { ConfigStore } from './config.ts';
import { LlmClient } from './llm/client.ts';
import type { Logger } from './logger.ts';
import { PromptStore } from './prompt/store.ts';

export interface PreflightItem {
    label: string;
    ok: boolean;
    detail: string;
}

const ONEBOT_TIMEOUT_MS = 8_000;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
    return Promise.race([
        promise,
        new Promise<never>((_resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(`${label} 超时（${ms}ms）`)), ms);
            timer.unref?.();
        }),
    ]);
}

/**
 * `--check` 预检：配置 → 提示词 → OneBot 连接 → 模型探针。
 * 部署到服务器后先跑这一步，能在等群消息之前定位问题。
 */
export async function runPreflight(options: {
    config: ConfigStore;
    configPath: string;
    baseDir: string;
    logger: Logger;
}): Promise<PreflightItem[]> {
    const settings = options.config.value;
    const items: PreflightItem[] = [];

    items.push({
        label: '配置文件',
        ok: true,
        detail: options.configPath,
    });

    try {
        const prompts = new PromptStore({
            config: settings.prompt,
            baseDir: options.baseDir,
            logger: options.logger.child('prompt'),
        });

        items.push({
            label: '提示词',
            ok: true,
            detail:
                prompts.overrides.length > 0
                    ? `${settings.prompt.main} + ${prompts.overrides.join(', ')}`
                    : `${settings.prompt.main}（无群专属）`,
        });
        prompts.close();
    } catch (error) {
        items.push({
            label: '提示词',
            ok: false,
            detail: error instanceof Error ? error.message : String(error),
        });
    }

    const client = new SnowLumaWebSocketClient({
        url: settings.onebot.url,
        ...(settings.onebot.accessToken ? { accessToken: settings.onebot.accessToken } : {}),
        requestTimeoutMs: ONEBOT_TIMEOUT_MS,
        reconnect: false,
    });

    try {
        await withTimeout(client.connect(), ONEBOT_TIMEOUT_MS, '连接 OneBot');
        const login = await withTimeout(client.getLoginInfo(), ONEBOT_TIMEOUT_MS, '读取账号信息');

        items.push({
            label: 'OneBot',
            ok: true,
            detail: `${settings.onebot.url} → ${login.nickname}(${login.user_id})`,
        });
    } catch (error) {
        items.push({
            label: 'OneBot',
            ok: false,
            detail: `${settings.onebot.url}：${error instanceof Error ? error.message : String(error)}`,
        });
    } finally {
        client.close(1_000, 'preflight');
    }

    const startedAt = Date.now();
    const llm = new LlmClient({
        getConfig: () => options.config.value.llm,
        logger: options.logger.child('llm'),
    });

    try {
        const result = await withTimeout(
            llm.chat([{ role: 'user', content: '只回复两个字：在的' }]),
            30_000,
            '模型探针',
        );

        items.push({
            label: '模型',
            ok: true,
            detail: `${settings.llm.model} @ ${settings.llm.baseUrl}（${Date.now() - startedAt}ms，回复「${result.text.slice(0, 20)}」）`,
        });
    } catch (error) {
        items.push({
            label: '模型',
            ok: false,
            detail: `${settings.llm.model} @ ${settings.llm.baseUrl}：${error instanceof Error ? error.message : String(error)}`,
        });
    }

    items.push({
        label: '图片输入',
        ok: true,
        detail: settings.vision.enabled
            ? `已开启（最多 ${settings.vision.maxImages} 张 / ${Math.round(settings.vision.maxBytes / 1024)} KB）`
            : '已关闭',
    });

    if (settings.github.enabled && settings.github.targets.length > 0) {
        try {
            const token = settings.github.token;

            for (const target of settings.github.targets) {
                const response = await withTimeout(
                    fetch(`https://api.github.com/repos/${target.repo}`, {
                        headers: {
                            'user-agent': 'qbridge-aichat',
                            accept: 'application/vnd.github+json',
                            ...(token ? { authorization: `Bearer ${token}` } : {}),
                        },
                    }),
                    15_000,
                    'GitHub 检查',
                );

                if (!response.ok) {
                    throw new Error(`${target.repo} → HTTP ${response.status}`);
                }
            }

            items.push({
                label: 'GitHub',
                ok: true,
                detail: settings.github.targets
                    .map((target) => `${target.repo}（${target.kinds.join('+')}→${target.groupIds.join(',')}）`)
                    .join(' '),
            });
        } catch (error) {
            items.push({
                label: 'GitHub',
                ok: false,
                detail: error instanceof Error ? error.message : String(error),
            });
        }
    }

    return items;
}

/** 以纯文本表格输出预检结果，返回是否全部通过。 */
export function formatPreflight(items: readonly PreflightItem[]): { text: string; ok: boolean } {
    const width = Math.max(...items.map((item) => item.label.length));
    const lines = items.map(
        (item) => `  ${item.ok ? '[ OK ]' : '[FAIL]'} ${item.label.padEnd(width)}  ${item.detail}`,
    );
    const failed = items.filter((item) => !item.ok).length;
    const summary = failed === 0 ? '预检通过，可以启动。' : `预检有 ${failed} 项失败，请先修复上面标记 [FAIL] 的项。`;

    return { text: [...lines, '', `  ${summary}`].join('\n'), ok: failed === 0 };
}
