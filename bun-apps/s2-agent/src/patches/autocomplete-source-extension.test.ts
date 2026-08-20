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
 * with a dedicated [e:<ext>] marker when the entry comes from a s2-agent-ext
 * package (derived from sourceInfo path OR source) → "[e:wayfind] desc".
 * Non-extension sources (user/project/temporary, no s2-agent-ext segment) keep
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
  isExtensionSource,
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
  test("derives the ext name from a s2-agent-ext-<name> path", () => {
    expect(
      owningExtension({
        path: "/x/bun-apps/s2-agent-ext-wayfind/skills/grilling/SKILL.md",
      }),
    ).toBe("wayfind");
  });

  test("matches the ext name from an npm source OR path", () => {
    expect(
      owningExtension({
        source: "npm:@earendil-works/s2-agent-ext-hyperframes",
        path: "/n/m/@earendil-works/s2-agent-ext-hyperframes/skills/x",
      }),
    ).toBe("hyperframes");
  });

  test("returns undefined for a user skill path (no s2-agent-ext segment)", () => {
    expect(owningExtension({ path: "/Users/me/.pi/agent/skills/foo/SKILL.md" })).toBeUndefined();
  });

  test("returns undefined for undefined input", () => {
    expect(owningExtension(undefined)).toBeUndefined();
  });

  test("derives the ext name from baseDir (package root, no trailing sep)", () => {
    expect(owningExtension({ baseDir: "/repo/bun-apps/s2-agent-ext-prompt-history" })).toBe(
      "prompt-history",
    );
  });
});

describe("isExtensionSource", () => {
  test("true for a s2-agent-ext-<name> path", () => {
    expect(
      isExtensionSource({
        path: "/x/bun-apps/s2-agent-ext-wayfind/skills/grilling/SKILL.md",
      }),
    ).toBe(true);
  });

  test("true when s2-agent-ext- is present but the name is unparseable (bare [e] trigger)", () => {
    expect(isExtensionSource({ path: "/x/bun-apps/s2-agent-ext-/skills/x" })).toBe(true);
  });

  test("true for an npm source referencing a s2-agent-ext package", () => {
    expect(isExtensionSource({ source: "npm:@earendil-works/s2-agent-ext-hyperframes" })).toBe(
      true,
    );
  });

  test("false for a user skill path (no s2-agent-ext segment)", () => {
    expect(isExtensionSource({ path: "/Users/me/.pi/agent/skills/foo/SKILL.md" })).toBe(false);
  });

  test("false for undefined input", () => {
    expect(isExtensionSource(undefined)).toBe(false);
  });
});

describe("replaceMarker", () => {
  test("replaces a bare [t] tag with [e:<ext>]", () => {
    expect(replaceMarker("[t] desc", "wayfind")).toBe("[e:wayfind] desc");
  });

  test("replaces a compound [u:npm:...] tag with [e:<ext>]", () => {
    expect(
      replaceMarker("[u:npm:@earendil-works/s2-agent-ext-hyperframes] desc", "hyperframes"),
    ).toBe("[e:hyperframes] desc");
  });

  test("handles a tag with no description", () => {
    expect(replaceMarker("[t]", "wayfind")).toBe("[e:wayfind]");
  });

  test("prepends [e:<ext>] when there is no leading [tag]", () => {
    expect(replaceMarker("desc only", "wayfind")).toBe("[e:wayfind] desc only");
  });

  test("renders bare [e] for an empty name with a description", () => {
    expect(replaceMarker("[t] desc", "")).toBe("[e] desc");
  });

  test("renders bare [e] for an empty name with no description", () => {
    expect(replaceMarker("[t]", "")).toBe("[e]");
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
      path: "/repo/bun-apps/s2-agent-ext-wayfind/skills/grilling/SKILL.md",
    });
    expect(result).toBe("[e:wayfind] grill steaks perfectly");
  });

  test("delegates unchanged for a user skill (no s2-agent-ext segment)", () => {
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
      source: "npm:@earendil-works/s2-agent-ext-hyperframes",
      path: "/node_modules/@earendil-works/s2-agent-ext-hyperframes/index.js",
    });
    expect(result).toBe("[e:hyperframes] render video");
  });

  test("renders bare [e] for a s2-agent-ext source with an unparseable name", () => {
    const result = patchedProto.prefixAutocompleteDescription("mystery skill", {
      scope: "temporary",
      source: "local",
      path: "/x/s2-agent-ext-/skills/x",
    });
    expect(result.startsWith("[e]")).toBe(true);
  });
});
