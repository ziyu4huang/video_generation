# vgpu labs demo — what happened, and how the bug was solved

Evaluation of https://github.com/vercel-labs/vgpu (vgpu.sh, Vercel Labs) on
2026-09-02. Three working demos, one layout bug found and fixed.

## What vgpu is

A TypeScript WebGPU library with one tiny API (`init` → `Gpu`, `effect` /
`draw` / `frame`, bindings set by their WGSL names) that runs the same code in
three runtimes: the browser (canvas surface), headless Node (bundled Dawn
adapter → **Metal** on this Mac), and tests (deterministic mock adapter).

## The three demos here

| Demo | Path | What it proves |
|---|---|---|
| Headless Node render | `node-demo/render.mjs` | `vgpu/node` renders 150 frames of a WGSL plasma in pure Node via Dawn/Metal, reads pixels back (`await target.read()`), writes PNGs → `ffmpeg` → `plasma.mp4`. No browser involved. |
| Raymarched fractal | `browser-demo/src/examples/raymarched-fractal/` | Canonical gallery example (Sierpiński + HDR bloom), hosted unmodified in Vite. |
| Black hole | `browser-demo/src/examples/black-hole/` | Gravitational lensing example, same hosting. |

Run: `cd browser-demo && npm run dev` → http://localhost:8177 (NOT 127.0.0.1 —
Vite 7 binds localhost IPv6-only on this machine).

## The bug: "not show in center"

**Symptom.** Both gallery examples rendered as a ~300×150 canvas stuck in the
top-left corner of the page instead of filling/centering.

**Root cause.** The gallery examples ship React components styled with
**Tailwind utility classes** (`h-full w-full overflow-hidden bg-black`,
`block h-full w-full touch-none`) — but they ship no Tailwind (their gallery
site provides it). Hosted on a plain page, every one of those classes is
inert, so the `<canvas>` fell back to the browser default intrinsic size,
300×150, in normal flow at the top-left.

**Why the fix is CSS-only.** `renderer.ts` sizes its output purely from the
canvas's *layout* box — `surface(gpu, canvas, { dpr })` plus a
`ResizeObserver` on the canvas; nothing reads the window. So CSS is the single
source of truth for output size: give the canvas a real layout box and the
renderer follows.

**Fix** (in `browser-demo/index.html`, plain CSS standing in for Tailwind):

```css
.page { position: relative; height: 100%; }
/* The gallery examples assume Tailwind (h-full/w-full/…); replicate that
   here so the canvas fills the viewport instead of sitting 300x150 at
   the top-left. */
.page > div { position: relative; width: 100%; height: 100%; overflow: hidden; background: #000; }
.page canvas { display: block; width: 100%; height: 100%; touch-action: none; }
```

Vite HMR reloaded the page; the fractal then filled the viewport, centered.

## Other gotchas hit while building

1. **npm 11 blocks postinstall scripts by default.** `esbuild` genuinely needs
   its postinstall (platform binary): `npm install-scripts approve esbuild &&
   npm rebuild esbuild`. `webgpu`'s postinstall is NOT needed — the Dawn
   binary is already cached (verified by `npx vgpu doctor` → healthy).
2. **Vite 7 binds localhost IPv6-only** here: `curl 127.0.0.1:8177` refuses,
   `localhost` / `[::1]` work.
3. **`.wgsl` URLs look untransformed if curled directly** (Vite serves raw
   text as a static fallback). The loader only engages through the module
   graph — verify with the `?import` query, which returns
   `export default { version: 1, wgsl: "…" }`.
4. **`gpu.dispose()` is mandatory** at the end of a `vgpu/node` script, or
   Dawn's polling keeps the Node process alive forever.

## Where this code lives (and why NOT `bun-apps/<name>`)

Stored in-repo at `<repo>/vgpu-labs-demo/` — deliberately OUTSIDE `bun-apps/`
(same non-workspace pattern as `dsh-plugin/`, `swift/`, `python/`). In this
repo, `bun-apps/package.json` declares `"workspaces": ["./*"]`, so anything
dropped at `bun-apps/<name>/` instantly becomes a workspace package and trips
the six-gate CI contract — bun.lock refresh, a matrix row in
`.github/workflows/ci.yml.disabled` + `.github/CI.md`, a
`"typecheck": "tsc --noEmit"` script, every binary declared as a
devDependency, a bun-style tsconfig, and bumps to the `ci-local-parity` goldens
(32 rows). That's worth paying for product code (as done for
`bun-apps/zcode-generate-slide-video`), not for a demo.

Layout notes for the in-repo home:
- `browser-demo/node_modules/` (165 MB) is covered by the global `node_modules`
  gitignore; `node-demo/frames/` (14 MB of regenerable PNGs) is ignored
  specifically. `browser-demo/public/plasma.mp4` (~120 KB) IS tracked so the
  "Headless Node render" tab works out of the box.
- The repo bans `package-lock.json` repo-wide (bun.lock is the single
  lockfile) — the global gitignore rule covers browser-demo's npm lockfile
  automatically. This directory is not a bun workspace member; it manages its
  own deps with npm.
- To run after a fresh clone: `cd vgpu-labs-demo/browser-demo && npm install`
  (+ `npm install-scripts approve esbuild && npm rebuild esbuild` if npm gates
  postinstalls), then `npm run dev` → http://localhost:8177. The headless demo:
  `cd ../node-demo && npm install && node render.mjs && ffmpeg -framerate 30 -i frames/f-%04d.png -c:v libx264 -pix_fmt yuv420p -crf 20 plasma.mp4`.
