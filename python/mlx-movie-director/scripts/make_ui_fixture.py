"""Composite realistic screen-capture UI chrome onto a base image.

Produces a fixture for testing `image purify --remove screen-ui`: a video-frame
base with a player control bar (play triangle + progress + time), a top-left
REC indicator + timestamp, a top-right battery readout, and a corner watermark.
"""
import os
import sys
from PIL import Image, ImageDraw, ImageFont

SRC = sys.argv[1] if len(sys.argv) > 1 else "../video_generation__output/subtitle_test_before.png"
OUT = sys.argv[2] if len(sys.argv) > 2 else "../video_generation__output/_purify_demo/screen_ui_before.png"


def font(sz: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    for p in (
        "/System/Library/Fonts/Helvetica.ttc",
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
        "/System/Library/Fonts/Menlo.ttc",
    ):
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, sz)
            except Exception:
                pass
    return ImageFont.load_default()


def main() -> None:
    base = Image.open(SRC).convert("RGBA")
    w, h = base.size
    ui = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(ui)

    # --- Top-left: REC dot + timestamp ---
    f_rec, f_ts = font(max(28, h // 40)), font(max(22, h // 50))
    d.ellipse([20, 24, 20 + 18, 24 + 18], fill=(240, 40, 40, 255))
    d.text((46, 22), "REC", fill=(255, 255, 255, 255), font=f_rec)
    d.text((20, 56), "2026-06-25  14:32:07", fill=(255, 255, 255, 255), font=f_ts)

    # --- Top-right: battery readout ---
    f_bat = font(max(22, h // 50))
    bx, by = w - 150, 28
    d.rectangle([bx, by, bx + 60, by + 28], outline=(255, 255, 255, 255), width=3)
    d.rectangle([bx + 60, by + 8, bx + 68, by + 20], fill=(255, 255, 255, 255))
    d.rectangle([bx + 6, by + 6, bx + 6 + int(48 * 0.87), by + 22], fill=(120, 230, 120, 255))
    d.text((bx + 74, by - 2), "87%", fill=(255, 255, 255, 255), font=f_bat)

    # --- Bottom: translucent player control bar ---
    bar_h = max(90, h // 12)
    by0 = h - bar_h
    d.rectangle([0, by0, w, h], fill=(0, 0, 0, 175))
    # Play triangle
    cx, cy, r = 60, by0 + bar_h // 2, 22
    d.polygon([(cx - r // 2, cy - r), (cx - r // 2, cy + r), (cx + r, cy)], fill=(255, 255, 255, 255))
    # Progress track + played portion
    tx0, tx1 = 110, w - 160
    ty = by0 + bar_h // 2
    d.rounded_rectangle([tx0, ty - 4, tx1, ty + 4], radius=4, fill=(255, 255, 255, 90))
    played = tx0 + int((tx1 - tx0) * 0.32)
    d.rounded_rectangle([tx0, ty - 4, played, ty + 4], radius=4, fill=(255, 80, 80, 255))
    d.ellipse([played - 9, ty - 9, played + 9, ty + 9], fill=(255, 255, 255, 255))
    # Time text
    f_time = font(max(20, h // 56))
    d.text((tx0, ty + 14), "00:42", fill=(220, 220, 220, 255), font=f_time)
    d.text((tx1 - 60, ty + 14), "03:18", fill=(220, 220, 220, 255), font=f_time)

    # --- Bottom-right: corner watermark logo (circle + letters) ---
    lx, ly = w - 70, h - bar_h - 70
    d.ellipse([lx, ly, lx + 44, ly + 44], fill=(255, 255, 255, 60), outline=(255, 255, 255, 180), width=2)
    d.text((lx + 10, ly + 10), "TV", fill=(255, 255, 255, 230), font=font(24))

    out = Image.alpha_composite(base, ui).convert("RGB")
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    out.save(OUT)
    print(f"[fixture] wrote {OUT} ({w}x{h})")


if __name__ == "__main__":
    main()
