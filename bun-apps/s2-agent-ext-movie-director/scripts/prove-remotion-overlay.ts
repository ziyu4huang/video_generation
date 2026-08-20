/**
 * prove-remotion-overlay.ts — the install-justifying receipt for compose_remotion.
 *
 * The goal's Item A asks: does Remotion earn its install weight by rendering a
 * TEMPLATED edit that compose_motion CANNOT? Yes — `section_title` overlays.
 * compose_motion (src/compose_motion.ts) consumes `edit.cuts` only; it never
 * reads `edit.overlays`, so a section_title layer is silently DROPPED. Remotion's
 * Explainer.tsx paints overlays as a layer over playing media.
 *
 * This script renders the SAME edit (two media cuts + one section_title overlay)
 * through BOTH runtimes, extracts the frame at the overlay's midpoint, and diffs
 * the overlay-anchor region (top-left 8%/70% per Explainer.tsx's default anchor).
 * The Remotion frame carries the title text there; the motion frame does not.
 * Exits 0 only if the Remotion overlay region differs from its own off-anchor
 * control AND from the motion runtime's same region (the templated value-add).
 *
 * Run: bun bun-apps/s2-agent-ext-movie-director/scripts/prove-remotion-overlay.ts
 * (needs the bundled remotion/ install + a headless browser;前者 via `bun install`
 * in remotion/, 后者 via `remotion browser ensure`.)
 */
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { renderRemotion, composeMotion, type RemotionEditDecisions } from "../src/index.ts";

function run(cmd: string, argv: string[]): Promise<number> {
  return new Promise((res) => {
    const p = spawn(cmd, argv, { stdio: ["ignore", "pipe", "pipe"] });
    p.stdout.on("data", () => {});
    p.stderr.on("data", () => {});
    p.on("error", () => res(-1));
    p.on("exit", (c) => res(c ?? -1));
  });
}

/** Mean luminance (Y, 0-255) of a W×H region (top-left fractional anchor) of a frame PNG. */
async function regionMeanLuma(png: string, fx: number, fy: number, fw: number, fh: number, totalW: number, totalH: number): Promise<number> {
  const x = Math.round(fx * totalW);
  const y = Math.round(fy * totalH);
  const w = Math.round(fw * totalW);
  const h = Math.round(fh * totalH);
  // crop → signalstats → metadata=print surfaces YAVG (mean luma) to stderr.
  const r = await runCapture("ffmpeg", ["-hide_banner", "-i", png, "-vf", `crop=${w}:${h}:${x}:${y},signalstats,metadata=print`, "-an", "-f", "null", "/dev/null"]);
  const m = r.match(/YAVG=([0-9.]+)/);
  return m ? Number(m[1]) : -1;
}

function runCapture(cmd: string, argv: string[]): Promise<string> {
  return new Promise((res) => {
    const p = spawn(cmd, argv, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    p.stderr.on("data", (d) => (out += d));
    p.stdout.on("data", (d) => (out += d));
    p.on("error", () => res(""));
    p.on("exit", () => res(out));
  });
}

async function extractFrame(video: string, ts: number, out: string): Promise<boolean> {
  const c = await run("ffmpeg", ["-y", "-loglevel", "error", "-ss", ts.toFixed(3), "-i", video, "-frames:v", "1", out]);
  return c === 0 && existsSync(out);
}

async function main() {
  const dir = mkdtempSync(join(tmpdir(), "md-rmx-overlay-"));
  console.log("workdir:", dir);
  const W = 1280, H = 720;
  let exit = 0;
  try {
    const a = join(dir, "a.png");
    const b = join(dir, "b.png");
    // Two distinctly-colored solid backgrounds (the overlay must contrast).
    await run("ffmpeg", ["-f", "lavfi", "-i", "color=c=0x1e293b:s=1280x720:d=1", "-frames:v", "1", "-y", a]);
    await run("ffmpeg", ["-f", "lavfi", "-i", "color=c=0x3b1e293b:s=1280x720:d=1", "-frames:v", "1", "-y", b]);

    const edit: RemotionEditDecisions = {
      version: "1.0",
      cuts: [
        { id: "a", source: a, in_seconds: 0, out_seconds: 3, animation: "ken-burns" },
        { id: "b", source: b, in_seconds: 3, out_seconds: 6, animation: "zoom-in" },
      ],
      // The templated feature: a section_title overlay layered over the first cut.
      overlays: [{ type: "section_title", in_seconds: 0.5, out_seconds: 2.5, text: "Remotion Overlay", subtitle: "compose_motion drops this" }],
      transition: "crossfade",
      transitionSeconds: 0.5,
      theme: "dark",
    };

    // 1. Render via Remotion (overlays rendered).
    const rmxOut = join(dir, "remotion.mp4");
    const t0 = Date.now();
    const rmx = await renderRemotion(edit, { workDir: dir, output: rmxOut, width: W, height: H, fps: 30 });
    console.log(`remotion render ${( (Date.now() - t0) / 1000).toFixed(1)}s — outputs=${rmx.outputs.length} notes=${JSON.stringify(rmx.verification_notes)}`);

    // 2. Render via compose_motion (overlays IGNORED — the gap).
    const motOut = join(dir, "motion.mp4");
    const t1 = Date.now();
    const mot = await composeMotion(edit, { workDir: join(dir, "mot"), output: motOut, width: W, height: H, fps: 30 });
    console.log(`motion render  ${( (Date.now() - t1) / 1000).toFixed(1)}s — outputs=${mot.outputs.length} notes=${JSON.stringify(mot.verification_notes)}`);

    if (rmx.outputs.length !== 1 || mot.outputs.length !== 1) {
      console.error("FAIL: a runtime produced no output");
      process.exit(2);
    }

    // 3. Extract the overlay-midpoint frame (t=1.5s) from each.
    const rmxFrame = join(dir, "rmx_frame.png");
    const motFrame = join(dir, "mot_frame.png");
    await extractFrame(rmxOut, 1.5, rmxFrame);
    await extractFrame(motOut, 1.5, motFrame);

    // 4. Luminance in the overlay anchor (top-left 8%/8%, 70%maxWidth → ~50% width)
    //    vs an off-anchor control (bottom-right corner, no overlay).
    const ANCHOR = { fx: 0.08, fy: 0.10, fw: 0.45, fh: 0.22 }; // matches SectionTitle top-left
    const CONTROL = { fx: 0.70, fy: 0.70, fw: 0.25, fh: 0.25 }; // bottom-right, no text
    const rmxAnchor = await regionMeanLuma(rmxFrame, ANCHOR.fx, ANCHOR.fy, ANCHOR.fw, ANCHOR.fh, W, H);
    const rmxControl = await regionMeanLuma(rmxFrame, CONTROL.fx, CONTROL.fy, CONTROL.fw, CONTROL.fh, W, H);
    const motAnchor = await regionMeanLuma(motFrame, ANCHOR.fx, ANCHOR.fy, ANCHOR.fw, ANCHOR.fh, W, H);
    const motControl = await regionMeanLuma(motFrame, CONTROL.fx, CONTROL.fy, CONTROL.fw, CONTROL.fh, W, H);

    console.log(`region luma (YDV, 0-255):`);
    console.log(`  remotion overlay-anchor=${rmxAnchor.toFixed(1)}  control=${rmxControl.toFixed(1)}  delta=${Math.abs(rmxAnchor - rmxControl).toFixed(1)}`);
    console.log(`  motion   overlay-anchor=${motAnchor.toFixed(1)}  control=${motControl.toFixed(1)}  delta=${Math.abs(motAnchor - motControl).toFixed(1)}`);

    // Proof: the overlay paints the anchor ONLY under Remotion. A solid-bg frame
    // has near-zero anchor/control delta; the title text raises it substantially.
    const rmxPainted = Math.abs(rmxAnchor - rmxControl) > 12;
    const motSilent = Math.abs(motAnchor - motControl) < 6;
    console.log(`remotion painted the anchor (delta>12): ${rmxPainted}`);
    console.log(`motion dropped the overlay (delta<6):   ${motSilent}`);

    if (rmxPainted && motSilent) {
      console.log("PASS: section_title overlay renders under Remotion and is DROPPED by compose_motion — the install's value-add.");
    } else {
      console.error("FAIL: overlay distinction not proven");
      exit = 3;
    }

    // 5. Persist the frame pair as the receipt artifact.
    const receiptDir = join(process.cwd(), "output", "remotion-overlay-receipt");
    try {
      const { mkdirSync, copyFileSync } = await import("node:fs");
      mkdirSync(receiptDir, { recursive: true });
      copyFileSync(rmxFrame, join(receiptDir, "remotion_overlay_frame.png"));
      copyFileSync(motFrame, join(receiptDir, "motion_overlay_frame.png"));
      const summary = {
        rendered_at: new Date().toISOString(),
        edit,
        remotion: { output: rmxOut, render_time_seconds: rmx.render_time_seconds, overlay_anchor_luma: rmxAnchor, control_luma: rmxControl, anchor_delta: Math.abs(rmxAnchor - rmxControl) },
        motion: { output: motOut, render_time_seconds: mot.render_time_seconds, overlay_anchor_luma: motAnchor, control_luma: motControl, anchor_delta: Math.abs(motAnchor - motControl) },
        verdict: rmxPainted && motSilent ? "remotion-renders-overlay-motion-drops-it" : "inconclusive",
      };
      writeFileSync(join(receiptDir, "proof.json"), JSON.stringify(summary, null, 2));
      console.log("receipt:", receiptDir);
    } catch (e) {
      console.log("(receipt persist skipped:", String(e), ")");
    }
  } finally {
    if (process.env.KEEP_SMOKE_DIR) console.log("keeping", dir);
    else rmSync(dir, { recursive: true, force: true });
  }
  process.exit(exit);
}

main().catch((e) => { console.error(e); process.exit(1); });
