/**
 * ext-dir-unwrap — regression guard for the source-mode session_start throw
 * (measured 2026-08-27: 'Extension error (<inline:s2-agent-ext-file2md>):
 * The "paths[0]" property must be of type string, got object' on EVERY
 * source-mode boot).
 *
 * In the dev/source tree `require("#pi/ext-dir")` resolves package.json's
 * imports entry (src/sh-ext-dir.ts) and jiti/bun interop hands back a
 * NAMESPACE OBJECT `{ default: <pkg root> }`; the sh deploy's injected
 * require serves a bare string. The old _EXT_DIR took the value as-is, so
 * the session_start handler passed an object into missingExtDeps →
 * isDeployedExtDir → join() → TypeError.
 *
 * Under bun test the require resolves through the same imports map, so the
 * namespace shape is exercised HERE: firing the captured session_start
 * handler must not throw. The bare-string (deploy) spelling is covered by
 * the sh ext-loader's own tests.
 */
import { describe, expect, test } from "bun:test";
import extensionFactory from "../file2md.ts";

interface ToolLike {
  name?: string;
  [key: string]: unknown;
}

function makeMockPi() {
  const tools: ToolLike[] = [];
  const handlers: Record<string, Array<(event: unknown, ctx: unknown) => Promise<void>>> = {};
  const pi = {
    registerTool: (t: ToolLike) => {
      tools.push(t);
      return t;
    },
    on: (ev: string, fn: (event: unknown, ctx: unknown) => Promise<void>) => {
      handlers[ev] ??= [];
      handlers[ev]!.push(fn);
    },
    events: { on: () => () => {}, emit: () => {} },
  };
  return { pi, tools, handlers };
}

describe("#pi/ext-dir dual-shape unwrap (source-mode session_start)", () => {
  test("firing the session_start handler does not throw (namespace object unwrapped)", async () => {
    const { pi, handlers } = makeMockPi();
    extensionFactory(pi as never);
    const starts = handlers.session_start ?? [];
    expect(starts.length).toBeGreaterThan(0);
    const ctx = { ui: { notify: () => {} } };
    // OLD behavior: missingExtDeps(deps, {default: "…"}) → join() threw
    // 'The "paths[0]" property must be of type string, got object'.
    await expect(Promise.all(starts.map((h) => h({}, ctx)))).resolves.toBeDefined();
  });
});
