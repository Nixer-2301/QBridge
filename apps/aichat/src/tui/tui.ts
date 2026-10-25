import type { LogSink } from '../logger.ts';
import { artFrame } from '../banner.ts';
import {
    BOLD,
    CLEAR_LINE,
    DIM,
    DISABLE_MOUSE,
    DISABLE_WRAP,
    ENABLE_MOUSE,
    ENABLE_WRAP,
    ENTER_ALT_SCREEN,
    EXIT_ALT_SCREEN,
    FG,
    HIDE_CURSOR,
    RESET,
    SHOW_CURSOR,
    moveTo,
    stripAnsi,
} from './ansi.ts';
import { bodyLineCapacity, computeLayout } from './layout.ts';
import type { Layout } from './layout.ts';
import { LogBuffer } from './log-buffer.ts';
import type { LogLevelName } from './log-buffer.ts';
import { displayWidth, truncateAnsiToWidth } from './width.ts';

export interface TuiStatus {
    connected: boolean;
    account: string;
    model: string;
    groups: number;
    events: number;
    lastReply: string;
    uptime: string;
    logPath: string;
}

export interface TuiOptions {
    stream: NodeJS.WriteStream;
    input: NodeJS.ReadStream;
    maxLines?: number;
    /** 是否持续播放头部动画（默认开，像 z.py 一样循环） */
    animate?: boolean;
    /** 每帧间隔毫秒，默认 40 */
    frameMs?: number;
    onQuit: () => void;
}

const FRAME_MS = 40;
const WHEEL_STEP = 3;
const LEVEL_COLOR: Record<LogLevelName, string> = {
    debug: FG.gray,
    info: '',
    warn: FG.yellow,
    error: FG.red,
};

const ISO_LINE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)\s+(DEBUG|INFO|WARN|ERROR)\s+(.*)$/;

function padFor(text: string, width: number): string {
    const padding = width - displayWidth(stripAnsi(text));

    return padding > 0 ? text + ' '.repeat(padding) : text;
}

function localTime(iso: string, fallback: number): string {
    const date = new Date(iso);
    const value = Number.isNaN(date.getTime()) ? new Date(fallback) : date;

    return `${String(value.getHours()).padStart(2, '0')}:${String(value.getMinutes()).padStart(2, '0')}:${String(value.getSeconds()).padStart(2, '0')}`;
}

/**
 * 三段式 TUI：顶部固定横幅、底部固定状态框、中间日志区支持滚轮/翻页。
 * 非交互场景（管道、CI）不要使用本类，调用方直接走纯文本日志。
 */
export class Tui {
    private readonly stream: NodeJS.WriteStream;
    private readonly input: NodeJS.ReadStream;
    private readonly logs: LogBuffer;
    private readonly onQuit: () => void;
    private readonly animate: boolean;
    private readonly frameMs: number;

    private status: TuiStatus = {
        connected: false,
        account: '未连接',
        model: '—',
        groups: 0,
        events: 0,
        lastReply: '—',
        uptime: '00:00:00',
        logPath: '',
    };

    private frame = 0;
    private timer: ReturnType<typeof setInterval> | undefined;
    private started = false;
    private pendingInput = '';
    private resizeHandler: (() => void) | undefined;
    private dataHandler: ((chunk: Buffer | string) => void) | undefined;

    constructor(options: TuiOptions) {
        this.stream = options.stream;
        this.input = options.input;
        this.onQuit = options.onQuit;
        this.logs = new LogBuffer(options.maxLines ?? 5_000);
        this.animate = options.animate ?? true;
        this.frameMs = Math.max(16, options.frameMs ?? FRAME_MS);
    }

    /** 供 createLogger 使用的 sink：终端里显示，同时由外层再落盘。 */
    get sink(): LogSink {
        return {
            log: (line: string) => this.push(line, 'info'),
            warn: (line: string) => this.push(line, 'warn'),
            error: (line: string) => this.push(line, 'error'),
        };
    }

    start(): void {
        if (this.started) {
            return;
        }

        this.started = true;
        this.stream.write(ENTER_ALT_SCREEN + HIDE_CURSOR + DISABLE_WRAP + ENABLE_MOUSE);

        if (this.input.isTTY) {
            this.input.setRawMode(true);
        }

        this.input.resume();
        this.dataHandler = (chunk) => this.handleInput(String(chunk));
        this.input.on('data', this.dataHandler);
        this.resizeHandler = () => this.render();
        this.stream.on('resize', this.resizeHandler);

        this.render();

        if (this.animate) {
            this.startAnimation();
        }
    }

    stop(): void {
        if (!this.started) {
            return;
        }

        this.started = false;
        this.stopAnimation();

        if (this.dataHandler) {
            this.input.off('data', this.dataHandler);
            this.dataHandler = undefined;
        }

        if (this.resizeHandler) {
            this.stream.off('resize', this.resizeHandler);
            this.resizeHandler = undefined;
        }

        if (this.input.isTTY) {
            this.input.setRawMode(false);
        }

        this.input.pause();
        this.stream.write(RESET + DISABLE_MOUSE + SHOW_CURSOR + ENABLE_WRAP + EXIT_ALT_SCREEN);
    }

    push(line: string, level: LogLevelName = 'info'): void {
        this.logs.push(line, level);
        this.render();
    }

    setStatus(status: TuiStatus): void {
        this.status = status;
        this.render();
    }

    /** 只重绘横幅区域，像 z.py 一样持续循环，不刷整屏、不打断日志阅读。 */
    private startAnimation(): void {
        this.stopAnimation();
        this.timer = setInterval(() => {
            this.frame += 1;
            this.renderHeader();
        }, this.frameMs);
        this.timer.unref?.();
    }

    private stopAnimation(): void {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = undefined;
        }
    }

    private size(): { rows: number; cols: number } {
        return {
            rows: Math.max(10, this.stream.rows ?? 24),
            cols: Math.max(40, this.stream.columns ?? 80),
        };
    }

    /** 顶部横幅的每一行；整屏渲染与动画局部重绘共用。 */
    private headerLines(cols: number, layout: Layout): string[] {
        if (!layout.fullHeader) {
            return [`${FG.orange}${BOLD} Q Bridge ${RESET}${DIM}· QQ 群 AI 助手${RESET}`, ''];
        }

        const art = artFrame(this.frame, { color: true });
        const artWidth = Math.max(...art.map((line) => displayWidth(stripAnsi(line))));
        const pad = ' '.repeat(Math.max(0, Math.floor((cols - artWidth) / 2)));

        return [...art.map((line) => pad + line), ''];
    }

    /**
     * 只重写横幅区域：动画每帧只碰顶部几行，
     * 不整屏重绘，所以日志区不会闪、也不会打断滚动阅读。
     */
    private renderHeader(): void {
        if (!this.started) {
            return;
        }

        const { rows, cols } = this.size();
        const layout = computeLayout(rows, cols);
        const lines = this.headerLines(cols, layout);
        let output = '';

        for (let index = 0; index < lines.length; index += 1) {
            output += `${moveTo(index + 1, 1)}${CLEAR_LINE}${truncateAnsiToWidth(lines[index] ?? '', cols)}`;
        }

        this.stream.write(output);
    }

    private render(): void {
        if (!this.started) {
            return;
        }

        const { rows, cols } = this.size();
        const layout = computeLayout(rows, cols);
        const capacity = bodyLineCapacity(layout);
        const view = this.logs.window(capacity);
        const lines: string[] = [];

        // 顶部：完整字符画或单行标题，固定不滚动。
        if (layout.fullHeader) {
            const art = artFrame(this.frame, { color: true });
            const artWidth = Math.max(...art.map((line) => displayWidth(stripAnsi(line))));
            const pad = ' '.repeat(Math.max(0, Math.floor((cols - artWidth) / 2)));

            for (const artLine of art) {
                lines.push(pad + artLine);
            }

            lines.push('');
        } else {
            lines.push(`${FG.orange}${BOLD} Q Bridge ${RESET}${DIM}· QQ 群 AI 助手${RESET}`);
            lines.push('');
        }

        // 中间：日志区（首行是滚动提示）。
        if (view.above > 0) {
            lines.push(
                `${FG.cyan}─ ↑ 上方还有 ${view.above} 行 · End 回到底部 ${RESET}${DIM}${'─'.repeat(Math.max(0, cols))}${RESET}`,
            );
        } else {
            lines.push(`${DIM}${'─'.repeat(Math.max(0, cols))}${RESET}`);
        }

        if (capacity > 0) {
            const bodyRows = view.lines.map((logLine) =>
                this.formatLogLine(logLine.text, logLine.level, logLine.at),
            );

            for (let index = bodyRows.length; index < capacity; index += 1) {
                bodyRows.push('');
            }

            lines.push(...bodyRows.slice(-capacity));
        }

        // 底部：固定状态框。
        lines.push(...this.renderFooter(cols, layout.footer.height));

        // 一次性整屏重绘，避免逐行刷新带来的闪烁。
        let output = '';
        const limit = Math.min(rows, lines.length);

        for (let index = 0; index < limit; index += 1) {
            output += `${moveTo(index + 1, 1)}${CLEAR_LINE}${truncateAnsiToWidth(lines[index] ?? '', cols)}`;
        }

        this.stream.write(output);
    }

    /** 把日志行压成固定的「时间 内容」，并按级别着色。 */
    private formatLogLine(text: string, level: LogLevelName, at: number): string {
        const clean = stripAnsi(text);
        const match = ISO_LINE.exec(clean);
        const color = LEVEL_COLOR[level];
        const reset = color.length > 0 ? RESET : '';

        if (!match) {
            return `${color}${clean}${reset}`;
        }

        return `${DIM}${localTime(match[1] ?? '', at)}${RESET} ${color}${match[3] ?? ''}${reset}`;
    }

    private renderFooter(cols: number, height: number): string[] {
        const inner = Math.max(10, cols - 2);
        const status = this.status;
        const dot = status.connected ? `${FG.green}●${RESET}` : `${FG.red}●${RESET}`;
        const state = status.connected ? '已连接' : '未连接';
        const scroll = this.logs.following ? `${DIM}跟随最新${RESET}` : `${FG.cyan}↑ ${this.logs.offset}${RESET}`;

        const line1 = `${dot} ${state}  ${status.account}   ${DIM}模型${RESET} ${status.model}   ${DIM}滚动${RESET} ${scroll}`;
        const line2 = `${DIM}群${RESET} ${status.groups}  ${DIM}消息${RESET} ${status.events}  ${DIM}最近回复${RESET} ${status.lastReply}  ${DIM}运行${RESET} ${status.uptime}`;
        const hint = `${DIM}滚轮/PgUp/PgDn 滚动 · End 回到底部 · a 暂停动画 · q 退出 · 日志 ${status.logPath}${RESET}`;
        const title = ' Q Bridge ';
        const wrap = (content: string): string =>
            `${DIM}│${RESET}${padFor(truncateAnsiToWidth(content, inner), inner)}${DIM}│${RESET}`;
        const top = `${DIM}┌${title}${'─'.repeat(Math.max(0, cols - 2 - displayWidth(title)))}┐${RESET}`;
        const bottom = `${DIM}└${'─'.repeat(Math.max(0, cols - 2))}┘${RESET}`;

        if (height >= 5) {
            return [top, wrap(line1), wrap(line2), wrap(hint), bottom];
        }

        return [top, wrap(`${dot} ${state}  ${status.account}   ${DIM}群${RESET} ${status.groups}   ${DIM}a 动画 · q 退出${RESET}`), bottom];
    }

    private handleInput(chunk: string): void {
        this.pendingInput += chunk;

        for (;;) {
            const consumed = this.consumeOne();

            if (consumed <= 0) {
                return;
            }

            this.pendingInput = this.pendingInput.slice(consumed);
        }
    }

    /** 返回消费掉的字符数；0 表示数据不完整，等后续分片。 */
    private consumeOne(): number {
        const input = this.pendingInput;

        if (input.length === 0) {
            return 0;
        }

        const { rows, cols } = this.size();
        const capacity = bodyLineCapacity(computeLayout(rows, cols));

        const mouse = /^\u001b\[<(\d+);(\d+);(\d+)([Mm])/.exec(input);

        if (mouse) {
            const button = Number(mouse[1]);

            if (mouse[4] === 'M') {
                if (button === 64) {
                    this.logs.scrollBy(WHEEL_STEP, capacity);
                    this.render();
                } else if (button === 65) {
                    this.logs.scrollBy(-WHEEL_STEP, capacity);
                    this.render();
                }
            }

            return mouse[0].length;
        }

        if (input.startsWith('\u001b[')) {
            const sequence = /^\u001b\[([0-9;]*)([A-Za-z~])/.exec(input);

            if (!sequence) {
                return input.length > 8 ? input.length : 0;
            }

            const code = sequence[1] ?? '';
            const final = sequence[2] ?? '';

            if (final === 'A') {
                this.logs.scrollBy(1, capacity);
            } else if (final === 'B') {
                this.logs.scrollBy(-1, capacity);
            } else if (code === '5' && final === '~') {
                this.logs.scrollBy(capacity, capacity);
            } else if (code === '6' && final === '~') {
                this.logs.scrollBy(-capacity, capacity);
            } else if ((final === 'H' && code === '') || (code === '1' && final === '~')) {
                this.logs.scrollToTop(capacity);
            } else if ((final === 'F' && code === '') || (code === '4' && final === '~')) {
                this.logs.follow();
            }

            this.render();

            return sequence[0].length;
        }

        if (input.startsWith('\u001b')) {
            return input.length < 2 ? 0 : 2;
        }

        const char = input[0] ?? '';

        if (char === '\u0003' || char === 'q' || char === '\u0011') {
            this.onQuit();

            return 1;
        }

        if (char === 'a') {
            // 暂停 / 继续横幅动画（默认一直循环，像 z.py）
            if (this.timer) {
                this.stopAnimation();
            } else {
                this.startAnimation();
            }

            this.render();

            return 1;
        }

        if (char === 'g') {
            this.logs.scrollToTop(capacity);
            this.render();

            return 1;
        }

        if (char === 'G') {
            this.logs.follow();
            this.render();

            return 1;
        }

        return 1;
    }
}



