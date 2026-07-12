#!/usr/bin/env python3
"""US 相場局面モニターの OGP / シェア用バナー生成。

JP バナー（濃紺地＋淡いカラーグロー＋「いま、攻めるか、休むか。」＋サブコピー＋URL）を
US 版に。日本株→米国株（S&P 500）、URL を us.stock-buddy.net に差し替える。
2x で描いて縮小しアンチエイリアス。1500x500（Twitter ヘッダー/OGP 比）で出力。
"""
import os
from PIL import Image, ImageDraw, ImageFont, ImageFilter, ImageChops

OUT = os.path.join(os.path.dirname(__file__), "..", "src", "web", "assets")
os.makedirs(OUT, exist_ok=True)

W, H = 3000, 1000  # 2x（→ 1500x500）
BG = (10, 13, 18)
WHITE = (245, 248, 252)
GREY = (150, 160, 173)
GREY_DIM = (120, 130, 143)
ORANGE = (242, 150, 60)
LINK = (108, 150, 230)

HG = "/System/Library/Fonts/ヒラギノ角ゴシック W{}.ttc"
MONO = "/System/Library/Fonts/Menlo.ttc"


def glow(size, cx, cy, r, color):
    """濃紺地に screen 合成する淡い色グローを1枚生成する。"""
    layer = Image.new("RGB", size, (0, 0, 0))
    d = ImageDraw.Draw(layer)
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=color)
    return layer.filter(ImageFilter.GaussianBlur(r * 0.55))


def main():
    img = Image.new("RGB", (W, H), BG)
    # ── 背景のカラーグロー（screen 合成で「光」を足す） ──
    for cx, cy, r, col in [
        (W * 0.16, H * 0.30, 520, (70, 45, 12)),   # 左・オレンジ（dot 周辺の環境光）
        (W * 0.86, H * 0.12, 640, (16, 52, 40)),   # 右上・グリーン/ティール
        (W * 0.72, H * 0.95, 560, (20, 34, 62)),   # 右下・ブルー
        (W * 0.40, H * 0.05, 460, (40, 30, 20)),   # 中上・わずかな暖色
    ]:
        img = ImageChops.screen(img, glow((W, H), int(cx), int(cy), int(r), col))

    d = ImageDraw.Draw(img)
    ML = 180  # 左マージン

    f_eyebrow = ImageFont.truetype(HG.format(6), 60)
    f_head = ImageFont.truetype(HG.format(8), 208)
    f_sub = ImageFont.truetype(HG.format(5), 66)
    f_url = ImageFont.truetype(MONO, 66)

    # ── eyebrow: ● 相場局面モニター（オレンジ dot + グレー字間広め） ──
    ey_y = 150
    dot_r = 17
    d.ellipse([ML, ey_y + 6, ML + dot_r * 2, ey_y + 6 + dot_r * 2], fill=ORANGE)
    # dot のグロー
    gl = glow((W, H), ML + dot_r, ey_y + 6 + dot_r, 70, (90, 55, 15))
    img = ImageChops.screen(img, gl)
    d = ImageDraw.Draw(img)
    d.ellipse([ML, ey_y + 6, ML + dot_r * 2, ey_y + 6 + dot_r * 2], fill=ORANGE)
    tx = ML + dot_r * 2 + 34
    for ch in "相場局面モニター":
        d.text((tx, ey_y), ch, font=f_eyebrow, fill=GREY)
        tx += d.textlength(ch, font=f_eyebrow) + 10  # letter-spacing

    # ── headline: いま、攻めるか、休むか。 ──
    d.text((ML - 6, 250), "いま、攻めるか、休むか。", font=f_head, fill=WHITE)

    # ── subtitle: 米国株（S&P 500）の相場局面を、毎日ひと目で。 ▶ us.stock-buddy.net ──
    sub_y = 700
    sub = "米国株（S&P 500）の相場局面を、毎日ひと目で。"
    d.text((ML, sub_y), sub, font=f_sub, fill=GREY)
    x = ML + d.textlength(sub, font=f_sub) + 24
    d.text((x, sub_y + 6), "▶", font=f_sub, fill=GREY_DIM)
    x += d.textlength("▶", font=f_sub) + 20
    d.text((x, sub_y + 2), "us.stock-buddy.net", font=f_url, fill=LINK)

    # ── 出力（1500x500 と OGP 用 1200x630 も） ──
    banner = img.resize((1500, 500), Image.LANCZOS)
    banner.save(os.path.join(OUT, "og-banner.png"))
    # 1200x630（OGP 標準）: 上下に余白を足して中央寄せ
    ogp = Image.new("RGB", (1200, 630), BG)
    b2 = img.resize((1200, 400), Image.LANCZOS)
    ogp.paste(b2, (0, (630 - 400) // 2))
    ogp.save(os.path.join(OUT, "og-image.png"))
    print("wrote og-banner.png (1500x500) / og-image.png (1200x630) to", os.path.abspath(OUT))


if __name__ == "__main__":
    main()
