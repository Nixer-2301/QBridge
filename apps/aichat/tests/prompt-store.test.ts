import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createLogger } from '../src/logger.ts';
import { PromptError, PromptStore } from '../src/prompt/store.ts';
import type { PromptConfig } from '../src/types.ts';

const logger = createLogger('test', 'silent');
const dirs: string[] = [];

function tempDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-prompt-'));

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

function write(root: string, relative: string, content: string): void {
    const file = path.join(root, relative);

    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, 'utf8');
}

function createStore(
    initial: Partial<PromptConfig> = {},
    options: { legacySystem?: string; files?: Record<string, string> } = {},
): PromptStore {
    const root = tempDir();
    const config: PromptConfig = {
        dir: 'prompts',
        main: 'system.md',
        perGroup: {},
        hotReload: false,
        ...initial,
        ...(options.legacySystem ? { system: options.legacySystem } : {}),
    };

    for (const [relative, content] of Object.entries(options.files ?? {})) {
        write(path.join(root, 'prompts'), relative, content);
    }

    return new PromptStore({ config, baseDir: root, logger });
}

describe('PromptStore', () => {
    it('读取主提示词文件', () => {
        const store = createStore({}, { files: { 'system.md': '你是测试助手。' } });

        expect(store.systemFor(100)).toBe('你是测试助手。');
        expect(store.mainPath.endsWith('system.md')).toBe(true);
    });

    it('按群号自动匹配 groups/<群号>.md', () => {
        const store = createStore(
            {},
            {
                files: {
                    'system.md': '通用人设',
                    'groups/123456.md': '只聊游戏',
                },
            },
        );

        expect(store.systemFor(123456)).toBe('只聊游戏');
        expect(store.systemFor(999)).toBe('通用人设');
        expect(store.overrides).toEqual(['groups/123456.md']);
    });

    it('显式 perGroup 配置优先于命名约定', () => {
        const store = createStore(
            { perGroup: { '123456': 'team/ai.md' } },
            {
                files: {
                    'system.md': '通用人设',
                    'groups/123456.md': '约定文件',
                    'team/ai.md': '显式指定',
                },
            },
        );

        expect(store.systemFor(123456)).toBe('显式指定');
    });

    it('展开 {{include:...}} 片段', () => {
        const store = createStore(
            {},
            {
                files: {
                    'system.md': '你是助手。\n\n{{include:rules.md}}\n',
                    'rules.md': '1. 简短回答\n2. 不编造',
                },
            },
        );

        const prompt = store.systemFor(1);

        expect(prompt).toContain('你是助手。');
        expect(prompt).toContain('1. 简短回答');
        expect(prompt).toContain('2. 不编造');
        expect(prompt).not.toContain('{{include');
    });

    it('支持多级 include', () => {
        const store = createStore(
            {},
            {
                files: {
                    'system.md': 'A {{include:a.md}}',
                    'a.md': 'B {{include:b.md}}',
                    'b.md': 'C',
                },
            },
        );

        expect(store.systemFor(1)).toBe('A B C');
    });

    it('include 循环会报错并指出链路', () => {
        // 构造时就会解析主提示词，循环应当立即失败而不是等到第一次回复。
        expect(() =>
            createStore(
                {},
                {
                    files: {
                        'system.md': '{{include:a.md}}',
                        'a.md': '{{include:system.md}}',
                    },
                },
            ),
        ).toThrow(/循环：system\.md -> a\.md -> system\.md/);
    });

    it('拒绝跳出 prompts 目录的路径', () => {
        expect(() => createStore({ main: '../../etc/passwd' }, { files: { 'system.md': 'x' } })).toThrow(
            PromptError,
        );
    });

    it('拒绝绝对路径', () => {
        expect(() => createStore({ main: 'C:/Windows/win.ini' })).toThrow(/相对路径|目录之外/);
    });

    it('主提示词缺失时按内置默认值生成', () => {
        const store = createStore();

        expect(fs.existsSync(store.mainPath)).toBe(true);
        expect(store.systemFor(1).length).toBeGreaterThan(20);
    });

    it('主提示词缺失时可以继承配置里的旧 system 字段', () => {
        const store = createStore({}, { legacySystem: '旧配置里的提示词' });

        expect(fs.existsSync(store.mainPath)).toBe(true);
        expect(store.systemFor(1)).toBe('旧配置里的提示词\n');
    });

    it('reload 后读取文件的新内容', () => {
        const root = tempDir();
        const config: PromptConfig = { dir: 'prompts', main: 'system.md', perGroup: {}, hotReload: false };

        write(path.join(root, 'prompts'), 'system.md', '第一版');
        const store = new PromptStore({ config, baseDir: root, logger });

        expect(store.systemFor(1)).toBe('第一版');

        write(path.join(root, 'prompts'), 'system.md', '第二版');
        expect(store.systemFor(1)).toBe('第一版');

        store.reload();
        expect(store.systemFor(1)).toBe('第二版');
    });

    it('新出现的群专属文件无需 reload 即可命中', () => {
        const root = tempDir();
        const config: PromptConfig = { dir: 'prompts', main: 'system.md', perGroup: {}, hotReload: false };

        write(path.join(root, 'prompts'), 'system.md', '通用');
        const store = new PromptStore({ config, baseDir: root, logger });

        expect(store.systemFor(555)).toBe('通用');

        write(path.join(root, 'prompts'), 'groups/555.md', '专属');
        expect(store.systemFor(555)).toBe('专属');
    });

    it('兼容 CRLF 与 BOM', () => {
        const store = createStore({}, { files: { 'system.md': '\uFEFF第一行\r\n第二行\r\n' } });

        expect(store.systemFor(1)).toBe('第一行\n第二行\n');
    });

    it('空提示词文件会报错而不是静默发送空系统消息', () => {
        expect(() => createStore({}, { files: { 'system.md': '   \n\n' } })).toThrow(/内容为空/);
    });

    it('groups 下的非数字文件名被忽略', () => {
        const store = createStore(
            {},
            {
                files: {
                    'system.md': '通用',
                    'groups/README.md': '说明',
                },
            },
        );

        expect(store.systemFor(123456)).toBe('通用');
        expect(store.overrides).toEqual([]);
    });
});



function waitFor(check: () => boolean, timeoutMs = 4_000): Promise<void> {
    return new Promise((resolve, reject) => {
        const startedAt = Date.now();

        const tick = () => {
            if (check()) {
                resolve();
                return;
            }

            if (Date.now() - startedAt > timeoutMs) {
                reject(new Error('等待超时'));
                return;
            }

            setTimeout(tick, 50);
        };

        tick();
    });
}

describe('PromptStore 热更新', () => {
    it('文件保存后自动重载，无需 /reload', async () => {
        const root = tempDir();
        const config: PromptConfig = { dir: 'prompts', main: 'system.md', perGroup: {}, hotReload: true };

        write(path.join(root, 'prompts'), 'system.md', '第一版');
        const store = new PromptStore({ config, baseDir: root, logger });

        store.watch();

        try {
            write(path.join(root, 'prompts'), 'system.md', '第二版');
            await waitFor(() => store.systemFor(1) === '第二版');
            expect(store.systemFor(1)).toBe('第二版');
        } finally {
            store.close();
        }
    });

    it('保存到一半的坏文件会保留上一版', async () => {
        const root = tempDir();
        const config: PromptConfig = { dir: 'prompts', main: 'system.md', perGroup: {}, hotReload: true };

        write(path.join(root, 'prompts'), 'system.md', '稳定版本');
        const store = new PromptStore({ config, baseDir: root, logger });

        store.watch();

        try {
            write(path.join(root, 'prompts'), 'system.md', '   ');
            await waitFor(() => false, 500).catch(() => undefined);
            expect(store.systemFor(1)).toBe('稳定版本');
        } finally {
            store.close();
        }
    });

    it('关闭热更新后不会自动重载', async () => {
        const root = tempDir();
        const config: PromptConfig = { dir: 'prompts', main: 'system.md', perGroup: {}, hotReload: false };

        write(path.join(root, 'prompts'), 'system.md', '第一版');
        const store = new PromptStore({ config, baseDir: root, logger });

        store.watch();

        try {
            write(path.join(root, 'prompts'), 'system.md', '第二版');
            await waitFor(() => false, 500).catch(() => undefined);
            expect(store.systemFor(1)).toBe('第一版');
            store.reload();
            expect(store.systemFor(1)).toBe('第二版');
        } finally {
            store.close();
        }
    });
});
