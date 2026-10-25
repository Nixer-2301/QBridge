import path from 'node:path';
import { renderSvgToPng } from './render.ts';

const HEAT = ['#f3f3f5', '#fff3bf', '#ffd666', '#ffa94d', '#ff6b6b', '#d64545'];
const TEXT = '#3b3b3b';
const MUTED = '#9b9b9b';
const WEEKDAYS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
const WEEKDAY_SHORT = ['一', '二', '三', '四', '五', '六', '日'];

const WIDTH = 760;
const PAD = 42;
const CELL = 88;
const GAP = 10;

export interface DeerCardInput {
    /** 群名片/昵称，显示在卡片标题上方 */
    name: string;
    now: Date;
    /** 当月：日号 → 次数 */
    counts: Map<number, number>;
    /** 本周（周一~周日）次数 */
    weekCounts: number[];
    /** 本月累计 */
    monthTotal: number;
    /** 今天次数 */
    todayCount: number;
}

function heatColor(count: number): string {
    if (count <= 0) {
        return HEAT[0] ?? '#f3f3f5';
    }

    return HEAT[Math.min(5, count)] ?? '#d64545';
}

function escapeXml(value: string): string {
    return value
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&apos;');
}

function roundedRect(options: {
    x: number;
    y: number;
    width: number;
    height: number;
    radius: number;
    fill: string;
    extra?: string;
}): string {
    const { x, y, width, height, radius, fill, extra = '' } = options;

    return `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="${radius}" ry="${radius}" fill="${fill}" ${extra}/>`;
}

function text(options: {
    x: number;
    y: number;
    content: string;
    size: number;
    fill?: string;
    anchor?: 'start' | 'middle' | 'end';
    weight?: number;
    letterSpacing?: number;
}): string {
    const { x, y, content, size, fill = TEXT, anchor = 'start', weight = 400, letterSpacing = 0 } = options;

    return `<text x="${x}" y="${y}" font-family="Noto Sans SC" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}" letter-spacing="${letterSpacing}">${escapeXml(content)}</text>`;
}

function weekdayOfFirst(now: Date): number {
    // 周一为一周第一天：0=周一 … 6=周日
    return (new Date(now.getFullYear(), now.getMonth(), 1).getDay() + 6) % 7;
}

function daysInMonth(now: Date): number {
    return new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
}

/** 生成本月日历 SVG（与参考图同款版式）。 */
export function buildDeerCardSvg(input: DeerCardInput): string {
    const { now, name, counts, weekCounts, monthTotal, todayCount } = input;
    const monthLabel = `${now.getFullYear()}年${now.getMonth() + 1}月`;
    const offset = weekdayOfFirst(now);
    const total = daysInMonth(now);
    const weeks = Math.ceil((offset + total) / 7);

    const body: string[] = [];
    const startX = PAD;
    const gridWidth = 7 * CELL + 6 * GAP;

    // 卡片背景
    body.push(roundedRect({ x: 16, y: 16, width: WIDTH - 32, height: 0, radius: 28, fill: '#ffffff' }));

    // 标题
    body.push(text({ x: WIDTH / 2, y: 78, content: `${name} 的本月鹿管足迹`, size: 34, anchor: 'middle', weight: 600 }));
    body.push(text({ x: WIDTH / 2, y: 116, content: monthLabel, size: 22, fill: MUTED, anchor: 'middle' }));

    // 本周回顾
    body.push(text({ x: startX, y: 168, content: '本周回顾', size: 22, fill: '#6b6b6b' }));

    const boxWidth = (gridWidth - 6 * GAP) / 7;
    const boxY = 186;

    WEEKDAYS.forEach((label, index) => {
        const count = weekCounts[index] ?? 0;
        const x = startX + index * (boxWidth + GAP);
        const isToday = index === ((now.getDay() + 6) % 7);

        body.push(
            roundedRect({
                x,
                y: boxY,
                width: boxWidth,
                height: 88,
                radius: 16,
                fill: count > 0 ? heatColor(count) : '#f6f6f8',
                extra: isToday ? 'stroke="#f0b429" stroke-width="2"' : '',
            }),
        );
        body.push(
            text({ x: x + boxWidth / 2, y: boxY + 30, content: label, size: 17, fill: count > 0 ? '#6b4d00' : MUTED, anchor: 'middle' }),
        );
        body.push(
            text({
                x: x + boxWidth / 2,
                y: boxY + 68,
                content: String(count),
                size: 28,
                fill: count > 0 ? '#5a4200' : '#c4c4c8',
                anchor: 'middle',
                weight: 600,
            }),
        );
    });

    // 日历标题
    const monthTitleY = boxY + 88 + 62;
    body.push(text({ x: WIDTH / 2, y: monthTitleY, content: monthLabel, size: 26, anchor: 'middle', weight: 500 }));

    // 星期表头
    const headerY = monthTitleY + 46;
    WEEKDAY_SHORT.forEach((label, index) => {
        body.push(
            text({
                x: startX + index * (CELL + GAP) + CELL / 2,
                y: headerY,
                content: label,
                size: 19,
                fill: MUTED,
                anchor: 'middle',
            }),
        );
    });

    // 日期格子
    const gridTop = headerY + 18;
    const cellHeight = 92;

    for (let index = 0; index < total; index += 1) {
        const slot = offset + index;
        const row = Math.floor(slot / 7);
        const column = slot % 7;
        const dayNumber = index + 1;
        const count = counts.get(dayNumber) ?? 0;
        const x = startX + column * (CELL + GAP);
        const y = gridTop + row * (cellHeight + GAP);
        const isToday =
            dayNumber === now.getDate() &&
            now.getMonth() === new Date(now.getTime()).getMonth() &&
            now.getFullYear() === new Date(now.getTime()).getFullYear();

        body.push(
            roundedRect({
                x,
                y,
                width: CELL,
                height: cellHeight,
                radius: 16,
                fill: heatColor(count),
                extra: isToday ? 'stroke="#f0b429" stroke-width="2"' : '',
            }),
        );
        body.push(
            text({
                x: x + 14,
                y: y + 28,
                content: String(dayNumber),
                size: 18,
                fill: count > 0 ? '#5a4200' : '#a8a8ad',
            }),
        );

        if (count > 0) {
            body.push(
                text({
                    x: x + CELL / 2,
                    y: y + cellHeight - 18,
                    content: `${count}次`,
                    size: 16,
                    fill: '#5a4200',
                    anchor: 'middle',
                    weight: 500,
                }),
            );
        }
    }

    const gridBottom = gridTop + weeks * (cellHeight + GAP);

    // 图例
    const legendY = gridBottom + 44;
    let legendX = startX;

    body.push(text({ x: legendX, y: legendY + 16, content: '0次', size: 18, fill: MUTED }));
    legendX += 52;

    for (const [index, color] of HEAT.entries()) {
        body.push(roundedRect({ x: legendX, y: legendY, width: 34, height: 22, radius: 6, fill: color }));
        legendX += 42;

        if (index === 0) {
            continue;
        }
    }

    body.push(text({ x: legendX + 4, y: legendY + 16, content: '5次及以上', size: 18, fill: MUTED }));

    // 汇总
    const footerY = legendY + 78;
    body.push(
        text({
            x: WIDTH / 2,
            y: footerY,
            content: `本月累计 ${monthTotal} 次`,
            size: 26,
            anchor: 'middle',
            weight: 500,
        }),
    );
    body.push(
        text({
            x: WIDTH / 2,
            y: footerY + 34,
            content: todayCount > 0 ? `今天 ${todayCount} 次` : '今天还没有记录',
            size: 18,
            fill: MUTED,
            anchor: 'middle',
        }),
    );

    const height = Math.ceil(footerY + 64);

    // 背景尺寸按实际高度回填（先占位再替换）
    body[0] = roundedRect({
        x: 16,
        y: 16,
        width: WIDTH - 32,
        height: height - 32,
        radius: 28,
        fill: '#ffffff',
    });

    return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${height}" viewBox="0 0 ${WIDTH} ${height}">
<rect width="${WIDTH}" height="${height}" fill="#fafafa"/>
${body.join('\n')}
</svg>`;
}

/** 渲染成 PNG，供 QQ 图片消息使用。 */
export async function renderDeerCardPng(input: DeerCardInput, options: { fontPath: string }): Promise<Buffer> {
    return renderSvgToPng(buildDeerCardSvg(input), { fontPath: options.fontPath, width: WIDTH });
}

export function resolveFontPath(baseDir: string): string {
    return path.resolve(baseDir, 'assets', 'fonts', 'NotoSansSC-Regular.ttf');
}
