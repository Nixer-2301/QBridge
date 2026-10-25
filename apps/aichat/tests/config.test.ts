import { describe, expect, it } from 'vitest';
import { ConfigError, parseConfig, resolveConfigPath } from '../src/config.ts';

describe('parseConfig', () => {
    it('空配置也能得到可用默认值', () => {
        const config = parseConfig({}, {});

        expect(config.onebot.url).toBe('ws://127.0.0.1:3001/');
        expect(config.onebot.reconnect).toBe(true);
        expect(config.bot.name).toBe('小助手');
        expect(config.bot.trigger.requireAt).toBe(true);
        expect(config.bot.trigger.wakeWords).toEqual([]);
        expect(config.context.maxMessages).toBe(20);
        expect(config.context.maxTokens).toBe(20_000);
        expect(config.llm.baseUrl).toBe('https://api.deepseek.com/v1');
        expect(config.llm.model).toBe('deepseek-chat');
        expect(config.logging.level).toBe('info');
        expect(config.prompt.dir).toBe('prompts');
        expect(config.prompt.main).toBe('system.md');
        expect(config.prompt.perGroup).toEqual({});
        expect(config.prompt.hotReload).toBe(true);
        expect(config.bot.splitParagraphs).toBe(true);
        expect(config.bot.sentenceSplitAt).toBe(40);
        expect(config.bot.triggerMarker).toBe('@你');
        expect(config.bot.triggerOnReply).toBe(true);
        expect(config.bot.maxReplySegments).toBe(4);
        expect(config.vision).toEqual({ enabled: true, maxImages: 4, maxBytes: 5_242_880 });
        expect(config.github).toEqual({
            enabled: false,
            intervalSeconds: 300,
            stateFile: 'data/github-state.json',
            postExisting: false,
            targets: [],
        });
    });

    it('展开 ${ENV} 引用', () => {
        const config = parseConfig(
            {
                onebot: { accessToken: '${QB_TOKEN}' },
                llm: { apiKey: '${LLM_KEY}' },
            },
            { QB_TOKEN: 'token-123', LLM_KEY: 'sk-test' },
        );

        expect(config.onebot.accessToken).toBe('token-123');
        expect(config.llm.apiKey).toBe('sk-test');
    });

    it('引用未定义环境变量时报错并指出位置', () => {
        expect(() => parseConfig({ llm: { apiKey: '${MISSING_KEY}' } }, {})).toThrow(
            /config\.llm\.apiKey.*MISSING_KEY/,
        );
    });

    it('拒绝未知配置项，避免拼写错误被静默忽略', () => {
        expect(() => parseConfig({ bot: { maxReplyChar: 100 } }, {})).toThrow(/未知配置项 "maxReplyChar"/);
    });

    it('校验 URL 协议', () => {
        expect(() => parseConfig({ onebot: { url: 'http://127.0.0.1:3001' } }, {})).toThrow(
            /ws:\/\//,
        );
        expect(() => parseConfig({ llm: { baseUrl: 'ftp://x' } }, {})).toThrow(/http/);
    });

    it('校验数值范围', () => {
        expect(() => parseConfig({ context: { maxMessages: 0 } }, {})).toThrow(/maxMessages/);
        expect(() => parseConfig({ bot: { maxReplyChars: 9_999 } }, {})).toThrow(/maxReplyChars/);
        expect(() => parseConfig({ llm: { temperature: 3 } }, {})).toThrow(/temperature/);
    });

    it('校验日志级别', () => {
        expect(() => parseConfig({ logging: { level: 'verbose' } }, {})).toThrow(ConfigError);
    });

    it('群号必须是正整数', () => {
        expect(() => parseConfig({ bot: { groups: { whitelist: [-1] } } }, {})).toThrow(/\[0\] 必须是正整数/);
        expect(() => parseConfig({ bot: { owners: ['123'] } }, {})).toThrow(/owners\[0\] 必须是正整数/);
    });

    it('空字符串唤醒词无效', () => {
        expect(() => parseConfig({ bot: { trigger: { wakeWords: [''] } } }, {})).toThrow(/空字符串/);
    });

    it('去掉 baseUrl 结尾斜杠', () => {
        const config = parseConfig({ llm: { baseUrl: 'https://api.example.com/v1///' } }, {});

        expect(config.llm.baseUrl).toBe('https://api.example.com/v1');
    });

    it('提示词改由文件驱动，旧的 system 字段仍可读入（仅用于迁移）', () => {
        const fromFiles = parseConfig({ prompt: { dir: 'prompt-files', main: 'main.md' } }, {});

        expect(fromFiles.prompt.dir).toBe('prompt-files');
        expect(fromFiles.prompt.main).toBe('main.md');
        expect(fromFiles.prompt.system).toBeUndefined();

        const legacy = parseConfig({ prompt: { system: '旧提示词' } }, {});

        expect(legacy.prompt.system).toBe('旧提示词');
    });

    it('拒绝绝对路径的主提示词文件', () => {
        expect(() => parseConfig({ prompt: { main: 'C:/x.md' } }, {})).toThrow(/相对提示词目录/);
        expect(() => parseConfig({ prompt: { main: '' } }, {})).toThrow(/不能为空/);
    });

    it('保留分组系统提示词覆盖', () => {
        const config = parseConfig({ prompt: { perGroup: { '123456': 'groups/game.md' } } }, {});

        expect(config.prompt.perGroup['123456']).toBe('groups/game.md');
    });

    it('解析 GitHub 监听配置', () => {
        const config = parseConfig(
            {
                github: {
                    enabled: true,
                    intervalSeconds: 600,
                    targets: [
                        {
                            repo: 'rikkahub/rikkahub',
                            groupIds: [628101497],
                            kinds: ['release', 'commit'],
                            template: { release: '新版本 {tag}' },
                        },
                    ],
                },
            },
            {},
        );

        expect(config.github.enabled).toBe(true);
        expect(config.github.intervalSeconds).toBe(600);
        expect(config.github.targets[0]).toMatchObject({
            repo: 'rikkahub/rikkahub',
            groupIds: [628101497],
            kinds: ['release', 'commit'],
        });
    });

    it('校验 GitHub 目标配置', () => {
        expect(() =>
            parseConfig({ github: { targets: [{ repo: 'not-a-repo', groupIds: [1] }] } }, {}),
        ).toThrow(/owner\/repo/);
        expect(() =>
            parseConfig({ github: { targets: [{ repo: 'a/b', groupIds: [] }] } }, {}),
        ).toThrow(/至少要有一个群号/);
        expect(() =>
            parseConfig({
                github: { targets: [{ repo: 'a/b', groupIds: [1], kinds: ['tag'] }] },
            }, {}),
        ).toThrow(/release 或 commit/);
        expect(() =>
            parseConfig({
                github: {
                    targets: [{ repo: 'a/b', groupIds: [1], template: { push: 'x' } }],
                },
            }, {}),
        ).toThrow(/未知事件/);
        expect(() => parseConfig({ github: { intervalSeconds: 5 } }, {})).toThrow(/intervalSeconds/);
    });
});

describe('resolveConfigPath', () => {
    it('支持 --config 参数', () => {
        expect(resolveConfigPath(['--config', './my.json'], {})).toMatch(/my\.json$/);
        expect(resolveConfigPath(['--config=./other.json'], {})).toMatch(/other\.json$/);
    });

    it('回退到环境变量与默认路径', () => {
        expect(resolveConfigPath([], { QB_CONFIG_PATH: './env.json' })).toMatch(/env\.json$/);
        expect(resolveConfigPath([], {})).toMatch(/config[\\/]config\.json$/);
    });

    it('缺少参数值时抛错', () => {
        expect(() => resolveConfigPath(['--config'], {})).toThrow(/路径/);
    });
});



