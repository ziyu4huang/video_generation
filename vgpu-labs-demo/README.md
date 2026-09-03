# vgpu labs demo — what happened, and how the bug was solved

Evaluation of https://github.com/vercel-labs/vgpu (vgpu.sh, Vercel Labs) on
2026-09-02. Five working demos, one layout bug found and fixed.

## What vgpu is

A TypeScript WebGPU library with one tiny API (`init` → `Gpu`, `effect` /
`draw` / `frame`, bindings set by their WGSL names) that runs the same code in
three runtimes: the browser (canvas surface), headless Node (bundled Dawn
adapter → **Metal** on this Mac), and tests (deterministic mock adapter).

## The demos here

| Demo | Path | What it proves |
|---|---|---|
| Headless Node render | `node-demo/render.mjs` | `vgpu/node` renders 150 frames of a WGSL plasma in pure Node via Dawn/Metal, reads pixels back (`await target.read()`), writes PNGs → `ffmpeg` → `plasma.mp4`. No browser involved. |
| Raymarched fractal | `browser-demo/src/examples/raymarched-fractal/` | Canonical gallery example (Sierpiński + HDR bloom), hosted unmodified in Vite. |
| Black hole | `browser-demo/src/examples/black-hole/` | Gravitational lensing example, same hosting. |
| **Solar system** (ours) | `browser-demo/src/solar/` | Original 3D scene built on `vgpu/scene` meshes + `draw()`: one unit sphere **instanced** 9× (sun + planets, orbits computed in the vertex shader from a time uniform), **700 hash-seeded asteroid-belt instances**, Saturn's `ring()` geometry with an alpha-blended Cassini gap, thin `torus()` orbit lines, custom point-light-from-origin shading (banded gas giants, continents, polar caps, animated plasma sun), CPU orbit camera with drag + wheel zoom, and a post effect compositing starfield + screen-space sun glow + vignette. |
| **紫禁城 Palace** (ours) | `browser-demo/src/palace/` | Original axial Forbidden City: 午門 → 金水橋 → 太和門 → 太和殿 (triple marble terrace, double-eave 庑殿 roof) → 中和/保和 → 乾清宮 → 神武門, red perimeter walls with 角樓 turrets, moat, Jingshan + pavilion, ~200 instanced parts in ONE `storage()` buffer (pos/scale/color/material-mode per instance) shared by box / hip-roof / pyramid / hill draws, **custom parametric hip-roof mesh** (`geometry(gpu, {buffers, indices})` with finite-difference normals) for the upturned-eave roofs, material-mode fragment shading (glazed tiles with world-space ribs, 彩畫 beams, studded doors, water, paving), golden-hour post sky (gradient + clouds + projected sun), drag/wheel camera with idle drift. |
| **MacBook 拆解** (ours) | `browser-demo/src/macbook/` | Exploded-view teardown: assembled it's an open MacBook (live wallpaper screen, studded keyboard, trackpad, glowing logo); an explode slider (or 自動拆解 ping-pong) slides ~130 instanced parts apart into a teardown stack with per-group stagger — bottom shell → battery → logic board + spinning fans + copper heat pipe → keyboard deck → display lid, which flattens from open to flat while lifting (per-instance rotX animated by group in the vertex shader). Hinge trick: rotate around the instance origin with a `localOffset` applied pre-rotation. Studio backdrop + fake contact shadow. |

## The 3D-object vocabulary vgpu gives you

- **Procedural meshes** (`vgpu/scene`): `sphere`, `icosphere`, `box`, `capsule`, `cone`, `cylinder`, `torus`, `ring`/`disk` (annulus), `plane`, platonic solids, `fullscreenQuad` — descriptors uploaded via `geometry(gpu, …)`, or bring your own `GPUBuffer`s.
- **Instancing**: `instances` on a draw (or per call) — one sphere mesh became 9 planets + 700 asteroids here; the docs' own demo drives a 125k-cube lattice.
- **No-geometry spawns**: skip vertex buffers entirely and position triangles from `@builtin(vertex_index)` + `@builtin(instance_index)` — GPU particle systems in one draw call.
- **Storage-driven vertices / compute**: WebGPU compute for displacement, particles, tensors — the class of thing WebGL simply cannot do.
- **Raymarched SDF** (the gallery's approach): any implicit shape — the black hole and fractal tabs are pure fragment shaders.
- **Multi-pass composition**: `frame(gpu, f => f.pass(…))` — this scene renders planets into a depth target, then a post pass composites starfield + glow onto the canvas.

Run: `cd browser-demo && bun install && bun run dev` → http://localhost:8177 (NOT 127.0.0.1 —
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

1. **Package managers: originally npm, converted to bun (2026-09-03).** Under
   npm 11, postinstall scripts are blocked by default (`esbuild` genuinely
   needs approval; `webgpu`'s is a no-op). Under bun, both dirs install from
   the machine-global cache (`~/.bun/install/cache`) via **APFS copy-on-write
   clones**: a fresh 95 MB `node-demo/node_modules` costs **~0.8 MB** of real
   disk, and warm installs take <2 s. bun blocks both postinstalls too —
   irrelevant: `esbuild` runs from its platform binary, and `vgpu` resolves
   the Dawn binary through its own cache chain (`npx vgpu doctor` → healthy).
   Both `bun.lock` files are committed.
2. **Vite 7 binds localhost IPv6-only** here: `curl 127.0.0.1:8177` refuses,
   `localhost` / `[::1]` work.
3. **`.wgsl` URLs look untransformed if curled directly** (Vite serves raw
   text as a static fallback). The loader only engages through the module
   graph — verify with the `?import` query, which returns
   `export default { version: 1, wgsl: "…" }`.
4. **`gpu.dispose()` is mandatory** at the end of a `vgpu/node` script, or
   Dawn's polling keeps the Node process alive forever.
5. **`frame(gpu, …)` must never nest.** `scene.render()` opens its own frame,
   so the browser component drives it from a plain `requestAnimationFrame`
   loop — calling it inside vgpu's `frameLoop` callback throws
   `Nested frame(gpu) is invalid`. (Caught by the CDP probe: WebGPU init is
   async and rAF-driven, so `--virtual-time-budget` screenshots show nothing;
   use a real-time CDP wait instead.)
6. **The browser canvas has no depth buffer** — 3D renders into
   `target(gpu, { depth: true })`, then a post pass composites to the surface.
7. **Verify headless-first**: `render-check.mjs` runs the identical scene
   through `vgpu/node` → PNGs, so shader/geometry bugs are fixed against real
   pixels before the browser is involved at all.
8. **Custom geometry is just a descriptor**: `geometry(gpu, { buffers:
   [{ stride, attributes: { position: "float32x3", normal: "float32x3" },
   data }], indices, vertexCount })` — attributes bind to the shader by NAME
   via reflection, same layout as the kit's meshes, so one shader can draw
   box meshes and hand-built meshes alike (the palace roofs are parametric
   hip roofs with finite-difference normals).
9. **One storage buffer rewritten per draw doesn't work** — `queue.writeBuffer`
   ops enqueued before a frame all execute before its passes, so the last
   write clobbers every earlier draw. Use one buffer per draw (the palace
   keeps four: boxes / hip roofs / pyramids / hill).
10. **Pattern-scale + moiré on instanced geometry**: a pattern frequency
    defined in unit-local coords warps when instances stretch (the palace
    roofs looked like banana leaves), and two fine line grids (tile ribs ×
    courses) interfere into plume moiré at grazing angles. Fix: pattern in
    WORLD space (pass instance scale as a varying; or use `worldPos`),
    hard-switched at face boundaries (`select(…)`) instead of `mix`-blended.
11. **The post quad's uv.y is 0 at the TOP of the screen** (screen convention,
    matching the CPU-projected sun position) — a sky gradient written against
    raw uv.y paints the warm horizon at the zenith; flip with `1.0 - uv.y`.

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
- `node_modules/` dirs are gitignored (global rule); they are bun-installed
  from the machine-global cache via APFS clones, so their on-disk size is
  almost entirely shared blocks (measured: a fresh 95 MB tree costs ~0.8 MB).
  `node-demo/frames/` (14 MB of regenerable PNGs) is ignored specifically.
  `browser-demo/public/plasma.mp4` (~120 KB) IS tracked so the "Headless Node
  render" tab works out of the box.
- Each demo dir has its own committed `bun.lock` (it is NOT a bun workspace
  member, so the canonical `bun-apps/bun.lock` doesn't cover it; the repo-wide
  `package-lock.json` ban is why no npm lockfile is tracked).
- To run after a fresh clone: `cd vgpu-labs-demo/browser-demo && bun install
  && bun run dev` → http://localhost:8177. The headless demo: `cd
  ../node-demo && bun install && node render.mjs && ffmpeg -framerate 30 -i
  frames/f-%04d.png -c:v libx264 -pix_fmt yuv420p -crf 20 plasma.mp4`.
