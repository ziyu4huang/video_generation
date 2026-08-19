/**
 * pi-agent-ext-hyperframes — canonical extension entry.
 *
 * Uniform convention: every bun-apps/pi-agent-ext-<X>/ registers its extension
 * at extensions/<X>.ts. The implementation (the no-op skills-carrier factory)
 * lives in src/index.ts (also the package.json `main` for programmatic use);
 * this file is the single registered entry point and re-exports the factory.
 */
export { default } from "../src/index.ts";
