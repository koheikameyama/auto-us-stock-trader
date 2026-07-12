#!/usr/bin/env python3
"""US 相場局面モニター（STOCK BUDDY US）のロゴ生成。

JP の STOCK BUDDY ロゴ（濃紺地＋上昇バーチャート＋ワードマーク）を踏襲しつつ、
US 相場局面モニターの regime アクセント（アンバー/オレンジ）に置き換えた US 版。
高解像度で描いて縮小しアンチエイリアスをかけ、icon-512/192 と favicon.ico を出力。
"""
import os
from PIL import Image, ImageDraw, ImageFont

OUT = os.path.join(os.path.dirname(__file__), "..", "src", "web", "assets")
os.makedirs(OUT, exist_ok=True)

S = 2048  # 作業解像度（4x → 512 に縮小）
NAVY = (26, 35, 79)          # 濃紺（JP 踏襲）
NAVY_HI = (34, 45, 96)       # 背景の微グラデ上側
WHITE = (244, 247, 252)
AMBER = (242, 133, 30)       # regime hot アクセント
AMBER_HI = (247, 168, 74)
AMBER_LO = (214, 106, 16)

FONT_PATH = "/System/Library/Fonts/SFCompactRounded.ttf"


def rounded_bar(d, x, y, w, h, r, fill):
    d.rounded_rectangle([x, y, x + w, y + h], radius=r, fill=fill)


def main():
    img = Image.new("RGB", (S, S), NAVY)
    d = ImageDraw.Draw(img)

    # 背景: 角丸スクエア + 縦グラデ（上をわずかに明るく）
    for i in range(S):
        t = i / S
        c = tuple(int(NAVY_HI[k] + (NAVY[k] - NAVY_HI[k]) * t) for k in range(3))
        d.line([(0, i), (S, i)], fill=c)
    # 角丸マスク
    mask = Image.new("L", (S, S), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, S, S], radius=int(S * 0.22), fill=255)
    bg = Image.new("RGB", (S, S), NAVY)
    ImageDraw.Draw(bg)  # noqa
    base = Image.new("RGB", (S, S), (11, 15, 22))
    base.paste(img, (0, 0), mask)
    img = base
    d = ImageDraw.Draw(img)

    # ── 上昇バーチャート（中央上） ──
    cx = S // 2
    bw = int(S * 0.10)          # バー幅
    gap = int(S * 0.035)
    baseline = int(S * 0.50)    # バー下端
    heights = [int(S * 0.14), int(S * 0.20), int(S * 0.27)]
    colors = [AMBER_HI, AMBER, AMBER_LO]
    n = 3
    total_w = n * bw + (n - 1) * gap
    x0 = cx - total_w // 2
    tops = []
    for i in range(n):
        x = x0 + i * (bw + gap)
        h = heights[i]
        y = baseline - h
        rounded_bar(d, x, y, bw, h, int(bw * 0.28), colors[i])
        tops.append((x + bw // 2, y))

    # ── 上昇矢印（バーの上を左下→右上に貫く） ──
    ax0 = x0 - int(bw * 0.15)
    ay0 = baseline - int(S * 0.02)
    ax1 = x0 + total_w + int(bw * 0.15)
    ay1 = baseline - heights[-1] - int(S * 0.075)
    lw = int(S * 0.028)
    d.line([(ax0, ay0), (ax1, ay1)], fill=WHITE, width=lw, joint="curve")
    # 矢じり
    ah = int(S * 0.055)
    d.polygon([
        (ax1 + int(ah * 0.15), ay1 - int(ah * 0.1)),
        (ax1 - ah, ay1 - int(ah * 0.2)),
        (ax1 - int(ah * 0.25), ay1 + ah),
    ], fill=WHITE)

    # ── US バッジ（アンバーの丸ピル） ──
    bf = ImageFont.truetype(FONT_PATH, int(S * 0.055))
    txt = "US"
    tb = d.textbbox((0, 0), txt, font=bf, stroke_width=int(S * 0.004))
    tw, th = tb[2] - tb[0], tb[3] - tb[1]
    pad_x, pad_y = int(S * 0.03), int(S * 0.018)
    pill_w, pill_h = tw + pad_x * 2, th + pad_y * 2
    px = cx - pill_w // 2
    py = int(S * 0.055)
    d.rounded_rectangle([px, py, px + pill_w, py + pill_h], radius=pill_h // 2, fill=AMBER)
    d.text((px + pad_x - tb[0], py + pad_y - tb[1]), txt, font=bf,
           fill=NAVY, stroke_width=int(S * 0.004), stroke_fill=NAVY)

    # ── ワードマーク STOCK / BUDDY（白・丸ゴシック太字） ──
    wf = ImageFont.truetype(FONT_PATH, int(S * 0.155))
    stroke = int(S * 0.010)  # 太字化

    def draw_center(text, y):
        b = d.textbbox((0, 0), text, font=wf, stroke_width=stroke)
        w = b[2] - b[0]
        d.text((cx - w // 2 - b[0], y), text, font=wf, fill=WHITE,
               stroke_width=stroke, stroke_fill=WHITE)

    draw_center("STOCK", int(S * 0.56))
    draw_center("BUDDY", int(S * 0.74))

    # ── 出力 ──
    for size, name in [(512, "icon-512.png"), (192, "icon-192.png")]:
        img.resize((size, size), Image.LANCZOS).save(os.path.join(OUT, name))
    ico = img.resize((256, 256), Image.LANCZOS)
    ico.save(os.path.join(OUT, "favicon.ico"),
             sizes=[(16, 16), (32, 32), (48, 48), (64, 64)])
    print("wrote icon-512.png / icon-192.png / favicon.ico to", os.path.abspath(OUT))


if __name__ == "__main__":
    main()
