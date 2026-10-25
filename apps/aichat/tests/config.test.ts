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
        expect(config.prompt.system.length).toBeGreaterThan(20);
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

    it('保留分组系统提示词覆盖', () => {
        const config = parseConfig({ prompt: { perGroup: { '123456': '你只聊游戏' } } }, {});

        expect(config.prompt.perGroup['123456']).toBe('你只聊游戏');
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
