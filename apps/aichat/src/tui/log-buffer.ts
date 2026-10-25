export type LogLevelName = 'debug' | 'info' | 'warn' | 'error';

export interface LogLine {
    text: string;
    level: LogLevelName;
    at: number;
}

export interface LogWindow {
    lines: LogLine[];
    /** 当前视图上方还有多少行没显示。 */
    above: number;
    /** 是否跟随最新一行。 */
    following: boolean;
}

/**
 * 环形日志缓冲：只保留最近 capacity 行，滚动偏移从底部起算。
 * offset = 0 表示跟随最新输出。
 */
export class LogBuffer {
    private readonly lines: LogLine[] = [];
    private offsetValue = 0;

    constructor(private readonly capacity: number = 5_000) {}

    get size(): number {
        return this.lines.length;
    }

    get offset(): number {
        return this.offsetValue;
    }

    get following(): boolean {
        return this.offsetValue === 0;
    }

    push(text: string, level: LogLevelName = 'info', at: number = Date.now()): void {
        this.lines.push({ text, level, at });

        if (this.lines.length > this.capacity) {
            this.lines.splice(0, this.lines.length - this.capacity);
        }

        // 跟随模式下 offset 保持 0；手动滚动时不打断阅读位置。
    }

    /** 当前可见窗口（最后 height 行，或按 offset 上移）。 */
    window(height: number): LogWindow {
        const heightValue = Math.max(0, Math.floor(height));
        const maxOffset = Math.max(0, this.lines.length - heightValue);
        const offset = Math.min(this.offsetValue, maxOffset);
        const end = this.lines.length - offset;
        const start = Math.max(0, end - heightValue);

        return {
            lines: this.lines.slice(start, end),
            above: start,
            following: offset === 0,
        };
    }

    /** 正值向上滚（看更早的日志）。 */
    scrollBy(delta: number, height: number): void {
        const maxOffset = Math.max(0, this.lines.length - height);
        const next = Math.max(0, Math.min(maxOffset, this.offsetValue + delta));

        this.offsetValue = next;
    }

    scrollToTop(height: number): void {
        this.offsetValue = Math.max(0, this.lines.length - height);
    }

    follow(): void {
        this.offsetValue = 0;
    }
}
