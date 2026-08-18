/**
 * mobile-shell.test.ts — webui-readability G2: the shell stays usable from a
 * phone (check the agent away from the desk — the happy-coder lane). The
 * viewport meta already ships; this pins the narrow-viewport contract: the
 * tab strip wraps, the composer sticks above the keyboard with 16px inputs
 * (no iOS focus zoom), touch targets grow, gutters shrink.
 */
import { describe, expect, test } from "bun:test";
import { RENDER_SHELL_HTML } from "../src/render-shell.js";

describe("RENDER_SHELL_HTML — G2 mobile pass", () => {
  test("viewport meta + the narrow-viewport media block", () => {
    expect(RENDER_SHELL_HTML).toContain('name="viewport"');
    expect(RENDER_SHELL_HTML).toContain("@media (max-width: 720px)");
    expect(RENDER_SHELL_HTML).toMatch(/#tabs\s*\{\s*flex-wrap: wrap;/);
    expect(RENDER_SHELL_HTML).toContain("#composer { position: sticky; bottom: 0;");
    expect(RENDER_SHELL_HTML).toContain("font-size: 16px;");
    expect(RENDER_SHELL_HTML).toContain("min-height: 40px;");
  });
});
