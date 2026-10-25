import { describe, expect, it } from 'vitest';
import { formatPreflight } from '../src/check.ts';

describe('formatPreflight', () => {
    it('全部通过时返回成功', () => {
        const result = formatPreflight([
            { label: '配置文件', ok: true, detail: '/opt/app/config/config.json' },
            { label: 'OneBot', ok: true, detail: 'ws://10.0.0.2:3001/ → Nixer(3858972062)' },
        ]);

        expect(result.ok).toBe(true);
        expect(result.text).toContain('[ OK ]');
        expect(result.text).toContain('预检通过');
    });

    it('有失败项时标记 FAIL 并给出提示', () => {
        const result = formatPreflight([
            { label: '配置文件', ok: true, detail: 'ok' },
            { label: '模型', ok: false, detail: '401 invalid api key' },
        ]);

        expect(result.ok).toBe(false);
        expect(result.text).toContain('[FAIL]');
        expect(result.text).toContain('401 invalid api key');
        expect(result.text).toContain('有 1 项失败');
    });

    it('标签长度不同也能对齐', () => {
        const result = formatPreflight([
            { label: 'a', ok: true, detail: 'x' },
            { label: '很长很长的名字', ok: true, detail: 'y' },
        ]);

        const lines = result.text.split('\n').filter((line) => line.includes('['));

        expect(lines[0]?.indexOf('x')).toBe(lines[1]?.indexOf('y'));
    });
});
