import type { Logger } from '../logger.ts';
import type { ContentPart, VisionConfig } from '../types.ts';

/** data URI 里 base64 的膨胀比例，用于按字节数估算实际体积。 */
const BASE64_RATIO = 4 / 3;

/**
 * 把消息里的图片源转成 OpenAI 兼容的 `image_url` 分段。
 *
 * 只接受三类来源：
 *   - `http(s)://…`  QBridge 的 rkey 链接（最常见）
 *   - `data:image/...;base64,…`  已经内联的数据
 *   - `base64://…`   内联字节
 * 其它形式（本地路径、QQ 内部 file token）直接跳过：既读不到，也避免按消息内容读本机文件。
 */
export async function buildImageParts(
    sources: readonly string[],
    options: { config: VisionConfig; logger: Logger },
): Promise<ContentPart[]> {
    if (!options.config.enabled || sources.length === 0) {
        return [];
    }

    const parts: ContentPart[] = [];
    const seen = new Set<string>();

    for (const source of sources) {
        if (parts.length >= options.config.maxImages) {
            options.logger.debug(`图片数量超过上限 ${options.config.maxImages}，其余忽略`);
            break;
        }

        const url = toImageUrl(source, options);

        if (!url) {
            continue;
        }

        if (seen.has(url)) {
            continue;
        }

        seen.add(url);
        parts.push({ type: 'image_url', image_url: { url } });
    }

    return parts;
}

function toImageUrl(source: string, options: { config: VisionConfig; logger: Logger }): string | null {
    const value = source.trim();

    if (value.length === 0) {
        return null;
    }

    if (/^https?:\/\//i.test(value)) {
        return value;
    }

    if (value.startsWith('data:')) {
        return withinLimit(value, options) ? value : null;
    }

    if (/^base64:\/\//i.test(value)) {
        const inline = `data:image/jpeg;base64,${value.slice('base64://'.length)}`;

        return withinLimit(inline, options) ? inline : null;
    }

    options.logger.debug('跳过无法直接引用的图片源', value.slice(0, 40));

    return null;
}

/** 按 base64 长度估算原始字节，超出配置上限就放弃这张图。 */
function withinLimit(dataUri: string, options: { config: VisionConfig; logger: Logger }): boolean {
    const base64 = dataUri.slice(dataUri.indexOf(',') + 1);
    const bytes = Math.floor(base64.length / BASE64_RATIO);

    if (bytes > options.config.maxBytes) {
        options.logger.warn(
            `图片过大（约 ${Math.round(bytes / 1024)} KB），超过 vision.maxBytes 已跳过`,
        );

        return false;
    }

    return true;
}
