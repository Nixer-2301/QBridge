import fs from 'node:fs';
import path from 'node:path';
import type { LogSink } from './logger.ts';

export interface LogFileHandle {
    stream: fs.WriteStream;
    path: string;
}

function twoDigits(value: number): string {
    return String(value).padStart(2, '0');
}

/** 生成 logs/bot-YYYYMMDD-HHmmss.log 这类时间戳文件名。 */
export function logFileName(now: Date = new Date()): string {
    const date = `${now.getFullYear()}${twoDigits(now.getMonth() + 1)}${twoDigits(now.getDate())}`;
    const time = `${twoDigits(now.getHours())}${twoDigits(now.getMinutes())}${twoDigits(now.getSeconds())}`;

    return `bot-${date}-${time}.log`;
}

/** 打开日志文件（目录不存在会自动创建）。 */
export function openLogFile(dir: string, now: Date = new Date()): LogFileHandle {
    fs.mkdirSync(dir, { recursive: true });

    const filePath = path.join(dir, logFileName(now));
    const stream = fs.createWriteStream(filePath, { flags: 'a' });

    // 磁盘满/权限不足时不能让进程崩掉：报告一次并降级为「只输出到终端」。
    stream.on('error', (error) => {
        console.error(`日志文件不可写（${filePath}）：${error.message}。后续日志只输出到终端。`);
        stream.destroy();
    });

    return { stream, path: filePath };
}

/**
 * 同时写终端与文件：终端保留颜色/交互，文件里是纯文本行，方便事后排查。
 * 文件写入失败不能拖垮日志，错误被吞掉并由调用方在退出时统一报告。
 */
export function createLogSink(consoleSink: LogSink, file?: fs.WriteStream): LogSink {
    if (!file) {
        return consoleSink;
    }

    const forward =
        (method: 'log' | 'warn' | 'error') =>
        (line: string): void => {
            consoleSink[method](line);

            if (!file.destroyed) {
                file.write(`${line}\n`);
            }
        };

    return {
        log: forward('log'),
        warn: forward('warn'),
        error: forward('error'),
    };
}
