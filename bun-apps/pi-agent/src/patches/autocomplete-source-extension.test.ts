/**
 * Tests for the autocomplete-source-extension patch.
 *
 * The /<cmd> and /skill: picker prefixes each entry with a SCOPE marker
 * ([u]/[p]/[t], plus :npm:/:git: variants) via
 * InteractiveMode.prototype.prefixAutocompleteDescription. Extension-provided
 * skills/commands are misclassified by the framework as [t] (temporary), so a
 * bare [t] gives no hint which extension owns a skill.
 *
 * Fix: wrap prefixAutocompleteDescription to REPLACE the leading scope marker
 * with a dedicated [e:<ext>] marker when the entry comes from a pi-agent-ext
 * package (derived from sourceInfo path OR source) → "[e:wayfind] desc".
 * Non-extension sources (user/project/temporary, no pi-agent-ext segment) keep
 * their original marker.
 */
import { describe, expect, test } from "bun:test";
import { InteractiveMode } from "@earendil-works/pi-coding-agent";
// Importing the patch module applies its import-time side effect (wraps
// InteractiveMode.prototype.prefixAutocompleteDescription). Idempotent — safe
// to re-import. Mirrors footer-extension-status-notify.test.ts.
import "./autocomplete-source-extension.ts";
import {
  applyAutocompleteSourceExtensionPatch,
  owningExtension,
  replaceMarker,
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

  test("matches the ext name from an npm source OR path", () => {
    expect(
      owningExtension({
        source: "npm:@earendil-works/pi-agent-ext-hyperframes",
        path: "/n/m/@earendil-works/pi-agent-ext-hyperframes/skills/x",
      }),
    ).toBe("hyperframes");
  });

  test("returns undefined for a user skill path (no pi-agent-ext segment)", () => {
    expect(owningExtension({ path: "/Users/me/.pi/agent/skills/foo/SKILL.md" })).toBeUndefined();
  });

  test("returns undefined for undefined input", () => {
    expect(owningExtension(undefined)).toBeUndefined();
  });

  test("derives the ext name from baseDir (package root, no trailing sep)", () => {
    expect(owningExtension({ baseDir: "/repo/bun-apps/pi-agent-ext-prompt-history" })).toBe(
      "prompt-history",
    );
  });
});

describe("replaceMarker", () => {
  test("replaces a bare [t] tag with [e:<ext>]", () => {
    expect(replaceMarker("[t] desc", "wayfind")).toBe("[e:wayfind] desc");
  });

  test("replaces a compound [u:npm:...] tag with [e:<ext>]", () => {
    expect(
      replaceMarker("[u:npm:@earendil-works/pi-agent-ext-hyperframes] desc", "hyperframes"),
    ).toBe("[e:hyperframes] desc");
  });

  test("handles a tag with no description", () => {
    expect(replaceMarker("[t]", "wayfind")).toBe("[e:wayfind]");
  });

  test("prepends [e:<ext>] when there is no leading [tag]", () => {
    expect(replaceMarker("desc only", "wayfind")).toBe("[e:wayfind] desc only");
  });
});

describe("InteractiveMode.prototype.prefixAutocompleteDescription patch", () => {
  test("patch is idempotent (apply twice → false the second time)", async () => {
    // The top-level import already applied it once. Re-applying must be a no-op.
    expect(applyAutocompleteSourceExtensionPatch()).toBe(false);
  });

  test("replaces the marker for a locally-loaded extension sourceInfo", () => {
    const result = patchedProto.prefixAutocompleteDescription("grill steaks perfectly", {
      scope: "temporary",
      source: "local",
      path: "/repo/bun-apps/pi-agent-ext-wayfind/skills/grilling/SKILL.md",
    });
    expect(result).toBe("[e:wayfind] grill steaks perfectly");
  });

  test("delegates unchanged for a user skill (no pi-agent-ext segment)", () => {
    const result = patchedProto.prefixAutocompleteDescription("do the thing", {
      scope: "user",
      source: "local",
      path: "/Users/me/.pi/agent/skills/foo/SKILL.md",
    });
    expect(result).toBe("[u] do the thing");
  });

  test("replaces the marker for an npm extension source", () => {
    const result = patchedProto.prefixAutocompleteDescription("render video", {
      scope: "user",
      source: "npm:@earendil-works/pi-agent-ext-hyperframes",
      path: "/node_modules/@earendil-works/pi-agent-ext-hyperframes/index.js",
    });
    expect(result).toBe("[e:hyperframes] render video");
  });
});
