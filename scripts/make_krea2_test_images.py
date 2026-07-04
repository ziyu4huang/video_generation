#!/usr/bin/env python3
"""Synthesize structured test images for the krea2 ControlNet + Style-Transfer
real-silicon validation (no Depth-Anything preprocessor in this worktree — the
goal explicitly allows a caller-supplied depth PNG).

Produces (1024x1024):
  - control_depth_portrait.png : a centered head-and-shoulders depth map
                                  (bright = near). Composition = vertical bust.
  - control_depth_landscape.png: a horizon/mountain-silhouette depth map.
                                  Composition = wide horizontal band.
  - style_swirl.png            : a warm impressionist swirl (style reference).
"""
import sys, os, math
import numpy as np
from PIL import Image

OUT = sys.argv[1] if len(sys.argv) > 1 else "."
os.makedirs(OUT, exist_ok=True)
S = 1024
yy, xx = np.mgrid[0:S, 0:S].astype(np.float32)
cx, cy = S / 2, S / 2


def norm(t):
    t = (t - t.min()) / (t.max() - t.min() + 1e-9)
    return t


# --- Control A: portrait bust depth ---------------------------------------
# Shoulders band at the bottom, head ellipse centered up high. Near=bright.
head_cy = cy - 180
head_rx, head_ry = 190.0, 240.0
head_d = 1.0 - np.sqrt(((xx - cx) / head_rx) ** 2 + ((yy - head_cy) / head_ry) ** 2)
head = np.clip(head_d, 0, 1) ** 0.6  # smooth falloff
# shoulders: a wide half-ellipse anchored at the bottom
sh_cy = S + 120
sh_rx, sh_ry = 460.0, 360.0
sh_d = 1.0 - np.sqrt(((xx - cx) / sh_rx) ** 2 + ((yy - sh_cy) / sh_ry) ** 2)
sh = np.clip(sh_d, 0, 1) ** 0.6
portrait = np.maximum(head, sh)
# add a subtle nose ridge highlight so it reads as a face
nose = np.exp(-(((xx - cx) / 30.0) ** 2 + ((yy - head_cy + 30) / 160.0) ** 2)) * 0.15
portrait = np.clip(portrait + nose, 0, 1)
Image.fromarray((norm(portrait) * 255).astype(np.uint8)).save(os.path.join(OUT, "control_depth_portrait.png"))

# --- Control B: landscape horizon depth -----------------------------------
# Far background bright sky band on top, dark ground, with a mountain silhouette
# crossing the midline — composition = horizontal, low subject.
horizon = np.clip(1.0 - (yy - 560) / 320.0, 0, 1)          # sky bright up high
# mountain triangle silhouette near the horizon (dark = far recess / negative)
mx = np.abs(xx - cx) / 520.0
mountain = np.clip(1.0 - (yy - (560 - 220 * np.clip(1.0 - mx, 0, 1) ** 1.5)) / 200.0, 0, 1)
landscape = 0.5 * horizon + 0.5 * (1.0 - mountain)
Image.fromarray((norm(landscape) * 255).astype(np.uint8)).save(os.path.join(OUT, "control_depth_landscape.png"))

# --- Style reference: warm impressionist swirl ----------------------------
# Coherent brushstroke field: sinusoidal swirls in saturated warm palette.
fx = xx / S * math.tau
fy = yy / S * math.tau
swirl = np.sin(3 * fx + 2 * np.sin(1.5 * fy)) * np.cos(2.5 * fy - np.sin(fx))
r = 0.85 + 0.15 * np.sin(4 * fx + np.cos(2 * fy))
g = 0.55 + 0.30 * np.sin(3 * fy - np.cos(2.5 * fx))
b = 0.20 + 0.25 * swirl
rgb = np.stack([norm(r), norm(g), norm(b)], axis=-1)
# add visible brushstroke texture (oriented streaks)
streak = np.sin((xx * np.cos(0.5) + yy * np.sin(0.5)) / 8.0)
tex = 0.5 + 0.5 * streak
rgb = np.clip(rgb * (0.7 + 0.5 * tex[..., None]), 0, 1)
Image.fromarray((rgb * 255).astype(np.uint8)).save(os.path.join(OUT, "style_swirl.png"))

print("wrote", os.listdir(OUT))
