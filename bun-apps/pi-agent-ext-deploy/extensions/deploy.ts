/**
 * pi-agent-ext-deploy — canonical extension entry.
 *
 * Uniform convention: every bun-apps/pi-agent-ext-<X>/ registers its extension
 * at extensions/<X>.ts. The factory lives in src/index.ts; this file is the
 * single registered entry point and re-exports the default factory.
 */
export { default } from "../src/index.ts";
