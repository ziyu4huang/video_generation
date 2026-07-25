/**
 * Obsidian Extension — public API barrel.
 *
 * Phase 1 extraction is complete: every leaf module lives under ./lib/* and is
 * re-exported here so existing `from "./obsidian-lib"` / `from "../src/obsidian-lib.ts"`
 * imports keep resolving. Tool registrations live in ../extensions/obsidian.ts;
 * this file declares no symbols of its own.
 */
export * from "./lib/errors";
export * from "./lib/utils";
export * from "./lib/path-safety";
export * from "./lib/fs-cache";
export * from "./lib/vault-resolution";
export * from "./lib/frontmatter";
export * from "./lib/index";
export * from "./lib/search";
export * from "./lib/graph";
export * from "./lib/links";
export * from "./lib/subagent";
export * from "./lib/zettel";
export * from "./lib/routing";
