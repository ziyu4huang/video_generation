/**
 * pi-agent-ext-power-tool — canonical extension entry.
 *
 * Uniform convention: every bun-apps/pi-agent-ext-<X>/ registers its extension
 * at extensions/<X>.ts. The implementation (extension factory + lib) lives in
 * src/index.ts (also the package.json `main` for programmatic use); this file
 * is the single registered entry point and re-exports the default factory.
 */
export { default } from "../src/index.ts";
