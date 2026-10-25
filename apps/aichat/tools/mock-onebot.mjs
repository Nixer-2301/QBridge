#!/usr/bin/env node
/**
 * 本地假 OneBot 服务端：不需要 QQ 和 QBridge，就能手动验证机器人的收发。
 *
 *   node tools/mock-onebot.mjs
 *
 * 然后在另一个终端启动机器人（onebot.url 指向 ws://127.0.0.1:3001/）。
 * 这里输入的文字会以「@机器人 + 文本」的群消息发过去；以 /say 开头的行不带 @（只进上下文）。
 */
import readline from 'node:readline';
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.MOCK_PORT ?? 3001);
const TOKEN = process.env.MOCK_TOKEN ?? '';
const SELF_ID = Number(process.env.MOCK_SELF_ID ?? 10001);
const GROUP_ID = Number(process.env.MOCK_GROUP_ID ?? 123456);
const USER_ID = Number(process.env.MOCK_USER_ID ?? 20002);
const NICKNAME = process.env.MOCK_NICKNAME ?? '测试群友';

let nextMessageId = -100;
let socket = null;

function describeSegment(segment) {
    if (!segment || typeof segment !== 'object') {
        return '';
    }

    const data = segment.data ?? {};

    switch (segment.type) {
        case 'text':
            return String(data.text ?? '');
        case 'at':
            return `@${data.name ?? data.qq ?? '?'} `;
        case 'reply':
            return `[引用 ${data.id}] `;
        case 'image':
            return '[图片]';
        case 'face':
            return '[表情]';
        default:
            return `[${segment.type}]`;
    }
}

function describeMessage(message) {
    if (typeof message === 'string') {
        return message;
    }

    if (Array.isArray(message)) {
        return message.map(describeSegment).join('');
    }

    return JSON.stringify(message);
}

function handleAction(payload) {
    const action = String(payload.action ?? '');
    const data = action === 'get_login_info' ? { user_id: SELF_ID, nickname: '假机器人' } : { message_id: 1 };

    if (action === 'send_group_msg') {
        const groupId = payload.params?.group_id;
        console.log(`\n[机器人 → 群 ${groupId}] ${describeMessage(payload.params?.message)}`);
    } else if (action !== 'get_login_info') {
        console.log(`[动作] ${action}`, JSON.stringify(payload.params ?? {}));
    }

    return { status: 'ok', retcode: 0, data, echo: payload.echo };
}

function sendGroupMessage(text, withAt) {
    if (!socket) {
        console.log('还没有机器人连上来');
        return;
    }

    const message = [];

    if (withAt) {
        message.push({ type: 'at', data: { qq: String(SELF_ID), name: '小助手' } });
    }

    message.push({ type: 'text', data: { text } });

    nextMessageId -= 1;
    socket.send(
        JSON.stringify({
            post_type: 'message',
            message_type: 'group',
            sub_type: 'normal',
            time: Math.floor(Date.now() / 1000),
            self_id: SELF_ID,
            group_id: GROUP_ID,
            user_id: USER_ID,
            message_id: nextMessageId,
            message,
            raw_message: text,
            font: 0,
            sender: { user_id: USER_ID, nickname: NICKNAME, card: '' },
        }),
    );

    console.log(`[你${withAt ? ' @机器人' : '（不 @）'} → 群 ${GROUP_ID}] ${text}`);
}

const server = new WebSocketServer({ host: '127.0.0.1', port: PORT });

server.on('connection', (client, request) => {
    const url = new URL(request.url ?? '/', `http://127.0.0.1:${PORT}`);

    if (TOKEN.length > 0 && url.searchParams.get('access_token') !== TOKEN) {
        console.log('鉴权失败：access_token 不匹配');
        client.close(1008, 'invalid token');
        return;
    }

    socket = client;
    console.log(`机器人已连接（假 OneBot 服务端 :${PORT}）`);

    client.on('message', (raw) => {
        let payload;

        try {
            payload = JSON.parse(String(raw));
        } catch {
            return;
        }

        const response = handleAction(payload);

        client.send(JSON.stringify(response));
    });

    client.on('close', () => {
        if (socket === client) {
            socket = null;
            console.log('机器人已断开');
        }
    });
});

server.on('listening', () => {
    console.log(`假 OneBot 服务端已启动：ws://127.0.0.1:${PORT}/`);
    console.log(`群 ${GROUP_ID}，机器人账号 ${SELF_ID}，你扮演 ${NICKNAME}(${USER_ID})`);
    console.log('直接输入文字 = @机器人 发消息；输入 /say 文字 = 不 @ 的普通消息；输入 /quit 退出\n');

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

    rl.on('line', (line) => {
        const text = line.trim();

        if (text.length === 0) {
            return;
        }

        if (text === '/quit' || text === '/exit') {
            rl.close();
            server.close();
            process.exit(0);
        }

        if (text.startsWith('/say ')) {
            sendGroupMessage(text.slice('/say '.length), false);
            return;
        }

        sendGroupMessage(text, true);
    });
});
