import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createLogSink, logFileName, openLogFile } from '../src/log-sink.ts';

const tempDirs: string[] = [];

function tempDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-log-'));

    tempDirs.push(dir);

    return dir;
}

function openStream(filePath: string): Promise<fs.WriteStream> {
    const stream = fs.createWriteStream(filePath, { flags: 'a' });

    return new Promise((resolve, reject) => {
        stream.once('open', () => resolve(stream));
        stream.once('error', reject);
    });
}

function closeStream(stream: fs.WriteStream): Promise<void> {
    return new Promise((resolve) => {
        stream.end(() => resolve());
    });
}

afterEach(() => {
    while (tempDirs.length > 0) {
        const dir = tempDirs.pop();

        if (dir) {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    }
});

describe('logFileName', () => {
    it('生成可按时间排序的文件名', () => {
        expect(logFileName(new Date(2026, 9, 25, 0, 12, 55))).toBe('bot-20261025-001255.log');
    });
});

describe('openLogFile', () => {
    it('自动创建目录', async () => {
        const dir = path.join(tempDir(), 'nested', 'logs');
        const handle = openLogFile(dir);

        await new Promise<void>((resolve) => handle.stream.once('open', () => resolve()));

        expect(fs.existsSync(handle.path)).toBe(true);
        expect(path.basename(handle.path)).toMatch(/^bot-\d{8}-\d{6}\.log$/);

        await closeStream(handle.stream);
    });
});

describe('createLogSink', () => {
    it('没有文件时直接使用终端 sink', () => {
        const lines: string[] = [];
        const consoleSink = {
            log: (line: string) => lines.push(line),
            warn: (line: string) => lines.push(line),
            error: (line: string) => lines.push(line),
        };
        const sink = createLogSink(consoleSink);

        sink.log('hello');

        expect(lines).toEqual(['hello']);
    });

    it('同时写终端与文件', async () => {
        const dir = tempDir();
        const filePath = path.join(dir, 'test.log');
        const stream = await openStream(filePath);
        const lines: string[] = [];
        const consoleSink = {
            log: (line: string) => lines.push(`out:${line}`),
            warn: (line: string) => lines.push(`warn:${line}`),
            error: (line: string) => lines.push(`err:${line}`),
        };

        const sink = createLogSink(consoleSink, stream);

        sink.log('第一行');
        sink.warn('第二行');
        sink.error('第三行');

        await closeStream(stream);

        expect(lines).toEqual(['out:第一行', 'warn:第二行', 'err:第三行']);
        expect(fs.readFileSync(filePath, 'utf8')).toBe('第一行\n第二行\n第三行\n');
    });

    it('文件已关闭时不抛错', async () => {
        const dir = tempDir();
        const stream = await openStream(path.join(dir, 'closed.log'));

        stream.on('error', () => undefined);

        const sink = createLogSink(
            { log: () => undefined, warn: () => undefined, error: () => undefined },
            stream,
        );

        await closeStream(stream);

        expect(() => sink.log('after close')).not.toThrow();
    });
});
