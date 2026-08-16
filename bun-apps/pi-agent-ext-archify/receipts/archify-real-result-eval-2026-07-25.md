# Archify Real-Result Structural Evaluation — Findings (2026-07-25)

Suite: `PI_AGENT_E2E=1 bun test __tests__/real-result.test.ts`
Spec: `.planning/specs/2026-07-25-archify-real-result-eval-design.md`

## Result

- 6 cases run, 6 pass, 0 fail.
- 58 expect() calls; wall time ~1.2s.

Verbatim gated-run tail:

```
bun test v1.3.14 (0d9b296a)

 6 pass
 0 fail
 58 expect() calls
Ran 6 tests across 1 file. [1177.00ms]
```

## Per-type generated-HTML facts

Facts collected by rendering each vendored example IR through `archifyRender`
and running `inspectArtifact` on the produced HTML.

| Type | dataKindAttrCount | label sample | external refs (classified) | archify check | bytes |
|------|-------------------|--------------|----------------------------|---------------|-------|
| architecture | 24 | Customers; API Gateway; Workers; Observability | optional: Google Fonts (googleapis/gstatic) + archify help URL; required: none | pass | 599,680 |
| sequence | 24 | Accept; POST /jobs; Background work; Notify + reconcile | optional: same; required: none | pass | 593,851 |
| workflow | 24 | 01 / User Interface; 02 / Agent Runtime; 03 / Policy Boundary; EX / Exception Handling | optional: same; required: none | pass | 599,298 |
| dataflow | 24 | 01 / Producers; 02 / Transit; 03 / Processors; 04 / State + recovery | optional: same; required: none | pass | 601,009 |
| lifecycle | 24 | 01 / Lifecycle phases; 02 / Interruptions + Recovery loop; 03 / Terminal exits | optional: same; required: none | pass | 590,005 |

### Note on `dataKindAttrCount` (measurement caveat)

`dataKindAttrCount` is produced by `inspectArtifact` as the count of every
`data-kind="..."` attribute occurrence in the HTML. The vendored
`template.html` ships a fixed SVG legend/theme block whose groups also carry
`data-kind` (14 distinct kinds: `frontend`, `start`, `database`, `success`,
`cloud`, `waiting`, `messagebus`, `security`, `decision`, `failure`,
`external`, `neutral`, `backend`, `active`). These theme/legend attributes are
present in every rendered artifact independent of the diagram content, so
`dataKindAttrCount == 24` is a **template constant**, NOT a per-diagram node
count. The field is honestly named to reflect that it counts attribute
occurrences, not diagram nodes. The discriminating per-type signal is the
`<text>` label count (49 / 36 / 50 / 64 / 42 for the five types above) and
the title string, both of which vary meaningfully per IR.

Architecture deep round-trip: the architecture IR has 12 components (Customers,
Global Edge, API Gateway, API Pods / AZ-a, API Pods / AZ-b, Redis, PostgreSQL,
Event Bus, Workers, DR Replica, Audit Archive, Observability). Every component
label renders verbatim in a `<text>` element (`f.textLabels` contains all 12),
which is the round-trip integrity assertion kept in the gated suite. (The
earlier `nodeCount >= components.length` check was removed as tautological —
24 >= 12 holds regardless of the rendered content.)

## Self-containment note

The generated artifacts are **functionally offline-capable**: no *required*
external refs (no external `<script src>` / `<img>` / non-allowlisted
resource). Each artifact has exactly 4 external refs, all classified optional:

- `https://fonts.gstatic.com` — single `<link rel="preconnect">`.
- `https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700&display=swap"`
  — loaded twice (two `<link rel="stylesheet">` tags in `vendored/assets/template.html`);
  JetBrains Mono, loaded async with a system-monospace fallback (the template
  comment: "a blackholed network must not block first paint").
- `https://tt-a1i.github.io/archify/start.html?type=<type>` — a help/getting-started
  `<a>` link in the artifact footer.

`inspectArtifact.requiredExternalRefs == []` for every type, confirming the
offline-capable claim. Per the vendored snapshot policy these cannot be
patched in-tree. This corrects spec #794's over-claim ("no external/network
refs") → "no *required* external refs; offline-capable."

## Verdict

Generated-HTML structural fidelity is trustworthy across all five diagram types:
IR→HTML round-trip integrity holds (architecture: all 12 component labels
render verbatim in `<text>`), artifacts are offline-capable (zero required
external refs), and every type passes the vendored `archify check`. Keep the
gated suite as an opt-in regression gate (run on vendored re-sync or any
`lib/render.ts` change). The `dataKindAttrCount` field is template-inflated
and is not a per-diagram node count (it counts `data-kind` attribute
occurrences, including legend/theme swatches); prefer `textLabels` for
content discrimination.
