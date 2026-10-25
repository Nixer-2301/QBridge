export interface Region {
    /** 1 起的屏幕行号。 */
    top: number;
    height: number;
}

export interface Layout {
    header: Region;
    body: Region;
    footer: Region;
    /** 顶部是否使用完整字符画（窗口太矮时退化成单行标题）。 */
    fullHeader: boolean;
}

export const MIN_FULL_HEADER_ROWS = 24;
export const FOOTER_HEIGHT = 5;
export const COMPACT_FOOTER_HEIGHT = 3;
export const MIN_BODY_ROWS = 3;
export const ART_ROWS = 6;

/**
 * 三段式布局：顶部横幅固定、底部状态框固定、中间日志区占剩余空间。
 * 窗口过矮时横幅退化成一行、状态框退化成一行，日志区至少保留 3 行。
 */
export function computeLayout(rows: number, artRows: number = ART_ROWS): Layout {
    const fullHeader = rows >= MIN_FULL_HEADER_ROWS;
    const headerHeight = fullHeader ? artRows + 1 : 2;
    const footerHeight =
        rows - headerHeight - MIN_BODY_ROWS >= FOOTER_HEIGHT ? FOOTER_HEIGHT : COMPACT_FOOTER_HEIGHT;
    const bodyHeight = Math.max(1, rows - headerHeight - footerHeight);

    return {
        header: { top: 1, height: headerHeight },
        body: { top: 1 + headerHeight, height: bodyHeight },
        footer: { top: 1 + headerHeight + bodyHeight, height: footerHeight },
        fullHeader,
    };
}

/** 日志区可见行数（顶部留一行给滚动提示）。 */
export function bodyLineCapacity(layout: Layout): number {
    return Math.max(0, layout.body.height - 1);
}
