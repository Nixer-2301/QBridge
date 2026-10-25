import fs from 'node:fs';
import path from 'node:path';
import type { GroupSender } from '../chat/service.ts';
import { splitReply } from '../chat/chunk.ts';
import type { Logger } from '../logger.ts';
import type { GithubConfig, GithubKind, GithubTargetConfig } from '../types.ts';

const API_ROOT = 'https://api.github.com';
const USER_AGENT = 'qbridge-aichat';
const BODY_LIMIT = 500;
const MIN_INTERVAL_SECONDS = 60;

export const DEFAULT_RELEASE_TEMPLATE = [
    '🐙Github检测到Release',
    '{repo}',
    '',
    '🏷[{tag}]',
    '{title}',
    '{body}',
    '提交者：{author}',
    '',
    '{url}',
    '---',
].join('\n');

export const DEFAULT_COMMIT_TEMPLATE = [
    '🐙Github检测到提交',
    '{repo}',
    '',
    '📝{title}',
    '{body}',
    '提交者：{author}',
    '',
    '{url}',
    '---',
].join('\n');

export interface GithubEventState {
    /** `${repo}:${kind}` -> 最近一次已处理的事件 id */
    [key: string]: string;
}

export interface RenderValues {
    [key: string]: string;
}

interface ReleasePayload {
    id: number | string;
    tag_name?: string;
    name?: string;
    body?: string;
    html_url?: string;
    prerelease?: boolean;
    author?: { login?: string };
}

interface CommitPayload {
    sha?: string;
    html_url?: string;
    commit?: {
        message?: string;
        author?: { name?: string; date?: string };
    };
    author?: { login?: string } | null;
}

export interface LatestEvent {
    kind: GithubKind;
    id: string;
    values: RenderValues;
}

export interface GithubWatcherOptions {
    config: GithubConfig;
    sender: GroupSender;
    logger: Logger;
    /** 状态文件绝对路径 */
    statePath: string;
    maxReplyChars: number;
    fetchImpl?: typeof fetch;
    sleep?: (ms: number) => Promise<void>;
}

function truncate(text: string, limit = BODY_LIMIT): string {
    const trimmed = text.replace(/\r\n/g, '\n').trim();

    if (trimmed.length <= limit) {
        return trimmed;
    }

    return `${trimmed.slice(0, limit)}…`;
}

/** 把模板里的 {占位符} 替换掉；未知占位符原样保留，方便排查拼写错误。 */
export function renderTemplate(template: string, values: RenderValues): string {
    return template.replace(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g, (match, key: string) =>
        key in values ? values[key] ?? '' : match,
    );
}

function releaseValues(repo: string, release: ReleasePayload): RenderValues {
    return {
        repo,
        tag: String(release.tag_name ?? ''),
        title: String(release.name ?? release.tag_name ?? ''),
        body: truncate(String(release.body ?? '(无更新说明)')),
        author: String(release.author?.login ?? 'unknown'),
        url: String(release.html_url ?? ''),
        prerelease: release.prerelease ? 'yes' : 'no',
    };
}

function commitValues(repo: string, commit: CommitPayload): RenderValues {
    const message = String(commit.commit?.message ?? '').trim();
    const [firstLine = '', ...rest] = message.split('\n');

    return {
        repo,
        sha: String(commit.sha ?? '').slice(0, 7),
        title: firstLine.trim(),
        body: truncate(rest.join('\n').trim() || '(无提交说明)'),
        author: String(commit.author?.login ?? commit.commit?.author?.name ?? 'unknown'),
        url: String(commit.html_url ?? ''),
        date: String(commit.commit?.author?.date ?? ''),
    };
}

export function templateFor(target: GithubTargetConfig, kind: GithubKind): string {
    const custom = target.template?.[kind];

    if (custom && custom.trim().length > 0) {
        return custom;
    }

    return kind === 'release' ? DEFAULT_RELEASE_TEMPLATE : DEFAULT_COMMIT_TEMPLATE;
}

export function stateKey(repo: string, kind: GithubKind): string {
    return `${repo}:${kind}`;
}

export function readState(filePath: string): GithubEventState {
    try {
        const raw = fs.readFileSync(filePath, 'utf8');
        const parsed = JSON.parse(raw) as unknown;

        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            const state: GithubEventState = {};

            for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
                if (typeof value === 'string') {
                    state[key] = value;
                }
            }

            return state;
        }
    } catch {
        // 文件不存在或损坏：从空状态开始，下一次检查会记录当前事件而不补发。
    }

    return {};
}

export function writeState(filePath: string, state: GithubEventState): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(state, null, 4)}\n`, 'utf8');
}

/**
 * 轮询 GitHub 仓库，发现新的 Release / 提交就发到指定群。
 * 首次运行只记录当前状态（除非 `postExisting: true`），避免把历史事件刷进群。
 */
export class GithubWatcher {
    private readonly options: GithubWatcherOptions;
    private readonly fetchImpl: typeof fetch;
    private readonly sleep: (ms: number) => Promise<void>;
    private timer: ReturnType<typeof setInterval> | undefined;
    private running = false;

    constructor(options: GithubWatcherOptions) {
        this.options = options;
        this.fetchImpl = options.fetchImpl ?? fetch;
        this.sleep =
            options.sleep ??
            ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    }

    get intervalSeconds(): number {
        return Math.max(MIN_INTERVAL_SECONDS, this.options.config.intervalSeconds);
    }

    start(): void {
        const { config, logger } = this.options;

        if (!config.enabled || config.targets.length === 0) {
            logger.debug('GitHub 监听未启用');

            return;
        }

        if (this.timer) {
            return;
        }

        logger.info(
            `GitHub 监听已启动（每 ${this.intervalSeconds}s）`,
            config.targets.map((target) => `${target.repo}→${target.groupIds.join(',')}`).join(' '),
        );

        void this.checkOnce();
        this.timer = setInterval(() => {
            void this.checkOnce();
        }, this.intervalSeconds * 1_000);
        this.timer.unref?.();
    }

    stop(): void {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = undefined;
        }
    }

    /** 跑一轮检查；重复调用会被跳过，避免上一轮还没结束就并发打 API。 */
    async checkOnce(): Promise<void> {
        if (this.running) {
            return;
        }

        this.running = true;

        try {
            for (const target of this.options.config.targets) {
                for (const kind of target.kinds) {
                    await this.checkTarget(target, kind);
                }
            }
        } finally {
            this.running = false;
        }
    }

    private async checkTarget(target: GithubTargetConfig, kind: GithubKind): Promise<void> {
        const { logger, config } = this.options;

        try {
            const latest = await this.fetchLatest(target.repo, kind);

            if (!latest) {
                logger.debug(`没有可用的 ${kind} 数据`, target.repo);

                return;
            }

            const state = readState(this.options.statePath);
            const key = stateKey(target.repo, kind);
            const previous = state[key];

            if (previous === latest.id) {
                return;
            }

            if (previous === undefined && !config.postExisting) {
                state[key] = latest.id;
                writeState(this.options.statePath, state);
                logger.info(`已记录 ${target.repo} 当前 ${kind}（不补发历史）`, latest.id);

                return;
            }

            await this.publish(target, kind, latest);

            state[key] = latest.id;
            writeState(this.options.statePath, state);
        } catch (error) {
            logger.warn(
                `检查 ${target.repo} 的 ${kind} 失败`,
                error instanceof Error ? error.message : String(error),
            );
        }
    }

    private async publish(
        target: GithubTargetConfig,
        kind: GithubKind,
        latest: LatestEvent,
    ): Promise<void> {
        const text = renderTemplate(templateFor(target, kind), latest.values);
        const chunks = splitReply(text, this.options.maxReplyChars, {
            splitParagraphs: false,
            sentenceSplitAt: 0,
        });

        for (const groupId of target.groupIds) {
            for (const [index, chunk] of chunks.entries()) {
                await this.options.sender.sendGroupMessage(groupId, [
                    { type: 'text', data: { text: chunk } },
                ]);

                if (index < chunks.length - 1) {
                    await this.sleep(300);
                }
            }
        }

        this.options.logger.info(
            `已推送 ${target.repo} ${kind}`,
            `群=${target.groupIds.join(',')} id=${latest.id}`,
        );
    }

    private async headers(): Promise<Record<string, string>> {
        const headers: Record<string, string> = {
            'user-agent': USER_AGENT,
            accept: 'application/vnd.github+json',
        };

        if (this.options.config.token && this.options.config.token.length > 0) {
            headers['authorization'] = `Bearer ${this.options.config.token}`;
        }

        return headers;
    }

    private async fetchJson(url: string): Promise<unknown> {
        const response = await this.fetchImpl(url, { headers: await this.headers() });

        if (!response.ok) {
            const detail = (await response.text()).slice(0, 200);

            throw new Error(`GitHub API ${response.status}：${detail}`);
        }

        return response.json();
    }

    private async fetchLatest(repo: string, kind: GithubKind): Promise<LatestEvent | null> {
        if (kind === 'release') {
            const payload = (await this.fetchJson(
                `${API_ROOT}/repos/${repo}/releases?per_page=1`,
            )) as ReleasePayload[] | null;
            const release = Array.isArray(payload) ? payload[0] : undefined;

            if (!release) {
                return null;
            }

            return { kind, id: String(release.id), values: releaseValues(repo, release) };
        }

        const payload = (await this.fetchJson(
            `${API_ROOT}/repos/${repo}/commits?per_page=1`,
        )) as CommitPayload[] | null;
        const commit = Array.isArray(payload) ? payload[0] : undefined;

        if (!commit?.sha) {
            return null;
        }

        return { kind, id: commit.sha, values: commitValues(repo, commit) };
    }
}
