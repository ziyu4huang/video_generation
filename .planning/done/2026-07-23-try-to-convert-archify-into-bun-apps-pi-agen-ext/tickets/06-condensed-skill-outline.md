## Question

Draft the condensed archify pi skill: what IR-authoring curriculum is **base** (always in context, few KB) vs **on-demand** (the agent `read`s the vendored full `SKILL.md` / schemas when it needs depth — story/lens/route-probe/layout craft)?

Produce a concrete outline (section list + what each points at on-demand) to react to. This is the schema-cost crux made tangible.

> **Constraint (map Notes — self-contained):** on-demand `read`s target the **locally vendored** full `SKILL.md` + schemas (copied into the package at vendor time), **never `../archify`**. Every on-demand pointer in the outline must resolve to an in-package path.

**type:** prototype
**blocked by:** —
**claimed:** wayfind-session (2026-07-24) — resolving

## Resolution (2026-07-24) — CLOSED

**Prototype accepted** (user confirmed both forks: **architecture-only** example in base + **2-line layout essentials** in base). Agreed outline:

**BASE (~3 KB, always in context):**
1. **Frontmatter** — `name: archify`; description naming the 5 diagram types + the 3 tools (`archify_validate` / `archify_render` / `archify_delta`) + optional repo-evidence / Mermaid.
2. **Choose a type** — one line each: architecture (components+connections topology) / workflow (steps/branches/decisions) / sequence (temporal messages) / dataflow (pipeline transforms, ETL/lineage) / lifecycle (states+transitions).
3. **IR skeleton (common)** — `schema_version:1` + `diagram_type` + `meta{title,subtitle?,output,quality_profile?,views?}` + type-specific arrays; shared vocab `componentType`∈{frontend,backend,database,cloud,security,messagebus,external}, `variant`∈{default,emphasis,security,dashed}, `id`=`[a-zA-Z][\w-]*`.
4. **Layout essentials (2 lines)** — cardinal rule (set semantic `type`+`variant`; renderer maps to theme colors; **never inline colors**) + place components left→right along the primary request path, group by boundary.
5. **ONE minimal worked example** — architecture, 3 components / 2 connections (trimmed from `web-app.architecture.json`, incl. `pos`/`size`), for the agent to copy+edit.
6. **The loop** — `archify_validate` (IR↔schema → diagnostics) FIRST → fix → `archify_render` (IR→HTML at `outputPath`) → change-review via `archify_delta`. Validate before render; never deliver unvalidated IR.
7. **On-demand pointers (LOCAL paths)** — `vendored/SKILL.md` (§ Layout principles / § Architecture Mode / § Renderer Modes / § Mermaid / § repo-evidence) + `vendored/schemas/<type>.schema.json`.

**ON-DEMAND (read locally, not in base context):** full layout craft (hard rules / design system / delivery gate / hand-placed fallback / cardinal-rule detail), per-mode deep vocab (workflow/sequence/dataflow/lifecycle), Mermaid input dialect, repo-evidence authoring, complete per-type schemas. Runtime artifact features (story / lens / route-probe / share-card / export menu) are provided BY the rendered HTML; the agent enables them via `meta.views` / `cards` / `variant`, authored using on-demand depth.

**Base ≈ 3 KB; the remaining ~69 KB of SKILL.md + 6 schemas are read selectively on hit** — drops the schema-cost from "72 KB always-on" to "~3 KB constant + depth on demand".

**Implied — clears a fog patch:** the agent authors **raw JSON IR** (base teaches the skeleton) and `archify_validate` checks it against the **vendored JSON schema** at runtime → tool inputs are raw JSON IR blobs (or paths), **NOT Typebox-typed structured inputs**. Generating Typebox from the 6 schemas would be redundant. (Resolves the map's "Schemas as TS Typebox vs JSON-validated blobs" fog — Typebox ruled out.)
