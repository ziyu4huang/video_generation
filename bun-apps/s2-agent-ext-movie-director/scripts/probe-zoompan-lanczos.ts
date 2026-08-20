/**
 * probe-zoompan-lanczos.ts — empirical sharpness probe for the zoompan path.
 *
 * compose_motion pre-scales to 2x target with ffmpeg's default scaler (bicubic)
 * before baking zoompan, and zoompan does its OWN internal resample. The goal's
 * Item B asks whether a lanczos resample (or larger working size + final lanczos
 * downscale) survives zoompan to sharpen ken-burns. Probe it — don't theorize.
 *
 * Renders the SAME still-image ken-burns frame (diagonal motion, 1080p) through
 * several candidate filtergraphs, extracts the final frame, and measures the
 * laplacian variance (a standard sharpness metric: variance of the
 * second-derivative image; higher = sharper, too high with edge ringing is a flag).
 * Laplacian is computed in JS over a raw grayscale PGM dump (no python/cv2 dep).
 *
 * Run: bun bun-apps/s2-agent-ext-movie-director/scripts/probe-zoompan-lanczos.ts
 */
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

function run(cmd: string, argv: string[]): Promise<{ code: number; stderr: string }> {
  return new Promise((res) => {
    const p = spawn(cmd, argv, { stdio: ["ignore", "pipe", "pipe"] });
    let e = "";
    p.stderr.on("data", (d) => (e += d));
    p.stdout.on("data", () => {});
    p.on("error", () => res({ code: -1, stderr: e }));
    p.on("exit", (c) => res({ code: c ?? -1, stderr: e }));
  });
}

/** Render a still to a 1080p ken-burns frame with a given zoompan filtergraph. */
async function renderVariant(src: string, vf: string[], swsFlags: string | null, out: string): Promise<boolean> {
  const argv = ["-y", "-loop", "1", "-i", src, "-t", "2"];
  if (swsFlags) argv.push("-sws_flags", swsFlags);
  argv.push("-vf", vf.join(","), "-frames:v", "1", "-an", out);
  const r = await run("ffmpeg", argv);
  return r.code === 0 && existsSync(out);
}

/** Laplacian variance over a raw grayscale PGM (P5) of size w×h. Higher = sharper. */
function laplacianVariance(pgmPath: string): number | null {
  const buf = readFileSync(pgmPath);
  // Parse P5 header: "P5\n<w> <h>\n<maxval>\n" then raw bytes.
  let i = 0;
  const readToken = (): string => {
    while (i < buf.length && (buf[i] === 0x20 || buf[i] === 0x0a || buf[i] === 0x0d || buf[i] === 0x09)) i++;
    let s = "";
    while (i < buf.length && buf[i] !== 0x20 && buf[i] !== 0x0a && buf[i] !== 0x0d && buf[i] !== 0x09) s += String.fromCharCode(buf[i++]!);
    return s;
  };
  const magic = readToken();
  if (magic !== "P5") return null;
  const w = Number(readToken());
  const h = Number(readToken());
  const _max = Number(readToken());
  i++; // single whitespace after maxval
  if (!w || !h) return null;
  const px = new Uint8Array(buf.buffer, buf.byteOffset + i, w * h);
  // 4-neighbor laplacian: L = 4*c - up - down - left - right. Mean + variance.
  let sum = 0;
  const lap = new Float64Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const idx = y * w + x;
      const v = 4 * px[idx]! - px[idx - 1]! - px[idx + 1]! - px[idx - w]! - px[idx + w]!;
      lap[idx] = v;
      sum += v;
    }
  }
  const n = (w - 2) * (h - 2);
  const mean = sum / n;
  let varSum = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const idx = y * w + x;
      const d = lap[idx]! - mean;
      varSum += d * d;
    }
  }
  return varSum / n;
}

async function toPgm(png: string, pgm: string, w: number, h: number): Promise<boolean> {
  const r = await run("ffmpeg", ["-y", "-loglevel", "error", "-i", png, "-vf", `scale=${w}:${h},format=gray`, "-f", "image2", "-vcodec", "pgm", pgm]);
  return r.code === 0 && existsSync(pgm);
}

async function main() {
  const dir = mkdtempSync(join(tmpdir(), "md-lanczos-"));
  console.log("workdir:", dir);
  const W = 1920, H = 1080, fps = 30, dur = 2, T = Math.ceil(dur * fps);
  const receipt: Record<string, { laplacian_variance: number | null; vf: string }> = {};
  try {
    // A high-detail source: testsrc2 has concentric rings + gradients + noise that
    // reveal softness. No drawtext (avoids fontfile coupling in the probe).
    const src = join(dir, "src.png");
    const r0 = await run("ffmpeg", [
      "-y", "-f", "lavfi", "-i", `testsrc2=size=${W}x${H}:rate=30`,
      "-frames:v", "1", src,
    ]);
    if (r0.code !== 0 || !existsSync(src)) { console.error("fixture failed"); process.exit(2); }

    // Shared zoompan expr (diagonal ken-burns) — same motion in every variant.
    const zIn = `min(1.0+0.4*on/${T},1.5)`;
    const cx = `(iw-iw/zoom)/2`;
    const cy = `(ih-ih/zoom)/2`;
    const zp = `zoompan=z='${zIn}':d=1:s=${W}x${H}:fps=${fps}:x='${cx}+((iw-iw/zoom)*0.25*on/${T})':y='${cy}'`;

    const variants: Array<{ name: string; vf: string[]; sws?: string }> = [
      // OLD: 2x pre-scale (default bicubic) + zoompan — the current compose_motion path.
      { name: "old_2x_bilinear", vf: [`scale=${W * 2}:${H * 2}:force_original_aspect_ratio=increase`, `crop=${W * 2}:${H * 2}`, zp, `fps=${fps}`] },
      // A: sws_flags=lanczos on the 2x pre-scale.
      { name: "A_2x_lanczos_swsflags", sws: "lanczos", vf: [`scale=${W * 2}:${H * 2}:force_original_aspect_ratio=increase`, `crop=${W * 2}:${H * 2}`, zp, `fps=${fps}`] },
      // B: 3x pre-scale (lanczos via flags) + zoompan, then a FINAL lanczos downscale to target AFTER zoompan.
      { name: "B_3x_final_lanczos", sws: "lanczos+accurate_rnd", vf: [`scale=${W * 3}:${H * 3}:force_original_aspect_ratio=increase`, `crop=${W * 3}:${H * 3}`, zp.replace(`s=${W}x${H}`, `s=${W}x${H}`), `scale=${W}:${H}:flags=lanczos`, `fps=${fps}`] },
      // C: 2x pre-scale + zoompan + final lanczos downscale (zoompan outputs 2x, downscale after).
      { name: "C_2x_zp2x_final_lanczos", sws: "lanczos+accurate_rnd", vf: [`scale=${W * 2}:${H * 2}:force_original_aspect_ratio=increase`, `crop=${W * 2}:${H * 2}`, zp.replace(`s=${W}x${H}`, `s=${W * 2}x${H * 2}`), `scale=${W}:${H}:flags=lanczos`, `fps=${fps}`] },
    ];

    for (const v of variants) {
      const png = join(dir, `${v.name}.png`);
      const ok = await renderVariant(src, v.vf, v.sws ?? null, png);
      if (!ok) { console.log(`${v.name}: RENDER FAILED`); receipt[v.name] = { laplacian_variance: null, vf: v.vf.join(",") }; continue; }
      const pgm = join(dir, `${v.name}.pgm`);
      await toPgm(png, pgm, W, H);
      const lap = laplacianVariance(pgm);
      console.log(`${v.name.padEnd(28)} laplacian_variance = ${lap == null ? "n/a" : lap.toFixed(1)}`);
      receipt[v.name] = { laplacian_variance: lap, vf: v.vf.join(",") };
    }

    // Save the A/B frame pair + summary.
    const receiptDir = join(process.cwd(), "output", "zoompan-lanczos-receipt");
    const { mkdirSync, copyFileSync } = await import("node:fs");
    mkdirSync(receiptDir, { recursive: true });
    for (const v of variants) {
      const png = join(dir, `${v.name}.png`);
      if (existsSync(png)) copyFileSync(png, join(receiptDir, `${v.name}.png`));
    }
    writeFileSync(join(receiptDir, "laplacian.json"), JSON.stringify({ W, H, fps, variants: receipt }, null, 2));
    console.log("receipt:", receiptDir);
  } finally {
    if (process.env.KEEP_SMOKE_DIR) console.log("keeping", dir);
    else rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
