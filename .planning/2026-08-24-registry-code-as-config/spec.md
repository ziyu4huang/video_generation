# spec — registry-code-as-config

Status: draft (seeded 2026-08-24). Scope locked by map.md Decisions D1–D5.

## 1. Problem

`s2-agent.registry.yaml` is the repo's extension registry — 24 entries mixing
load strategy, deploy shipping, vendoring, and per-entry rationale. Two
structural defects, both observed live:

1. **Disabled extensions fall out of the type universe.** tool-gate (#1946
   era) and hyperframes (PR #1958, 2026-08-24) are commented-out YAML blocks:
   invisible to tests, enumeration, and tooling; re-enabling is uncomment-and-
   hope. The registry-header prose even carries instructions ("re-enable =
   uncomment this entry + regen:manifest") that no machine checks.
2. **Rules that matter live in comments.** Static-order constraints
   (subagent before ultracode), host-contract equality (hostApi/hostModules vs
   `src/sh/host-modules.ts`), excludeReason completeness — all prose. Only the
   deploy path (ext-build) enforces some of it, at deploy time.

Meanwhile the repo already runs the target pattern successfully:
`src/pre-load-providers.ts` is typed, side-effect-free, version-controlled
model config with direct tests, consumed by import from three surfaces.

## 2. Target design

### 2.1 The module: `bun-apps/s2-agent/src/registry-config.ts`

- Pure data + types + pure functions. ZERO imports (D4: contract suites read
  it via relative path without workspace links; a single import would break
  that). Same header doctrine as pre-load-providers.ts ("side-effect-free by
  design").
- Shape (sketch, final in ticket 01):

```ts
export interface RegistryEntry {
  name: string;              // short id; static entries feed ext/<name>/
  package: string;           // workspace package name
  entry: string;             // extensions/<X>.ts
  load: "static" | "dynamic";
  skills?: boolean;
  version?: string;
  deploy?: DeployBlock;      // present ⇒ ships
  excludeReason?: string;    // REQUIRED when deploy is absent (invariant test)
  enabled: boolean;          // false ⇒ not loaded, not shipped — but ENUMERATED
  disableReason?: string;    // REQUIRED when enabled:false (invariant test)
  reEnableNote?: string;     // the "uncomment + regen" prose, now data
}
export const REGISTRY: RegistryEntry[];
export const DEPLOY_CONFIG: { outRoot: string; /* … */ };
export const HOST_CONTRACT: { hostApi: number; hostModules: string[] };
```

- Disabled entries (tool-gate, hyperframes) live in `REGISTRY` with
  `enabled: false` + `disableReason` + `reEnableNote` — the D2 fix.

### 2.2 Consumers

| Consumer | Today | After |
| --- | --- | --- |
| `run-dir/registry.ts` (authority) | YAML parse | `import { REGISTRY }` + validation kept |
| `run-dir/registry-to-manifest.ts` | parse → manifest | reads validated entries |
| `scripts/regen-manifest.ts` | parse → write manifest.json | same, from REGISTRY; manifest.json still DERIVED (D3) |
| `run-dir/registry-insert.ts` | YAML text surgery | array operation + reserialize (no YAML — writes nothing if run-dir stays derived-only; verify in ticket 02) |
| `src/ext-new.ts` scaffold | emits YAML entry | appends typed entry + regen |
| devops `src/deploy/lib/config.ts` `parseShConfig` | YAML parse | imports REGISTRY via `@repo/s2-agent` (devops HAS workspace links; D4 applies only to bun-apps/tests contract suites) |
| `bun-apps/tests/lib/registry-base-set.ts` | line scanner | relative-path import of `registry-config.ts` (link-immune, D4) |

### 2.3 Invariant tests (new, ticket 04)

- every entry without `deploy` has non-empty `excludeReason`
- every `enabled: false` entry has `disableReason` + `reEnableNote`
- static entries' order: subagent index < ultracode index
- `HOST_CONTRACT.hostApi === HOST_API` and hostModules set-equal
  `HOST_MODULE_IDS` (import from `src/sh/host-modules.ts` — this test CAN use
  workspace links; it is not a contract suite)
- one entry per `bun-apps/s2-agent-ext-*/` folder; entry file exists
- `regen:manifest` output freshness (existing gate, unchanged)

## 3. Migration safety

Ticket 01 ships `registryToLegacyShapes()` (pure) asserting deep-equality
against `parseRegistry(yaml)` / `parseShConfig(yaml)` output on the REAL file —
the equivalence net. It runs in CI until ticket 04 deletes the YAML (then the
assertion flips: the shapes ARE the source). No step ever changes
manifest.json semantics; the freshness gate guards continuity.

## 4. Explicitly out of scope

- Changing what ships or loads (content decisions stay in the registry data;
  #1958's exclusions migrate verbatim).
- run-dir/manifest.json format, loader behavior, schema-cost canary.
- Deploy tree layout / deploy.json / ext.json.
