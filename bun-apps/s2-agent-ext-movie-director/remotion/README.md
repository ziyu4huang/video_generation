# movie-director Remotion composer

Standalone [Remotion](https://remotion.dev) composition renderer for the
movie-director **templated compose** stage (orchestration iteration 4). This is
the "full compose" tier — transitions, overlays, ken-burns animation — layered on
top of the ffmpeg straight-cut foundation in `src/compose.ts`.

Ported & focused from `OpenMontage/remotion-composer`. The chart / anime /
terminal scene families are intentionally dropped; this is the MVP that satisfies
the G-full gate: cuts → Sequences with ken-burns/zoom/pan motion, manual
crossfade transitions between cuts, a `section_title` overlay layer, and
narration/music audio layers.

## Why a standalone subdir (not a Bun workspace member)

Remotion drags in React 18 + a headless Chromium download — a heavy, separate
dep tree that must NOT pollute the Bun workspace (`bun.lock`) or the extension's
bundle. So this package is **standalone**: its `node_modules` (and any lockfile)
are gitignored. The orchestrator (`../src/remotion.ts`) spawns whichever
`remotion` binary is available — it does not import Remotion into the extension.

## Install (operator, one-time per machine)

```bash
cd bun-apps/s2-agent-ext-movie-director/remotion
bun install            # or: npm install   (writes a local, gitignored lockfile)
```

The first `remotion render` ensures a headless browser. To skip the download and
reuse the system Chrome on macOS, set before rendering:

```bash
export REMOTION_BROWSER_EXECUTABLE="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
```

## Render manually (Studio preview or CLI)

```bash
bun run start                                           # Remotion Studio (live preview)
bun run render -- --props=public/demo-props.json out.mp4   # headless render
```

## How the orchestrator drives it

`renderRemotion()` (in `../src/remotion.ts`):

1. builds an `ExplainerProps` JSON from the extended `edit_decisions`
   (cuts/overlays/audio/transition/theme + `width`/`height`/`fps`),
2. writes it to `<workDir>/remotion-props.json`,
3. spawns `remotion render <entryAbs> Explainer <output> --props=<propsJson>
   --codec=h264` (binary resolved via `REMOTION_BIN` env → PATH → `bunx remotion`),
4. ffprobes the output and returns a `render_report` (same shape as the ffmpeg
   foundation).

The `--props` payload is the single contract between the TS orchestrator and the
TSX composition; see `ExplainerProps` in `src/Explainer.tsx`.
