import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const wasmPathOverride = process.env['QB_RESVG_WASM'];

let wasmReady: Promise<typeof import('@resvg/resvg-wasm')> | undefined;

/** wasm 与包入口同目录；用 createRequire 解析，vitest 里也能跑。 */
function resolveWasmPath(): string {
    if (wasmPathOverride && wasmPathOverride.trim().length > 0) {
        return wasmPathOverride.trim();
    }

    return require.resolve('@resvg/resvg-wasm/index_bg.wasm');
}

/** resvg 的 wasm 只在第一次渲染时加载（~2.4MB，避免每次重读）。 */
async function loadRenderer(): Promise<typeof import('@resvg/resvg-wasm')> {
    if (!wasmReady) {
        wasmReady = (async () => {
            const module = await import('@resvg/resvg-wasm');

            await module.initWasm(fs.readFileSync(resolveWasmPath()));

            return module;
        })();
    }

    return wasmReady;
}

let fontCache: Buffer | undefined;

function loadFont(fontPath: string): Buffer {
    if (!fontCache) {
        fontCache = fs.readFileSync(fontPath);
    }

    return fontCache;
}

/** 把 SVG 渲染成 PNG（纯 wasm，无原生依赖，Windows/Linux 通用）。 */
export async function renderSvgToPng(svg: string, options: { fontPath: string; width: number }): Promise<Buffer> {
    const { Resvg } = await loadRenderer();
    const resvg = new Resvg(svg, {
        background: '#ffffff',
        fitTo: { mode: 'width', value: options.width },
        font: {
            fontBuffers: [loadFont(options.fontPath)],
            loadSystemFonts: false,
            defaultFontFamily: 'Noto Sans SC',
        },
    });

    return Buffer.from(resvg.render().asPng());
}
