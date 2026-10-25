import fs from 'node:fs';

/**
 * 极简 .env 读取：不覆盖已存在的环境变量。
 * 解析失败的行会被忽略，避免因为一行注释让机器人起不来。
 */
export function loadEnvFile(filePath: string, env: NodeJS.ProcessEnv = process.env): string[] {
    if (!fs.existsSync(filePath)) {
        return [];
    }

    const loaded: string[] = [];
    const content = fs.readFileSync(filePath, 'utf8');

    for (const rawLine of content.split(/\r?\n/)) {
        const line = rawLine.trim();

        if (line.length === 0 || line.startsWith('#') || !line.includes('=')) {
            continue;
        }

        const index = line.indexOf('=');
        let key = line.slice(0, index).trim();

        if (key.startsWith('export ')) {
            key = key.slice('export '.length).trim();
        }

        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
            continue;
        }

        let value = line.slice(index + 1).trim();

        if (
            (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
            (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
        ) {
            value = value.slice(1, -1);
        }

        if (env[key] === undefined) {
            env[key] = value;
            loaded.push(key);
        }
    }

    return loaded;
}
