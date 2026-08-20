/**
 * index.ts — public surface of the movie-director orchestration core.
 *
 * Pure Bun (no pi-SDK dependency) so it is unit-testable and importable from
 * the extension OR a future CLI. The extension layer (extensions/) wraps this
 * in a s2-agent tool dispatcher.
 */
export * from "./pipeline.ts";
export * from "./checkpoint.ts";
export * from "./schema.ts";
export * from "./cost.ts";
export * from "./decision-log.ts";
export * from "./registry.ts";
export * from "./paths.ts";
export * from "./selector.ts";
export * from "./bridge.ts";
export * from "./providers.ts";
export * from "./caption.ts";
export * from "./runpy_image.ts";
export * from "./runpy_tts.ts";
export * from "./character_lock.ts";
export * from "./spawn.ts";
export * from "./compose.ts";
export * from "./compose_motion.ts";
export * from "./remotion.ts";
export * from "./ffprobe.ts";
export * from "./precompose-gate.ts";
export * from "./tool-scope.ts";
export * from "./dispatch.ts";
export * from "./driver.ts";
export * from "./waypoints.ts";
export * from "./assets-encoder.ts";
export * from "./driver-wiring.ts";
export * from "./waypoint-runtime.ts";

// providers.ts and compose.ts each keep an INDEPENDENT ffmpeg-availability
// cache + test-override (separate feature-detection call sites, separate
// state — not a shared toggle). Both `export *` above so the barrel star-
// exports collide on this one name; disambiguate explicitly (TS2308) in favor
// of providers.ts's, since it's the one probeConfigured()/the tool selector
// reads. compose.test.ts / providers.test.ts / selector.test.ts already import
// each file's own version directly and are unaffected by this barrel pick.
export { _setFfmpegAvailableForTest } from "./providers.ts";
