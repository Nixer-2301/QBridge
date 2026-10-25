import fs from 'node:fs';
import zlib from 'node:zlib';

function readField(buffer, offset, length) {
    const slice = buffer.subarray(offset, offset + length);
    const end = slice.indexOf(0);
    const raw = end >= 0 ? slice.subarray(0, end) : slice;

    return raw.toString('ascii');
}

function isZeroBlock(buffer) {
    for (const byte of buffer) {
        if (byte !== 0) {
            return false;
        }
    }

    return true;
}

/**
 * bsdtar 在 Windows 上把所有文件写成 0666，`./start.sh` 会没有可执行位。
 * 这里逐条改写 tar 头里的 mode（并重算校验和），再 gzip，得到权限正确的 tar.gz。
 *
 * @param {string} tarPath 未压缩 tar
 * @param {string} gzPath 输出 tar.gz
 * @param {(name: string) => boolean} isExecutable 判定某个路径是否需要 +x
 * @returns {{ patched: number, entries: number }}
 */
export function patchTarModes(tarPath, gzPath, isExecutable) {
    const buffer = fs.readFileSync(tarPath);
    let offset = 0;
    let patched = 0;
    let entries = 0;

    while (offset + 512 <= buffer.length) {
        const header = buffer.subarray(offset, offset + 512);

        if (isZeroBlock(header)) {
            break;
        }

        entries += 1;

        const name = readField(header, 0, 100);
        const prefix = readField(header, 345, 155);
        const size = Number.parseInt(readField(header, 124, 12).trim() || '0', 8) || 0;
        const type = String.fromCharCode(header[156] || 0x30);
        const fullName = prefix.length > 0 ? `${prefix}/${name}` : name;

        let mode = null;

        if (type === '5') {
            mode = 0o755;
        } else if (type === '2') {
            mode = 0o777;
        } else if (type === '0' || type === '\0' || type === '') {
            mode = isExecutable(fullName) ? 0o755 : 0o644;
        }

        if (mode !== null) {
            header.write(`${mode.toString(8).padStart(7, '0')}\0`, 100, 'ascii');

            // 校验和字段先按 8 个空格参与计算，再写入「6 位八进制 + NUL + 空格」。
            header.fill(0x20, 148, 156);

            let sum = 0;

            for (const byte of header) {
                sum += byte;
            }

            header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii');
            patched += 1;
        }

        offset += 512 + Math.ceil(size / 512) * 512;
    }

    fs.writeFileSync(gzPath, zlib.gzipSync(buffer, { level: 9 }));

    return { patched, entries };
}
