/**
 * tool-gating augmentation — the SINGLE SHARED SOURCE OF TRUTH.
 *
 * Lets a tool's `ToolDefinition` carry an owner-declared `gating` field.
 * Formerly duplicated (byte-identical) across ~14 packages so no cross-package
 * type dependency was introduced. That duplication is now collapsed here.
 *
 * Consumers surface the augmentation in their isolated typecheck EITHER by
 * listing this package in their tsconfig `compilerOptions.types`:
 *     "types": ["bun", "@repo/s2-agent-core-interface"]
 * (preferred — program-wide, no arbitrary host file; used by the 10 packages
 * migrated in .planning/specs/2026-08-10-tool-gating-contract-collapse-design.md),
 * OR with a triple-slash directive on their primary entry:
 *     /// <reference types="@repo/s2-agent-core-interface" />
 * (used by tool-gate / ext-task / power-tool). Either way the package must be
 * declared in package.json — bun-apps/tests/dep-guard.test.ts enforces both edges.
 *
 * `getAllToolDefinitions()` is added at runtime by the repo's
 * `ext-api-get-all-tool-definitions` monkey-patch (bun-apps/s2-agent/src/patches/);
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
 * — hence the top-level `import`. Module augmentations in a module file are
 * picked up once the file is part of the program (via the `/// <reference
 * types="@repo/s2-agent-core-interface" />` directive, or a tsconfig `include`
 * entry); no explicit runtime import is needed.
 *
 * The tool-facing `gating` type is the EXPORTED `Gating` from `./gates.js`
 * (wayfinder ticket 01, phase 01c): `{ core?: boolean; gate?: string }`. The
 * former ambient-global `Gating` (with inline keywords/requires) is deleted —
 * call sites import the type instead of relying on a global augmentation.
 */
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Gating } from "./gates.js";

declare module "@earendil-works/pi-coding-agent" {
  interface ToolDefinition {
    gating?: Gating;
  }
}

/** Runtime surface added by the ext-api-get-all-tool-definitions patch. */
declare module "@earendil-works/pi-coding-agent" {
  interface ExtensionAPI {
    getAllToolDefinitions?(): ToolDefinition[];
  }
}
