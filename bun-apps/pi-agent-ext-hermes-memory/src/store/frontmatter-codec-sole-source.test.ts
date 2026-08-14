import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

// C1 sole-source gate (architecture-deepening close-out): the fence-split leaf
// `frontmatter-codec.ts` is the ONLY non-test src file allowed to PARSE yaml.
// A hand-rolled `---` fence split must feed a YAML parse — so forbidding the
// parse import (outside the sanctioned files) forbids the copy-paste drift the
// leaf replaced (#1196). `stringify` imports stay legal: serializers
// (memory-format, knowledge-serializer, image-serializer) legitimately emit
// YAML and never split fences.
const here = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = join(here, "..");

/** Files sanctioned to import the yaml parser: the leaf itself, and
 *  memory-format.ts (legitimately wraps splitFencedYaml with throw-on-null and
 *  re-serializes — it never hand-rolls the split). */
const SANCTIONED = new Set([
  "store/frontmatter-codec.ts",
  "store/memory-format.ts",
]);

function walkTs(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      walkTs(full, acc);
    } else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) {
      acc.push(full);
    }
  }
  return acc;
}

// The leaf imports `{ parse as parseYaml } from "yaml"` — any other file doing
// a parse-shaped import from "yaml" is a candidate hand-rolled fence split.
const YAML_PARSE_IMPORT_RE =
  /import\s*\{[^}]*\bparse(?:Yaml)?\b[^}]*\}\s*from\s*["']yaml["']/;

describe("frontmatter-codec sole-source gate (C1)", () => {
  it("no non-test src file hand-rolls a yaml-parse-based fence split outside the sanctioned files", () => {
    const offenders: string[] = [];
    for (const file of walkTs(SRC_ROOT)) {
      const rel = relative(SRC_ROOT, file);
      if (SANCTIONED.has(rel)) continue;
      if (YAML_PARSE_IMPORT_RE.test(readFileSync(file, "utf8"))) {
        offenders.push(rel);
      }
    }
    assert.deepEqual(
      offenders,
      [],
      `non-test src files parsing yaml directly (must delegate to store/frontmatter-codec.ts splitFencedYaml): ${offenders.join(", ")}`,
    );
  });

  it("the leaf itself is still the sanctioned parse site (guard against a moved/renamed leaf)", () => {
    const leaf = readFileSync(join(SRC_ROOT, "store/frontmatter-codec.ts"), "utf8");
    assert.match(leaf, YAML_PARSE_IMPORT_RE);
    assert.match(leaf, /export function splitFencedYaml/);
  });
});
