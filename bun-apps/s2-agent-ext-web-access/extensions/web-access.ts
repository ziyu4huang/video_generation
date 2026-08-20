/**
 * s2-agent-ext-web-access — canonical extension entry.
 *
 * Uniform convention: every bun-apps/s2-agent-ext-<X>/ registers its extension
 * at extensions/<X>.ts. The implementation (extension factory + search/fetch
 * libs) lives at the package root index.ts (also the package.json `main` for
 * programmatic use); this file is the single registered entry point and
 * re-exports the default factory.
 */
export { default } from "../index.ts";
