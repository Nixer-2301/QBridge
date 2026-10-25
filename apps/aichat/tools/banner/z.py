import sys
import time
import colorsys
import math
from pyfiglet import Figlet

RESET = "\033[0m"
HIDE_CURSOR = "\033[?25l"
SHOW_CURSOR = "\033[?25h"
CLEAR = "\033[H\033[2J"

def get_rgb(hue, val):
    """hue (0-360度), val (0-1明度)"""
    r, g, b = colorsys.hsv_to_rgb(hue / 360.0, 1.0, val)
    return int(r * 255), int(g * 255), int(b * 255)

def colorize_2d(art, offset):
    lines = art.split("\n")
    out = []
    
    for row_idx, line in enumerate(lines):
        row_out = []
        for col_idx, ch in enumerate(line):
            if ch == " ":
                row_out.append(ch)
            else:
                wave = math.sin((col_idx * 0.15 + row_idx * 0.3 - offset * 0.12))
                
                # 【核心修改】
                # 中心点 50，振幅 20 -> 色相范围严格控制在 30°(纯橙) 到 70°(亮黄)
                hue = 50 + wave * 20 
                
                # 明暗对比保持不变
                val = 0.85 + wave * 0.15
                
                r, g, b = get_rgb(hue, val)
                row_out.append(f"\033[38;2;{r};{g};{b}m{ch}")
        row_out.append(RESET)
        out.append("".join(row_out))
        
    return "\n".join(out)

def main():
    fig = Figlet(font="slant")
    text = "Q B r i d g e" 
    art = fig.renderText(text)

    sys.stdout.write(HIDE_CURSOR)
    offset = 0

    try:
        while True:
            sys.stdout.write(CLEAR)
            sys.stdout.write(colorize_2d(art, offset) + "\n")
            sys.stdout.flush()
            
            offset += 1
            time.sleep(0.0375)  # 0.8x 舒适流速
    except KeyboardInterrupt:
        pass
    finally:
        sys.stdout.write(SHOW_CURSOR + RESET)
        print("\nQBridge · bye")

if __name__ == "__main__":
    main()
