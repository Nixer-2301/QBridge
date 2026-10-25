import { describe, expect, it } from 'vitest';
import { bodyLineCapacity, computeLayout } from '../src/tui/layout.ts';

describe('computeLayout', () => {
    it('常规窗口：完整横幅 + 5 行状态框', () => {
        const layout = computeLayout(30);

        expect(layout.fullHeader).toBe(true);
        expect(layout.header.height).toBe(7);
        expect(layout.footer.height).toBe(5);
        expect(layout.body.height).toBe(18);
    });

    it('矮窗口退化成单行标题，但状态框仍有 5 行', () => {
        const layout = computeLayout(15);

        expect(layout.fullHeader).toBe(false);
        expect(layout.header.height).toBe(2);
        expect(layout.footer.height).toBe(5);
        expect(layout.body.height).toBe(8);
    });

    it('极矮窗口压缩状态框并保留日志区', () => {
        const layout = computeLayout(8);

        expect(layout.footer.height).toBe(3);
        expect(layout.body.height).toBeGreaterThanOrEqual(3);
        expect(layout.header.height + layout.body.height + layout.footer.height).toBe(8);
    });

    it('极矮窗口仍保留日志区', () => {
        const layout = computeLayout(10);

        expect(layout.body.height).toBeGreaterThanOrEqual(3);
        expect(layout.header.height + layout.body.height + layout.footer.height).toBe(10);
    });

    it('三段区域首尾相接且不越界', () => {
        for (const rows of [10, 15, 24, 30, 60]) {
            const layout = computeLayout(rows);

            expect(layout.header.top).toBe(1);
            expect(layout.body.top).toBe(layout.header.top + layout.header.height);
            expect(layout.footer.top).toBe(layout.body.top + layout.body.height);
            expect(layout.footer.top + layout.footer.height - 1).toBe(rows);
        }
    });

    it('日志容量等于日志区高度减一（顶部提示行）', () => {
        const layout = computeLayout(30);

        expect(bodyLineCapacity(layout)).toBe(layout.body.height - 1);
    });
});
