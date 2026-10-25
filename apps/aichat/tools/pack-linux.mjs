#!/usr/bin/env node
/**
 * 打 Linux 离线包：自带 Node，目标机不需要安装 Node.js。
 *
 *   node tools/pack-linux.mjs                 # 默认 x64，Node 版本取 QBridge/.node-version
 *   node tools/pack-linux.mjs --arch arm64
 *
 * 产物（apps/aichat/build/）：
 *   qbridge-aichat-<版本>-linux-<arch>.zip      解压后 bash start.sh
 *   qbridge-aichat-<版本>-linux-<arch>.tar.gz   保留可执行位，可 ./start.sh
 *   qbridge-aichat-<版本>-linux-<arch>.sha256
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { patchTarModes } from './lib/tar-modes.mjs';

const APP_DIR = process.cwd();
const BUILD_DIR = path.join(APP_DIR, 'build');
const CACHE_DIR = path.join(BUILD_DIR, 'cache');
const STAGING_ROOT = path.join(BUILD_DIR, 'staging');
const LINUX_DIR = path.join(APP_DIR, 'deploy', 'linux');

const argv = process.argv.slice(2);
const argValue = (name, fallback) => {
    const index = argv.indexOf(name);

    return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
};

const arch = argValue('--arch', 'x64');
const nodeVersion =
    argValue('--node', process.env.QB_NODE_VERSION) ??
    fs.readFileSync(path.join(APP_DIR, '..', '..', '.node-version'), 'utf8').trim();
const pkg = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'package.json'), 'utf8'));
const packageName = `qbridge-aichat-${pkg.version}-linux-${arch}`;
const staging = path.join(STAGING_ROOT, packageName);
const outBase = path.join(BUILD_DIR, packageName);

function log(message) {
    console.log(`[pack] ${message}`);
}

function run(command, args, options = {}) {
    execFileSync(command, args, { stdio: 'inherit', cwd: APP_DIR, ...options });
}

function copyDir(from, to) {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.cpSync(from, to, { recursive: true, dereference: true });
}

function assertLf(filePath) {
    const content = fs.readFileSync(filePath);

    if (content.includes(0x0d)) {
        throw new Error(`${filePath} 含有 CRLF，Linux 下会报 $'\\r': command not found`);
    }
}

/** 用 libarchive 解下载好的 Node 压缩包，只取 bin/node 与 LICENSE。 */
async function prepareNodeRuntime() {
    fs.mkdirSync(CACHE_DIR, { recursive: true });

    const tarballName = `node-v${nodeVersion}-linux-${arch}.tar.gz`;
    const tarballPath = path.join(CACHE_DIR, tarballName);
    const url = `https://nodejs.org/dist/v${nodeVersion}/${tarballName}`;

    if (!fs.existsSync(tarballPath)) {
        log(`下载 ${url}`);

        const response = await fetch(url);

        if (!response.ok) {
            throw new Error(`下载 Node 失败：HTTP ${response.status} ${url}`);
        }

        fs.writeFileSync(tarballPath, Buffer.from(await response.arrayBuffer()));
    } else {
        log(`复用缓存 ${tarballName}`);
    }

    const extractDir = path.join(CACHE_DIR, `node-${arch}`);

    fs.rmSync(extractDir, { recursive: true, force: true });
    fs.mkdirSync(extractDir, { recursive: true });

    const inner = `node-v${nodeVersion}-linux-${arch}`;

    run('tar', ['-xzf', tarballPath, '-C', extractDir, '--strip-components=1', `${inner}/bin/node`, `${inner}/LICENSE`]);

    const nodeBin = path.join(extractDir, 'bin', 'node');
    const nodeLicense = path.join(extractDir, 'LICENSE');

    if (!fs.existsSync(nodeBin)) {
        throw new Error('Node 压缩包里没有 bin/node');
    }

    // 确认拿到的是 Linux ELF，而不是解压出错的空文件。
    const head = fs.readFileSync(nodeBin).subarray(0, 4).toString('hex');

    if (head !== '7f454c46') {
        throw new Error(`bin/node 不是 ELF 文件（magic=${head}）`);
    }

    fs.mkdirSync(path.join(staging, 'runtime', 'node', 'bin'), { recursive: true });
    fs.copyFileSync(nodeBin, path.join(staging, 'runtime', 'node', 'bin', 'node'));
    fs.copyFileSync(nodeLicense, path.join(staging, 'runtime', 'node', 'LICENSE'));

    const size = fs.statSync(nodeBin).size;

    log(`Node v${nodeVersion} linux-${arch}（${(size / 1024 / 1024).toFixed(1)} MB）`);
}

async function main() {
    log(`打包 ${packageName}`);

    log('编译 TypeScript');
    run(process.execPath, [path.join('node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.json']);

    fs.rmSync(staging, { recursive: true, force: true });
    fs.mkdirSync(staging, { recursive: true });

    // app/：dist + 生产依赖（只有一个纯 JS SDK，无原生模块）
    copyDir(path.join(APP_DIR, 'dist'), path.join(staging, 'app', 'dist'));
    for (const dependency of ['@snowluma/sdk', '@resvg/resvg-wasm']) {
        copyDir(
            path.join(APP_DIR, 'node_modules', ...dependency.split('/')),
            path.join(staging, 'app', 'node_modules', ...dependency.split('/')),
        );
    }

    fs.writeFileSync(
        path.join(staging, 'app', 'package.json'),
        `${JSON.stringify(
            {
                name: 'qbridge-aichat',
                version: pkg.version,
                private: true,
                type: 'module',
                engines: { node: '>=22.6.0' },
                dependencies: { '@snowluma/sdk': '2.2.0', '@resvg/resvg-wasm': '2.6.2' },
            },
            null,
            4,
        )}\n`,
        'utf8',
    );

    await prepareNodeRuntime();

    copyDir(path.join(APP_DIR, 'prompts'), path.join(staging, 'prompts'));
    // 字体用于 🦌 日历卡片渲染（OFL 许可，见 assets/fonts）
    copyDir(path.join(APP_DIR, 'assets'), path.join(staging, 'assets'));
    fs.mkdirSync(path.join(staging, 'config'), { recursive: true });
    fs.copyFileSync(
        path.join(APP_DIR, 'config.example.json'),
        path.join(staging, 'config', 'config.example.json'),
    );
    fs.copyFileSync(path.join(APP_DIR, '.env.example'), path.join(staging, '.env.example'));

    fs.mkdirSync(path.join(staging, 'deploy'), { recursive: true });

    for (const file of ['start.sh', 'install-service.sh', 'qbridge-aichat.service', 'README-deploy.md']) {
        fs.copyFileSync(path.join(LINUX_DIR, file), path.join(staging, 'deploy', file));
    }

    fs.copyFileSync(path.join(LINUX_DIR, 'start.sh'), path.join(staging, 'start.sh'));

    fs.writeFileSync(
        path.join(staging, 'VERSION'),
        [
            `qbridge-aichat ${pkg.version}`,
            `built: ${new Date().toISOString()}`,
            `node: v${nodeVersion} linux-${arch}`,
            `platform: linux ${arch}`,
            '',
        ].join('\n'),
        'utf8',
    );

    for (const script of ['start.sh', 'deploy/install-service.sh']) {
        assertLf(path.join(staging, script));
    }

    // tar.gz：先做未压缩 tar，改写权限后 gzip（bsdtar 在 Windows 上写不出 +x）
    log('生成 tar.gz（修正可执行位）');
    fs.mkdirSync(BUILD_DIR, { recursive: true });

    const rawTar = path.join(BUILD_DIR, `${packageName}.tar`);
    const tarGz = `${outBase}.tar.gz`;

    run('tar', ['-cf', rawTar, '-C', STAGING_ROOT, packageName]);

    const { patched, entries } = patchTarModes(
        rawTar,
        tarGz,
        (name) => name.endsWith('/start.sh') || name.endsWith('/install-service.sh') || name.endsWith('/bin/node'),
    );

    fs.rmSync(rawTar, { force: true });
    log(`tar.gz 条目 ${entries}，修正权限 ${patched} 个`);

    log('生成 zip');
    const zipPath = `${outBase}.zip`;

    fs.rmSync(zipPath, { force: true });
    run('tar', ['-a', '-cf', zipPath, '-C', STAGING_ROOT, packageName]);

    const sha = (file) =>
        crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    const zipHash = sha(zipPath);
    const tarHash = sha(tarGz);
    const checksums = [
        `${zipHash}  ${path.basename(zipPath)}`,
        `${tarHash}  ${path.basename(tarGz)}`,
        '',
    ].join('\n');

    fs.writeFileSync(`${outBase}.sha256`, checksums, 'utf8');

    const mb = (file) => (fs.statSync(file).size / 1024 / 1024).toFixed(1);

    log('');
    log(`zip    ${path.relative(APP_DIR, zipPath)}  ${mb(zipPath)} MB`);
    log(`tar.gz ${path.relative(APP_DIR, tarGz)}  ${mb(tarGz)} MB`);
    log(`sha256 ${zipHash.slice(0, 16)}…`);
    log('完成。服务器上：unzip → 填 config/.env → bash start.sh --check');
}

main().catch((error) => {
    console.error(`[pack] 失败：${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
});


