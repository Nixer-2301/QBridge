import type { LogLevel } from './types.ts';

const WEIGHT: Record<LogLevel, number> = {
    debug: 10,
    info: 20,
    warn: 30,
    error: 40,
    silent: 100,
};

export type LogSink = Pick<Console, 'log' | 'warn' | 'error'>;

/** 支持函数形式，配置热重载后日志级别会自动跟随。 */
export type LogLevelSource = LogLevel | (() => LogLevel);

export interface Logger {
    debug(message: string, ...details: unknown[]): void;
    info(message: string, ...details: unknown[]): void;
    warn(message: string, ...details: unknown[]): void;
    error(message: string, ...details: unknown[]): void;
    child(scope: string): Logger;
}

function formatDetails(details: unknown[]): string {
    if (details.length === 0) {
        return '';
    }

    const parts: string[] = [];

    for (const detail of details) {
        if (detail instanceof Error) {
            const message = detail.message.trim();
            parts.push(message.length > 0 ? `${detail.name}: ${message}` : detail.name);
            continue;
        }

        if (typeof detail === 'string') {
            parts.push(detail);
            continue;
        }

        try {
            parts.push(JSON.stringify(detail));
        } catch {
            parts.push(String(detail));
        }
    }

    return ` ${parts.join(' ')}`;
}

export function createLogger(
    scope: string,
    levelSource: LogLevelSource = 'info',
    sink: LogSink = console,
): Logger {
    const resolveThreshold = () =>
        WEIGHT[typeof levelSource === 'function' ? levelSource() : levelSource];

    const emit = (logLevel: Exclude<LogLevel, 'silent'>, message: string, details: unknown[]) => {
        if (WEIGHT[logLevel] < resolveThreshold()) {
            return;
        }

        const line = `${new Date().toISOString()} ${logLevel.toUpperCase().padEnd(5)} [${scope}] ${message}${formatDetails(details)}`;

        if (logLevel === 'error') {
            sink.error(line);
            return;
        }

        if (logLevel === 'warn') {
            sink.warn(line);
            return;
        }

        sink.log(line);
    };

    return {
        debug: (message, ...details) => emit('debug', message, details),
        info: (message, ...details) => emit('info', message, details),
        warn: (message, ...details) => emit('warn', message, details),
        error: (message, ...details) => emit('error', message, details),
        child: (childScope) => createLogger(`${scope}:${childScope}`, levelSource, sink),
    };
}
