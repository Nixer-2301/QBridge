import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createLogger } from '../src/logger.ts';
import type { GithubConfig } from '../src/types.ts';
import {
    DEFAULT_COMMIT_TEMPLATE,
    DEFAULT_RELEASE_TEMPLATE,
    GithubWatcher,
    readState,
    renderTemplate,
    stateKey,
} from '../src/watch/github.ts';

const logger = createLogger('test', 'silent');
const dirs: string[] = [];

function tempDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-github-'));

    dirs.push(dir);

    return dir;
}

afterEach(() => {
    while (dirs.length > 0) {
        const dir = dirs.pop();

        if (dir) {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    }
});

function config(overrides: Partial<GithubConfig> = {}): GithubConfig {
    return {
        enabled: true,
        intervalSeconds: 60,
        stateFile: 'data/github-state.json',
        postExisting: false,
        targets: [{ repo: 'rikkahub/rikkahub', groupIds: [628101497], kinds: ['release'] }],
        ...overrides,
    };
}

function releaseResponse(tag: string, id: number) {
    return {
        ok: true,
        status: 200,
        json: async () => [
            {
                id,
                tag_name: tag,
                name: `Release ${tag}`,
                body: '修复了一些问题\n新增了功能',
                html_url: `https://github.com/rikkahub/rikkahub/releases/tag/${tag}`,
                author: { login: 're-ovo' },
            },
        ],
        text: async () => '',
    } as unknown as Response;
}

function commitResponse(sha: string) {
    return {
        ok: true,
        status: 200,
        json: async () => [
            {
                sha,
                html_url: `https://github.com/rikkahub/rikkahub/commit/${sha}`,
                commit: {
                    message: 'feat: 新增语音输入\n\n支持长按录音',
                    author: { name: 're-ovo', date: '2026-10-24T11:56:07Z' },
                },
                author: { login: 're-ovo' },
            },
        ],
        text: async () => '',
    } as unknown as Response;
}

function createWatcher(
    cfg: GithubConfig,
    replies: Response[],
    sent: { groupId: number; text: string }[],
): { watcher: GithubWatcher; statePath: string } {
    const statePath = path.join(tempDir(), 'state.json');
    let index = 0;

    const watcher = new GithubWatcher({
        config: cfg,
        sender: {
            sendGroupMessage: async (groupId, message) => {
                const text = message
                    .filter((segment) => segment.type === 'text')
                    .map((segment) => (segment.data as { text: string }).text)
                    .join('');

                sent.push({ groupId, text });

                return {};
            },
        },
        logger,
        statePath,
        maxReplyChars: 1_200,
        fetchImpl: (async () => {
            const response = replies[Math.min(index, replies.length - 1)];

            index += 1;

            if (!response) {
                throw new Error('no fake response');
            }

            return response;
        }) as unknown as typeof fetch,
        sleep: async () => {},
    });

    return { watcher, statePath };
}

describe('renderTemplate', () => {
    it('替换已知占位符，未知的保留原样', () => {
        const result = renderTemplate('{repo} 🏷[{tag}] {missing}', {
            repo: 'rikkahub/rikkahub',
            tag: '3.1.1',
        });

        expect(result).toBe('rikkahub/rikkahub 🏷[3.1.1] {missing}');
    });

    it('默认模板包含 Release 标题与分隔线', () => {
        expect(DEFAULT_RELEASE_TEMPLATE).toContain('🐙Github检测到Release');
        expect(DEFAULT_RELEASE_TEMPLATE.trimEnd().endsWith('---')).toBe(true);
        expect(DEFAULT_COMMIT_TEMPLATE).toContain('🐙Github检测到提交');
    });
});

describe('GithubWatcher', () => {
    it('首次运行只记录状态，不补发历史', async () => {
        const sent: { groupId: number; text: string }[] = [];
        const { watcher, statePath } = createWatcher(config(), [releaseResponse('3.1.1', 422706111)], sent);

        await watcher.checkOnce();

        expect(sent).toEqual([]);

        const state = readState(statePath);

        expect(state[stateKey('rikkahub/rikkahub', 'release')]).toBe('422706111');
    });

    it('出现新 Release 时发到指定群', async () => {
        const sent: { groupId: number; text: string }[] = [];
        const { watcher } = createWatcher(
            config(),
            [releaseResponse('3.1.1', 1), releaseResponse('3.1.1', 1), releaseResponse('3.2.0', 2)],
            sent,
        );

        await watcher.checkOnce();
        await watcher.checkOnce();
        await watcher.checkOnce();

        expect(sent).toHaveLength(1);
        expect(sent[0]?.groupId).toBe(628101497);
        expect(sent[0]?.text).toContain('🐙Github检测到Release');
        expect(sent[0]?.text).toContain('🏷[3.2.0]');
        expect(sent[0]?.text).toContain('提交者：re-ovo');
        expect(sent[0]?.text).toContain('releases/tag/3.2.0');
    });

    it('同一个事件不会重复推送', async () => {
        const sent: { groupId: number; text: string }[] = [];
        const { watcher } = createWatcher(
            config(),
            [releaseResponse('3.1.1', 1), releaseResponse('3.1.1', 1)],
            sent,
        );

        await watcher.checkOnce();
        await watcher.checkOnce();
        await watcher.checkOnce();

        expect(sent).toHaveLength(0);
    });

    it('postExisting=true 时首次运行就推送当前事件', async () => {
        const sent: { groupId: number; text: string }[] = [];
        const { watcher } = createWatcher(
            config({ postExisting: true }),
            [releaseResponse('3.1.1', 1)],
            sent,
        );

        await watcher.checkOnce();

        expect(sent).toHaveLength(1);
    });

    it('支持监听提交并渲染提交模板', async () => {
        const sent: { groupId: number; text: string }[] = [];
        const { watcher } = createWatcher(
            config({
                targets: [{ repo: 'rikkahub/rikkahub', groupIds: [628101497], kinds: ['commit'] }],
            }),
            [commitResponse('aaaaaaaaaaaa'), commitResponse('aaaaaaaaaaaa'), commitResponse('bbbbbbbbbbbb')],
            sent,
        );

        await watcher.checkOnce();
        await watcher.checkOnce();
        await watcher.checkOnce();

        expect(sent).toHaveLength(1);
        expect(sent[0]?.text).toContain('🐙Github检测到提交');
        expect(sent[0]?.text).toContain('feat: 新增语音输入');
        expect(sent[0]?.text).toContain('bbbbbbb');
    });

    it('多群同时推送', async () => {
        const sent: { groupId: number; text: string }[] = [];
        const { watcher } = createWatcher(
            config({
                postExisting: true,
                targets: [
                    { repo: 'rikkahub/rikkahub', groupIds: [111, 222], kinds: ['release'] },
                ],
            }),
            [releaseResponse('3.1.1', 1)],
            sent,
        );

        await watcher.checkOnce();

        expect(sent.map((item) => item.groupId)).toEqual([111, 222]);
    });

    it('自定义模板生效', async () => {
        const sent: { groupId: number; text: string }[] = [];
        const { watcher } = createWatcher(
            config({
                postExisting: true,
                targets: [
                    {
                        repo: 'rikkahub/rikkahub',
                        groupIds: [628101497],
                        kinds: ['release'],
                        template: { release: '新版本 {tag} by {author} {url}' },
                    },
                ],
            }),
            [releaseResponse('9.9.9', 1)],
            sent,
        );

        await watcher.checkOnce();

        expect(sent[0]?.text).toBe(
            '新版本 9.9.9 by re-ovo https://github.com/rikkahub/rikkahub/releases/tag/9.9.9',
        );
    });

    it('API 失败只打日志，不影响后续轮询', async () => {
        const sent: { groupId: number; text: string }[] = [];
        const failure = {
            ok: false,
            status: 403,
            text: async () => 'rate limited',
        } as unknown as Response;

        const { watcher } = createWatcher(config(), [failure, releaseResponse('3.1.1', 1)], sent);

        await expect(watcher.checkOnce()).resolves.toBeUndefined();
        expect(sent).toEqual([]);
    });

    it('未启用时不启动定时器', () => {
        const sent: { groupId: number; text: string }[] = [];
        const { watcher } = createWatcher(config({ enabled: false }), [releaseResponse('1', 1)], sent);

        watcher.start();
        watcher.stop();

        expect(sent).toEqual([]);
    });

    it('长说明会被截断', async () => {
        const sent: { groupId: number; text: string }[] = [];
        const longBody = '很长的说明'.repeat(200);
        const response = {
            ok: true,
            status: 200,
            json: async () => [
                {
                    id: 5,
                    tag_name: '1.0.0',
                    name: '1.0.0',
                    body: longBody,
                    html_url: 'https://example.com',
                    author: { login: 'x' },
                },
            ],
            text: async () => '',
        } as unknown as Response;

        const { watcher } = createWatcher(config({ postExisting: true }), [response], sent);

        await watcher.checkOnce();

        expect(sent[0]?.text).toContain('…');
        expect(sent[0]?.text.length).toBeLessThan(longBody.length);
    });
});

