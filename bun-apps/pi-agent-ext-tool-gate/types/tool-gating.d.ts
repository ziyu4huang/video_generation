/**
 * tool-gating augmentation — lets a tool's `ToolDefinition` carry an owner-declared
 * `gating` field. Duplicated (identically) in each pilot package so no cross-package
 * type dependency is introduced; a drift-guard test asserts structural agreement.
 *
 * `getAllToolDefinitions()` is added at runtime by the repo's
 * `ext-api-get-all-tool-definitions` monkey-patch (bun-apps/pi-agent/src/patches/);
 * declared here so TypeScript accepts the call.
 *
 * ── Why this file is a MODULE (not a global script) ─────────────────────────
 * A `declare module "P"` block inside a *global ambient script* (a file with no
 * top-level import/export) is treated by TS as an ambient module DECLARATION:
 * it SHADOWS the real package `"@earendil-works/pi-coding-agent"`, so every
 * re-exported member of `ExtensionAPI` (`on`, `getAllTools`, `setActiveTools`,
 * `registerTool`) vanishes with TS2339. Verified empirically.
 *
 * To get an AUGMENTATION (declaration merging) instead, the file must be a MODULE
 * — hence the top-level `import` + `export {}`. Module augmentations in a module
 * file are picked up because the `types` dir glob is in the package tsconfig
 * `include`; no explicit runtime import is needed. `Gating` is surfaced globally
 * via `declare global` so call sites (e.g. `buildEffectiveGates`'s
 * `gating?: Gating` param) reference it without an import — matching the brief's
 * "ambient `Gating`" intent. Verified clean via `bunx tsc --noEmit -p tsconfig.json`
 * (a probe that reads `.gating` off a `ToolDefinition` and `getAllTools()` off an
 * `ExtensionAPI` compiles; the augmentation merges, it does not shadow).
 */
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

declare module "@earendil-works/pi-coding-agent" {
  interface ToolDefinition {
    gating?: Gating;
  }
}

declare global {
  interface Gating {
    /** Bare-word/phrase triggers (tool-gate matchesKeyword). Gate fires if any matches OR `requires` is met.
     *  Optional: a `core:true` tool legitimately has none (it is never keyword-gated). */
    keywords?: string[];
    /** Optional co-occurrence: fires only if prompt has ≥1 noun AND ≥1 verb. */
    requires?: { nouns: string[]; verbs: string[] };
    /** If true, always active (core/escape-hatch); never gated. */
    core?: boolean;
  }
}

/** Runtime surface added by the ext-api-get-all-tool-definitions patch. */
declare module "@earendil-works/pi-coding-agent" {
  interface ExtensionAPI {
    getAllToolDefinitions?(): ToolDefinition[];
  }
}

export {};
