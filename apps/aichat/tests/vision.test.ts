import { describe, expect, it } from 'vitest';
import { buildImageParts } from '../src/chat/vision.ts';
import { createLogger } from '../src/logger.ts';
import type { ContentPart, VisionConfig } from '../src/types.ts';

const logger = createLogger('test', 'silent');

function urlOf(part: ContentPart | undefined): string | undefined {
    return part?.type === 'image_url' ? part.image_url.url : undefined;
}

function config(overrides: Partial<VisionConfig> = {}): VisionConfig {
    return { enabled: true, maxImages: 4, maxBytes: 5_242_880, ...overrides };
}

describe('buildImageParts', () => {
    it('http 链接直接透传', async () => {
        const parts = await buildImageParts(['https://gchat.qpic.cn/a.png?rkey=1'], {
            config: config(),
            logger,
        });

        expect(parts).toEqual([
            { type: 'image_url', image_url: { url: 'https://gchat.qpic.cn/a.png?rkey=1' } },
        ]);
    });

    it('data URI 原样保留', async () => {
        const uri = 'data:image/png;base64,iVBORw0KGgo=';
        const parts = await buildImageParts([uri], { config: config(), logger });

        expect(urlOf(parts[0])).toBe(uri);
    });

    it('base64:// 转成 data URI', async () => {
        const parts = await buildImageParts(['base64://iVBORw0KGgo='], { config: config(), logger });

        expect(urlOf(parts[0])).toBe('data:image/jpeg;base64,iVBORw0KGgo=');
    });

    it('忽略本地路径与 QQ 内部 file token', async () => {
        const parts = await buildImageParts(['C:\\Windows\\win.ini', 'abc123.png'], {
            config: config(),
            logger,
        });

        expect(parts).toEqual([]);
    });

    it('去重并限制张数', async () => {
        const parts = await buildImageParts(
            ['https://a/1.png', 'https://a/1.png', 'https://a/2.png', 'https://a/3.png'],
            { config: config({ maxImages: 2 }), logger },
        );

        expect(parts.map((part) => urlOf(part))).toEqual(['https://a/1.png', 'https://a/2.png']);
    });

    it('关闭 vision 时不产生任何图片分段', async () => {
        const parts = await buildImageParts(['https://a/1.png'], {
            config: config({ enabled: false }),
            logger,
        });

        expect(parts).toEqual([]);
    });

    it('超过 maxBytes 的 data URI 被跳过', async () => {
        const big = `data:image/png;base64,${'A'.repeat(2_000)}`;
        const parts = await buildImageParts([big], { config: config({ maxBytes: 1_024 }), logger });

        expect(parts).toEqual([]);
    });
});

