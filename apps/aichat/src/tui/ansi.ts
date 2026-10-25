export const ESC = '\u001b[';
export const RESET = `${ESC}0m`;
export const BOLD = `${ESC}1m`;
export const DIM = `${ESC}2m`;

export const ENTER_ALT_SCREEN = `${ESC}?1049h`;
export const EXIT_ALT_SCREEN = `${ESC}?1049l`;
export const HIDE_CURSOR = `${ESC}?25l`;
export const SHOW_CURSOR = `${ESC}?25h`;
export const DISABLE_WRAP = `${ESC}?7l`;
export const ENABLE_WRAP = `${ESC}?7h`;
export const ENABLE_MOUSE = `${ESC}?1000h${ESC}?1006h`;
export const DISABLE_MOUSE = `${ESC}?1000l${ESC}?1006l`;
export const CLEAR_LINE = `${ESC}2K`;
export const CLEAR_SCREEN = `${ESC}H${ESC}2J`;

export const FG = {
    gray: `${ESC}90m`,
    red: `${ESC}31m`,
    green: `${ESC}32m`,
    yellow: `${ESC}33m`,
    blue: `${ESC}34m`,
    magenta: `${ESC}35m`,
    cyan: `${ESC}36m`,
    white: `${ESC}37m`,
    orange: `${ESC}38;2;229;160;40m`,
} as const;

export function moveTo(row: number, column = 1): string {
    return `${ESC}${row};${column}H`;
}

/** 去掉 ANSI 转义，便于测试与按宽度计算。 */
export function stripAnsi(text: string): string {
    return text.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '');
}
