#!/usr/bin/env node
/**
 * 离线端到端自检：假 OneBot 服务端 + 假 OpenAI 兼容模型 + 真实机器人进程。
 * 不需要 QQ、不需要 QBridge、不需要真实模型密钥。
 *
 *   npm run build && node tools/smoke.mjs
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { WebSocketServer } from 'ws';

const SELF_ID = 3_000_000_001;
const GROUP_ID = 123_456;
const USER_ID = 9_876_543;
const REPLY = '自检通过：我收到了这条群消息。';

function log(message) {
    console.log(`[smoke] ${message}`);
}

function fail(message) {
    console.error(`[smoke] ✗ ${message}`);
    process.exitCode = 1;
}

async function listen(server) {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    return server.address().port;
}

/** WebSocketServer 在构造时就开始监听，不能像 http.Server 那样再调 listen。 */
async function createWebSocketServer(options) {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0, ...options });
    await new Promise((resolve) => server.once('listening', resolve));
    return { server, port: server.address().port };
}

function waitFor(check, timeoutMs = 15_000) {
    return new Promise((resolve, reject) => {
        const startedAt = Date.now();

        const tick = () => {
            let value;

            try {
                value = check();
            } catch (error) {
                reject(error);
                return;
            }

            if (value) {
                resolve(value);
                return;
            }

            if (Date.now() - startedAt > timeoutMs) {
                reject(new Error('等待超时'));
                return;
            }

            setTimeout(tick, 25);
        };

        tick();
    });
}

async function main() {
    if (!fs.existsSync(path.resolve('dist/index.js'))) {
        console.error('请先运行 npm run build 生成 dist/');
        process.exitCode = 1;
        return;
    }

    const receivedLlmRequests = [];
    const llmServer = http.createServer((request, response) => {
        if (request.method !== 'POST') {
            response.writeHead(404).end();
            return;
        }

        let body = '';

        request.on('data', (chunk) => {
            body += chunk;
        });

        request.on('end', () => {
            try {
                receivedLlmRequests.push(JSON.parse(body));
            } catch {
                receivedLlmRequests.push({ raw: body });
            }

            response.writeHead(200, { 'content-type': 'application/json' });
            response.end(
                JSON.stringify({
                    model: 'smoke-model',
                    choices: [{ index: 0, message: { role: 'assistant', content: REPLY } }],
                    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
                }),
            );
        });
    });

    const llmPort = await listen(llmServer);
    log(`假模型服务已启动：http://127.0.0.1:${llmPort}/v1`);

    const receivedActions = [];
    const sockets = new Set();
    const { server: oneBotServer, port: oneBotPort } = await createWebSocketServer();

    oneBotServer.on('connection', (socket) => {
        sockets.add(socket);
        log('机器人已连接到假 OneBot 服务端');

        socket.on('message', (raw) => {
            let payload;

            try {
                payload = JSON.parse(String(raw));
            } catch {
                return;
            }

            receivedActions.push(payload);

            const isLogin = payload.action === 'get_login_info';
            const data = isLogin ? { user_id: SELF_ID, nickname: '自检机器人' } : { message_id: 1 };

            socket.send(JSON.stringify({ status: 'ok', retcode: 0, data, echo: payload.echo }));
        });
    });

    log(`假 OneBot 服务端已启动：ws://127.0.0.1:${oneBotPort}/`);

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-smoke-'));
    const configPath = path.join(tempDir, 'config.json');

    fs.writeFileSync(
        configPath,
        JSON.stringify(
            {
                onebot: { url: `ws://127.0.0.1:${oneBotPort}/`, reconnect: false },
                bot: { name: '自检机器人', replyQuote: true },
                context: { maxMessages: 20, maxTokens: 20_000 },
                llm: {
                    baseUrl: `http://127.0.0.1:${llmPort}/v1`,
                    apiKey: '',
                    model: 'smoke-model',
                    retries: 0,
                },
                logging: { level: 'info' },
            },
            null,
            4,
        ),
        'utf8',
    );

    const child = spawn(process.execPath, ['dist/index.js'], {
        cwd: process.cwd(),
        env: { ...process.env, QB_CONFIG_PATH: configPath },
        stdio: ['ignore', 'pipe', 'pipe'],
    });

    const childLogs = [];

    child.stdout.on('data', (chunk) => {
        const text = String(chunk);
        childLogs.push(text);
        process.stdout.write(text.replace(/^/gm, '  | '));
    });
    child.stderr.on('data', (chunk) => {
        const text = String(chunk);
        childLogs.push(text);
        process.stderr.write(text.replace(/^/gm, '  ! '));
    });

    const cleanup = () => {
        for (const socket of sockets) {
            socket.terminate();
        }

        oneBotServer.close();
        llmServer.close();
        fs.rmSync(tempDir, { recursive: true, force: true });

        if (!child.killed) {
            child.kill();
        }
    };

    try {
        await waitFor(() => receivedActions.some((item) => item.action === 'get_login_info'));
        log('✓ 机器人已连接并读到账号信息');

        const socket = [...sockets][0];

        socket.send(
            JSON.stringify({
                post_type: 'message',
                message_type: 'group',
                sub_type: 'normal',
                time: Math.floor(Date.now() / 1_000),
                self_id: SELF_ID,
                group_id: GROUP_ID,
                user_id: USER_ID,
                message_id: -42,
                message: [
                    { type: 'at', data: { qq: String(SELF_ID), name: '自检机器人' } },
                    { type: 'text', data: { text: ' 在吗，自检一下' } },
                ],
                raw_message: `[CQ:at,qq=${SELF_ID}] 在吗，自检一下`,
                font: 0,
                sender: { user_id: USER_ID, nickname: '小明', card: '' },
            }),
        );
        log('→ 已发送一条 @机器人 的群消息');

        const sendAction = await waitFor(() =>
            receivedActions.find((item) => item.action === 'send_group_msg'),
        );
        log('✓ 机器人在群里发出了 send_group_msg');

        const segments = sendAction.params.message;
        const text = segments
            .filter((segment) => segment.type === 'text')
            .map((segment) => segment.data.text)
            .join('');

        const expected = {
            groupId: String(sendAction.params.group_id),
            quoted: segments[0]?.type === 'reply',
            text,
        };

        log(`  引用原消息：${expected.quoted ? '是' : '否'}`);
        log(`  回复内容：${expected.text}`);

        const request = receivedLlmRequests[0];
        const messages = request?.messages ?? [];

        log(`  发给模型的上下文：${messages.length} 条（含系统提示词）`);

        const checks = [
            [expected.groupId === String(GROUP_ID), '回复发到了正确的群'],
            [expected.quoted, '回复引用了触发消息'],
            [expected.text === REPLY, '回复内容来自模型'],
            [messages[0]?.role === 'system', '第一条是系统提示词'],
            [messages.at(-1)?.content === '小明: 在吗，自检一下', '上下文里带发言人昵称'],
            [request?.model === 'smoke-model', '请求使用配置里的模型名'],
        ];

        for (const [ok, label] of checks) {
            if (ok) {
                log(`✓ ${label}`);
            } else {
                fail(label);
            }
        }

        if (process.exitCode !== 1) {
            log('全部通过：QQ 接入 → 上下文 → 模型 → 群回复 的链路可用');
        }
    } catch (error) {
        fail(error instanceof Error ? error.message : String(error));

        if (childLogs.length > 0) {
            console.error('[smoke] 机器人日志：');
            console.error(childLogs.join(''));
        }
    } finally {
        cleanup();
    }
}

main();
