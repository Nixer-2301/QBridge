import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { stripAnsi } from '../src/tui/ansi.ts';
import { Tui } from '../src/tui/tui.ts';

const ESC = '\u001b[';

class FakeStream extends EventEmitter {
    readonly isTTY = true;
    columns = 100;
    rows = 30;
    output = '';

    write(chunk: string): boolean {
        this.output += chunk;

        return true;
    }
}

class FakeInput extends EventEmitter {
    readonly isTTY = false;
    rawMode = false;

    setRawMode(value: boolean): void {
        this.rawMode = value;
    }

    resume(): void {}

    pause(): void {}
}

function createTui(overrides: { onQuit?: () => void } = {}) {
    const stream = new FakeStream();
    const input = new FakeInput();
    const tui = new Tui({
        stream: stream as unknown as NodeJS.WriteStream,
        input: input as unknown as NodeJS.ReadStream,
        animateFrames: 0,
        onQuit: overrides.onQuit ?? (() => undefined),
    });

    return { tui, stream, input };
}

const status = {
    connected: true,
    account: 'Nixer(3858972062)',
    model: 'deepseek-chat',
    groups: 3,
    events: 12,
    lastReply: '群 123456 · 1.8s',
    uptime: '00:12:34',
    logPath: 'bot-20261025-002150.log',
};

describe('Tui', () => {
    it('进入备用屏幕并画出横幅、日志与状态框', () => {
        const { tui, stream } = createTui();

        tui.start();
        tui.push('2026-10-25T00:21:52.346Z INFO  [aichat] 已连接 QQ 账号 Nixer', 'info');
        tui.setStatus(status);

        const plain = stripAnsi(stream.output);

        expect(stream.output.startsWith(`${ESC}?1049h`)).toBe(true);
        expect(plain).toContain('____');
        expect(plain).toContain('已连接');
        expect(plain).toContain('Nixer(3858972062)');
        expect(plain).toContain('deepseek-chat');
        expect(plain).toContain('00:12:34');
        expect(plain).toContain('q 退出');
        // 日志行压缩成本地时间 + 内容
        expect(plain).toContain('08:21:52 [aichat] 已连接 QQ 账号 Nixer');

        tui.stop();
    });

    it('退出时恢复终端状态', () => {
        const { tui, stream } = createTui();

        tui.start();
        stream.output = '';
        tui.stop();

        expect(stream.output).toContain(`${ESC}?1049l`);
        expect(stream.output).toContain(`${ESC}?25h`);
    });

    it('滚轮向上滚动后显示上方剩余行数', () => {
        const { tui, stream, input } = createTui();

        tui.start();

        for (let index = 1; index <= 60; index += 1) {
            tui.push(`日志第 ${index} 行`);
        }

        stream.output = '';
        input.emit('data', `${ESC}<64;10;5M`);

        const plain = stripAnsi(stream.output);

        expect(plain).toContain('上方还有');
        expect(plain).toMatch(/↑ \d+/);
    });

    it('End 键回到底部跟随模式', () => {
        const { tui, stream, input } = createTui();

        tui.start();

        for (let index = 1; index <= 40; index += 1) {
            tui.push(`日志第 ${index} 行`);
        }

        input.emit('data', `${ESC}<64;10;5M`);
        input.emit('data', `${ESC}F`);
        stream.output = '';
        tui.push('最新一行');

        expect(stripAnsi(stream.output)).toContain('跟随最新');
    });

    it('q 触发退出回调', () => {
        let quit = 0;
        const { tui, input } = createTui({ onQuit: () => (quit += 1) });

        tui.start();
        input.emit('data', 'q');
        tui.stop();

        expect(quit).toBe(1);
    });

    it('Ctrl+C 也能退出', () => {
        let quit = 0;
        const { tui, input } = createTui({ onQuit: () => (quit += 1) });

        tui.start();
        input.emit('data', '\u0003');
        tui.stop();

        expect(quit).toBe(1);
    });

    it('窗口变矮时自动退化成紧凑布局', () => {
        const { tui, stream } = createTui();

        tui.start();
        stream.rows = 15;
        stream.emit('resize');
        stream.output = '';
        tui.setStatus(status);

        const plain = stripAnsi(stream.output);

        expect(plain).not.toContain('____');
        expect(plain).toContain('Q Bridge');
        expect(plain).toContain('已连接');
    });
});
