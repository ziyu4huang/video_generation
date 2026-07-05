/**
 * index.tsx — Remotion entry point for the movie-director templated compose
 * stage. `registerRoot` is what `remotion render src/index.tsx Explainer out.mp4`
 * resolves. The composition is data-driven: the orchestrator (src/remotion.ts
 * in the parent extension) writes an ExplainerProps JSON to disk and passes it
 * via `--props`.
 *
 * Ported & focused from OpenMontage/remotion-composer/src/Explainer.tsx — the
 * chart/anime/terminal scene families are intentionally dropped; this is the
 * MVP that satisfies G-full: cuts → Sequences with ken-burns/zoom/pan motion,
 * manual crossfade transitions between cuts, a section_title overlay layer, and
 * narration/music audio layers.
 */
import { registerRoot } from "remotion";
import { Root } from "./Root";

registerRoot(Root);
