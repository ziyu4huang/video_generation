"""Composite a UI overlay directly OVER the face region of a portrait.

Fixture for validating the remove-path face-preserve guard: the overlay sits on
the face, so a naive high-denoise inpaint would regenerate/break the face. The
guard must cap denoise and keep the face intact.
"""
import os
import sys
from PIL import Image, ImageDraw, ImageFont

SRC = sys.argv[1] if len(sys.argv) > 1 else "../video_generation__output/subtitle_test_before.png"
OUT = sys.argv[2] if len(sys.argv) > 2 else "../video_generation__output/_purify_demo/face_overlay_before.png"
# Where to drop the overlay (face region of a typical portrait). Overridable.
FX = int(sys.argv[3]) if len(sys.argv) > 3 else 0  # x offset from center
YFRAC = float(sys.argv[4]) if len(sys.argv) > 4 else 0.37  # bar y as fraction of H (0.37 ≈ face center on the subtitle fixture)


def font(sz):
    for p in ("/System/Library/Fonts/Helvetica.ttc",
              "/System/Library/Fonts/Supplemental/Arial Bold.ttf"):
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, sz)
            except Exception:
                pass
    return ImageFont.load_default()


def main():
    base = Image.open(SRC).convert("RGBA")
    w, h = base.size
    ui = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(ui)

    # A COMPACT "LIVE" badge + timestamp sitting on ONE SIDE of the face (~25%
    # coverage) — the realistic guardable case. A full-width bar would hide the
    # face from SAM3, so the guard couldn't see it; a partial overlay leaves most
    # of the face visible → detectable → the guard triggers.
    bw, bh = int(w * 0.30), max(80, h // 12)
    bx0 = int(w * (0.22 + FX / 1000.0))
    by0 = int(h * YFRAC)
    d.rounded_rectangle([bx0, by0, bx0 + bw, by0 + bh],
                        radius=14, fill=(0, 0, 0, 210),
                        outline=(255, 60, 60, 255), width=3)
    d.ellipse([bx0 + 18, by0 + bh // 2 - 9, bx0 + 18 + 18, by0 + bh // 2 + 9],
              fill=(240, 40, 40, 255))
    d.text((bx0 + 44, by0 + 10), "LIVE",
           fill=(255, 255, 255, 255), font=font(max(28, h // 38)))
    d.text((bx0 + 14, by0 + bh - 38), "14:32",
           fill=(255, 255, 255, 255), font=font(max(24, h // 46)))

    out = Image.alpha_composite(base, ui).convert("RGB")
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    out.save(OUT)
    print(f"[fixture] wrote {OUT} (overlay badge at y={by0},{bh}h, x={bx0})")


if __name__ == "__main__":
    main()
