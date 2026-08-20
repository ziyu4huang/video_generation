/**
 * Package lib face (src-entry convention): `main` / `exports["."]` resolve here.
 * Registration stays in ../extensions/obsidian.ts — never import this file for the
 * default factory.
 */
export * from "./obsidian-lib.ts";
