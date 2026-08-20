// Types entry for `@repo/s2-agent-core-interface`.
//
// WHY THIS FILE EXISTS (the packaging puzzle):
//   - `/// <reference types="@repo/s2-agent-core-interface" />` resolves the
//     package's `exports.types` condition. A `reference types` directive needs a
//     `.d.ts` (NOT a `.ts` source — verified empirically: a `.ts` types entry is
//     found but its module augmentation is NOT applied, and tool-gate/power-tool
//     then fail with "Property 'gating' does not exist on type 'ToolDefinition'").
//   - `import { SEAM_KEYS, publishSeam, ... } from "@repo/s2-agent-core-interface"`
//     ALSO resolves the `exports.types` condition first (TS prefers `types` for
//     type resolution under node16/bundler). So the types entry must carry the
//     RUNTIME symbol types too, or imports break with TS2305.
//   => This single `.d.ts` satisfies BOTH: it re-exports the runtime symbol
//      types from `./index.js` (so imports resolve) AND references the verbatim
//      `tool-gating.d.ts` augmentation (so triple-slash consumers get `gating`).
//
// `tool-gating.d.ts` is the gating augmentation (formerly in the standalone
// `@repo/pi-tool-gating-contract` package, now folded into core-interface).
export * from "./index.js";
/// <reference path="./tool-gating.d.ts" />
