import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

// C1 sole-source gate (architecture-deepening close-out), L2 leaf-hoist form:
// the fence-split leaf `splitFencedYaml` now lives in
// @repo/s2-agent-core-interface/src/embedding-leaf.ts — the ONLY non-test file
// in either package allowed to PARSE yaml. A hand-rolled `---` fence split
// must feed a YAML parse — so forbidding the parse import outside the leaf
// forbids the copy-paste drift the leaf replaced (#1196). `stringify` imports
// stay legal: serializers (memory-format, knowledge-serializer,
// image-serializer) legitimately emit YAML and never split fences.
const here = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = join(here, "..");

// The leaf lives in the sibling workspace package: bun-apps/ relative from
// this test file's directory (src/store/).
const CORE_LEAF = join(here, "..", "..", "..", "s2-agent-core-interface", "src", "embedding-leaf.ts");

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
  it("no non-test src file hand-rolls a yaml-parse-based fence split (must delegate to core-interface splitFencedYaml)", () => {
    const offenders: string[] = [];
    for (const file of walkTs(SRC_ROOT)) {
      const rel = relative(SRC_ROOT, file);
      if (YAML_PARSE_IMPORT_RE.test(readFileSync(file, "utf8"))) {
        offenders.push(rel);
      }
    }
    assert.deepEqual(
      offenders,
      [],
      `non-test src files parsing yaml directly (must delegate to @repo/s2-agent-core-interface splitFencedYaml): ${offenders.join(", ")}`,
    );
  });

  it("the core-interface leaf is still the sanctioned parse site (guard against a moved/renamed leaf)", () => {
    const leaf = readFileSync(CORE_LEAF, "utf8");
    assert.match(leaf, YAML_PARSE_IMPORT_RE);
    assert.match(leaf, /export function splitFencedYaml/);
  });
});
