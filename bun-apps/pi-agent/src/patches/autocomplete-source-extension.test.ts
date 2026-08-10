/**
 * Tests for the autocomplete-source-extension patch.
 *
 * The /<cmd> and /skill: picker prefixes each entry with a SCOPE marker
 * ([u]/[p]/[t], plus :npm:/:git: variants) via
 * InteractiveMode.prototype.prefixAutocompleteDescription. For locally-loaded
 * pi-agent-ext-<name> resources the marker is BARE (e.g. [t]) with no package,
 * so you can't tell which extension a skill comes from.
 *
 * Fix: wrap prefixAutocompleteDescription to append the owning extension
 * (derived from sourceInfo.path) inside the leading [tag] → "[t · wayfind] desc".
 * npm/git sources are left unchanged (they already self-attribute).
 */
import { describe, expect, test } from "bun:test";
import { InteractiveMode } from "@earendil-works/pi-coding-agent";
// Importing the patch module applies its import-time side effect (wraps
// InteractiveMode.prototype.prefixAutocompleteDescription). Idempotent — safe
// to re-import. Mirrors footer-extension-status-notify.test.ts.
import "./autocomplete-source-extension.ts";
import {
  applyAutocompleteSourceExtensionPatch,
  injectExtension,
  owningExtension,
} from "./autocomplete-source-extension.ts";

// prefixAutocompleteDescription is `private` in the SDK's .d.ts, so access the
// patched prototype through a structural cast (mirrors the implementation file).
type AutocompleteModeProto = {
  prefixAutocompleteDescription: (
    description: string | undefined,
    sourceInfo: unknown,
  ) => string;
};
const patchedProto = InteractiveMode.prototype as unknown as AutocompleteModeProto;

describe("owningExtension", () => {
  test("derives the ext name from a pi-agent-ext-<name> path", () => {
    expect(
      owningExtension({
        path: "/x/bun-apps/pi-agent-ext-wayfind/skills/grilling/SKILL.md",
      }),
    ).toBe("wayfind");
  });

  test("returns undefined for a user skill path (no pi-agent-ext segment)", () => {
    expect(owningExtension({ path: "/Users/me/.pi/agent/skills/foo/SKILL.md" })).toBeUndefined();
  });

  test("returns undefined for an npm source (already self-attributes)", () => {
    expect(
      owningExtension({
        source: "npm:@earendil-works/pi-agent-ext-hyperframes",
        path: "/node_modules/@earendil-works/pi-agent-ext-hyperframes/...",
      }),
    ).toBeUndefined();
  });

  test("returns undefined for a git url source", () => {
    expect(
      owningExtension({
        source: "https://github.com/earendil-works/some-skill.git",
        path: "/tmp/checkout/some-skill/SKILL.md",
      }),
    ).toBeUndefined();
  });

  test("returns undefined for undefined input", () => {
    expect(owningExtension(undefined)).toBeUndefined();
  });

  test("falls back to baseDir when path is absent", () => {
    expect(
      owningExtension({ baseDir: "/repo/bun-apps/pi-agent-ext-wayfind" }),
    ).toBe("wayfind");
  });
});

describe("injectExtension", () => {
  test("injects inside a bare [u] tag", () => {
    expect(injectExtension("[u] desc", "wayfind")).toBe("[u · wayfind] desc");
  });

  test("injects inside a compound [u:npm:x] tag", () => {
    expect(injectExtension("[u:npm:x] desc", "wayfind")).toBe("[u:npm:x · wayfind] desc");
  });

  test("prepends a synthetic tag when there is no leading [tag]", () => {
    expect(injectExtension("desc only", "wayfind")).toBe("[· wayfind] desc only");
  });

  test("handles a tag with no description", () => {
    expect(injectExtension("[t]", "wayfind")).toBe("[t · wayfind]");
  });
});

describe("InteractiveMode.prototype.prefixAutocompleteDescription patch", () => {
  test("patch is idempotent (apply twice → false the second time)", async () => {
    // The top-level import already applied it once. Re-applying must be a no-op.
    expect(applyAutocompleteSourceExtensionPatch()).toBe(false);
  });

  test("augments a locally-loaded extension sourceInfo", () => {
    const result = patchedProto.prefixAutocompleteDescription(
      "grill steaks perfectly",
      {
        scope: "temporary",
        source: "local",
        path: "/repo/bun-apps/pi-agent-ext-wayfind/skills/grilling/SKILL.md",
      },
    );
    expect(result).toBe("[t · wayfind] grill steaks perfectly");
  });

  test("delegates unchanged for a user skill (no pi-agent-ext segment)", () => {
    const result = patchedProto.prefixAutocompleteDescription("do the thing", {
      scope: "user",
      source: "local",
      path: "/Users/me/.pi/agent/skills/foo/SKILL.md",
    });
    expect(result).toBe("[u] do the thing");
  });

  test("delegates unchanged for an npm source (already self-attributes)", () => {
    const result = patchedProto.prefixAutocompleteDescription("render video", {
      scope: "user",
      source: "npm:@earendil-works/pi-agent-ext-hyperframes",
      path: "/node_modules/@earendil-works/pi-agent-ext-hyperframes/index.js",
    });
    expect(result).toBe("[u:npm:@earendil-works/pi-agent-ext-hyperframes] render video");
  });
});
