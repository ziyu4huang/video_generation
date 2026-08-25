/**
 * registry-config.ts — THE extension registry as typed, side-effect-free data.
 *
 * Migrated 2026-08-24 from the retired YAML registry (effort
 * .planning/2026-08-24-registry-code-as-config/, tickets 01–04). The YAML is
 * retired with its parsers; THIS module is now the single source of truth —
 * every entry, disabled ones included, is a typed `enabled: false` value.
 *
 * ZERO-IMPORT / SIDE-EFFECT-FREE BY DESIGN
 * ----------------------------------------
 * This module imports NOTHING and has NO top-level side effects — same
 * doctrine as pre-load-providers.ts, with one extra constraint: the
 * bun-apps/tests contract suites read it via RELATIVE PATH, without
 * bun-apps/node_modules or @repo/* workspace links (map decision D4). A single
 * import would break that. Adding an import here is a map-level decision, not
 * a local one — if one seems unavoidable, STOP and re-decide (D4 breaks).
 * (The equivalence test asserts this by stripping comments and rejecting any
 * `import` statement or `require(` call — comments below legitimately mention
 * require("#pi/ext-dir") in prose.)
 *
 * REGISTRY HEADER (the rules; ported verbatim from the retired YAML):
 *   load: static  → source mode statically imports it (via regen:static codegen)
 *   load: dynamic → source mode loads it via -e
 *   deploy: block PRESENT → ships in the portable tree (order/copy/vendor/externals)
 *   deploy: block ABSENT  → excludeReason is REQUIRED (why it stays local)
 *
 *   Consumed by bun-apps/s2-agent-ext-devops (deploy blocks; CLI:
 *   `bun run --cwd bun-apps/s2-agent deploy`) and by `regen:manifest`.
 *   CLI flags override these values; this file never overrides an explicit flag.
 *
 *   hostApi MUST match HOST_API in bun-apps/s2-agent/src/sh/host-modules.ts,
 *   and hostModules MUST match HOST_MODULE_IDS there — the deploy hard-fails
 *   on drift, because a config that promises a module the core does not embed
 *   produces extensions that silently refuse to load.
 *
 *   Base-set profile (2026-08-20, "portable full-featured agent"): memory,
 *   skills, subagent/workflow, and the knowledge layer (obsidian +
 *   knowledge-card) ship in the box. Everything machine-bound (swift director
 *   CLIs, LM Studio, mupdf) stays out. THIS FILE is the single source of truth
 *   for what ships and why: every excluded entry carries its reason inline
 *   (excludeReason + notes) — the retired docs/deploy.md "Limits" list drifted
 *   from reality and was removed 2026-08-24 for exactly that reason. devops
 *   joined the deploy set 2026-08-23 (on-this-machine stance; repo-bound tools
 *   fail closed) and tool-gate joined the same day (measured reversal; see its
 *   disableReason below).
 *
 *   Entry order: the `load: static` entries first, in staticExtensions[] order
 *   (the order regen:static imports them — subagent MUST precede
 *   ultracode/workflow), then the `load: dynamic` entries in manifest
 *   extensions[] order. `name` on a dynamic entry carries the full package id
 *   because it feeds manifest extensions[].name verbatim; `name` on a static
 *   entry is the short id the deploy tree lays out as ext/<name>/.
 *
 * HOW TO ADD AN EXTENSION
 * -----------------------
 * Add an entry to REGISTRY below. Run `bun run regen:manifest`
 * (+ `regen:static` when load: static). src/run-dir/manifest.json is DERIVED
 * from this data — never edit it directly; the freshness test will go red.
 */

// ─── Types ──────────────────────────────────────────────────────────────────

export interface RegistryDeployAsset {
  /** npm package the payload is extracted from, resolved from the ext package. */
  pkg: string;
  /** Path inside the package — a file or a directory. */
  from: string;
  /** Destination under the deployed ext dir, e.g. "vendored/pdfium/pdfium.wasm". */
  to: string;
}

export interface RegistryDeployBlock {
  order: number;
  /** Package-relative data dirs copied into the deployed ext dir (default []). */
  copy?: string[];
  /** Packages shipped verbatim under <ext>/node_modules/<pkg>/ (default []). */
  vendor?: string[];
  /**
   * npm payloads copied verbatim under <ext>/<to> — file or dir — with the
   * package's JS bundled INTO ext.cjs instead of shipping node_modules.
   * The `vendor:` alternative for asset-bearing deps whose code inlines
   * cleanly and only the payload needs a real path at runtime (file2md's
   * wasm OCR): no node_modules tree ships, payloads are byte-for-byte npm
   * copies, and the deploy never rebuilds or fetches them (default []).
   */
  assets?: RegistryDeployAsset[];
  /** Specifiers left OUT of the bundle and out of the host registry (default []). */
  externals?: string[];
  /** Closure deps deliberately dropped from the vendored tree (default []). */
  vendorExclude?: string[];
  /** Default true; false = the block is recorded but inert (re-enable path). */
  enabled?: boolean;
}

export interface RegistryEntry {
  /** Short id (static entries feed ext/<name>/); dynamic entries use the full package id. */
  name: string;
  /** Workspace package name. */
  package: string;
  /** Entry file package-relative: "extensions/<X>.ts". */
  entry: string;
  load: "static" | "dynamic";
  /** Ships <package>/skills → manifest skills[] (default false). */
  skills?: boolean;
  /** Emitted on dynamic entries when present. */
  version?: string;
  /** Present ⇒ ships (subject to enabled). */
  deploy?: RegistryDeployBlock;
  /** REQUIRED when deploy is absent — why it stays local (invariant-tested). */
  excludeReason?: string;
  /**
   * false ⇒ not loaded, not shipped — but ENUMERATED. Disabled extensions are
   * VALUES, not deletions (map D2, the tool-gate/hyperframes lesson from
   * #1946/#1958): they stay type-checked, listed, and invariant-tested.
   */
  enabled: boolean;
  /** REQUIRED when enabled: false (invariant-tested). */
  disableReason?: string;
  /** The re-enable procedure, now data instead of a comment (REQUIRED when enabled: false). */
  reEnableNote?: string;
  /** The entry's measured rationale, ported from the YAML comments — the registry's real documentation. */
  notes?: string;
}

export interface DeployConfig {
  /** `~`-form is canonical data; consumers expand against the runtime home. */
  outRoot: string;
  version: { from: "package.json"; gitSha: boolean };
  freeze: boolean;
  current: boolean;
  /** Version dirs to retain when pruning (deploy Phase 3). */
  keep?: number;
}

export interface HostContract {
  hostApi: number;
  hostModules: string[];
}

// ─── Config data ─────────────────────────────────────────────────────────────

export const DEPLOY_CONFIG: DeployConfig = {
  outRoot: "~/proj/dist/s2-agent-sh",
  version: { from: "package.json", gitSha: true },
  freeze: true,
  current: true,
  // Phase 3 retention: prune oldest-first after every deploy, never touching
  // the version `current` points at, never fewer than this many dirs.
  keep: 5,
};

export const HOST_CONTRACT: HostContract = {
  hostApi: 2,
  hostModules: [
    "@earendil-works/pi-coding-agent",
    "@earendil-works/pi-tui",
    "typebox",
    "typebox/value",
    "@repo/s2-agent-core-runtime",
    // pi-ai is already compiled in via pi-coding-agent; serving it costs ~zero
    // core bytes and keeps the model/streaming types identity-stable for the
    // extensions that import it (subagent, workflow, hermes-memory, btw, webui).
    "@earendil-works/pi-ai",
    "@earendil-works/pi-ai/compat",
    // GATE_DEFS is a shared mutable registry — obsidian, knowledge-card and
    // wayfind all register gate families into it at module scope, so it must be
    // served as ONE host instance (an inlined copy per extension would split it).
    "@repo/s2-agent-core-interface",
  ],
};

/** Run-dir lazy extension map (empty today; kept as data so it stays typed). */
export const LAZY_EXTENSIONS: Record<string, string> = {};

export const REGISTRY: RegistryEntry[] = [
  {
    name: "task",
    package: "s2-agent-ext-task",
    entry: "extensions/task.ts",
    load: "static",
    enabled: true,
    deploy: { order: 10 },
  },
  {
    name: "prompt-history",
    package: "s2-agent-ext-prompt-history",
    entry: "extensions/prompt-history.ts",
    load: "static",
    enabled: true,
    notes: "Pure code: imports only pi-coding-agent + node builtins.",
    deploy: { order: 20 },
  },
  {
    name: "hermes-memory",
    package: "s2-agent-ext-hermes-memory",
    entry: "extensions/hermes-memory.ts",
    load: "static",
    skills: true,
    enabled: true,
    notes: [
      "sqlite is bun:sqlite (a builtin, no native vendoring); scripts/ holds the",
      "git merge-driver resolved via require(\"#pi/ext-dir\").",
    ].join("\n"),
    deploy: { order: 50, copy: ["scripts"] },
  },
  {
    name: "superpowers",
    package: "s2-agent-ext-superpowers",
    entry: "extensions/superpowers.ts",
    load: "static",
    skills: true,
    enabled: true,
    notes: [
      "Code + skills tree (52 files / ~450K). Skills resolve at runtime through",
      "require(\"#pi/ext-dir\") — bun's cjs output folds import.meta.url into a",
      "build-machine path, which the relocatability gate rejects.",
    ].join("\n"),
    deploy: { order: 30 },
  },
  {
    name: "wayfind",
    package: "s2-agent-ext-wayfind",
    entry: "extensions/wayfind.ts",
    load: "static",
    skills: true,
    enabled: true,
    notes: [
      "procedures/ holds the wayfinder data file (NOT a skill — pi would",
      "auto-register it as /skill:<name>); copied beside the bundle and read",
      "through require(\"#pi/ext-dir\") at runtime.",
    ].join("\n"),
    deploy: { order: 40, copy: ["procedures"] },
  },
  {
    name: "web-access",
    package: "s2-agent-ext-web-access",
    entry: "extensions/web-access.ts",
    load: "static",
    skills: true,
    enabled: true,
    excludeReason:
      "heaviest extension (readability/linkedom/turndown inline + vendored unpdf); dev-machine web tooling, not needed on the portable target",
    notes: [
      "Largest bundle (~880K: readability/linkedom/turndown etc. inline). unpdf",
      "is VENDORED, not bundled: its ESM uses import.meta.resolve, whose syntax",
      "is invalid inside the loader's cjs eval — as a real directory it loads as",
      "a proper module.",
      "",
      "EXCLUDED FROM DEPLOY (user decision 2026-08-24): the web-fetch/read",
      "tooling is a dev-machine convenience — the portable tree does not need",
      "the heaviest extension plus a vendored unpdf directory. Loads in source",
      "mode as before; does not ship. Re-include = give it a deploy block again",
      "(order 90, vendor unpdf).",
    ].join("\n"),
  },
  {
    name: "obsidian",
    package: "s2-agent-ext-obsidian",
    entry: "extensions/obsidian.ts",
    load: "static",
    skills: true,
    enabled: true,
    notes: [
      "Tier-0 vault I/O. The subagent-barrel imports inline safely post-#1733:",
      "the identity-sensitive symbols are core-runtime re-exports that resolve",
      "to the host module, and the barrel-owned ones (persistence, subprocess",
      "spawn) are disk-backed/stateless. vault-template/ seeds a fresh vault on",
      "a portable machine — located via require(\"#pi/ext-dir\"), copied beside",
      "the bundle.",
    ].join("\n"),
    deploy: { order: 130, copy: ["vault-template"] },
  },
  {
    name: "btw",
    package: "s2-agent-ext-btw",
    entry: "extensions/btw.ts",
    load: "static",
    skills: true,
    enabled: true,
    deploy: { order: 80 },
  },
  {
    name: "file2md",
    package: "s2-agent-ext-file2md",
    entry: "extensions/file2md.ts",
    load: "static",
    skills: true,
    enabled: true,
    notes: [
      "v2 is bun-only (pdfjs text + vendored dsh-cowork office + pdfium wasm +",
      "tesseract-wasm OCR) with an optional local vision tier (LM Studio at",
      "runtime, never shipped). Since 2026-08-25 ALL code bundles into ext.cjs",
      "and only the npm payloads ship, under vendored/ — NO node_modules tree",
      "in the deployed ext (user directive: keep the dist free of unnecessary",
      "node_modules). Payloads are byte-for-byte npm copies via the deploy",
      "assets field — no rebuild, no network at deploy time (ADR-file2md-0001).",
      "FILE2MD_OCR_LANG_PATH overrides the lang data at runtime.",
    ].join("\n"),
    deploy: {
      order: 85,
      assets: [
        { pkg: "tesseract-wasm", from: "dist/tesseract-core.wasm", to: "vendored/tesseract-wasm/tesseract-core.wasm" },
        { pkg: "@hyzyla/pdfium", from: "dist/pdfium.wasm", to: "vendored/pdfium/pdfium.wasm" },
        { pkg: "pdfjs-dist", from: "wasm", to: "vendored/pdfjs/wasm" },
        { pkg: "pdfjs-dist", from: "standard_fonts", to: "vendored/pdfjs/standard_fonts" },
        { pkg: "pdfjs-dist", from: "cmaps", to: "vendored/pdfjs/cmaps" },
        { pkg: "pdfjs-dist", from: "iccs", to: "vendored/pdfjs/iccs" },
        { pkg: "@tesseract.js-data/eng", from: "4.0.0_best_int/eng.traineddata.gz", to: "vendored/tessdata/eng.traineddata.gz" },
        { pkg: "@tesseract.js-data/chi_sim", from: "4.0.0_best_int/chi_sim.traineddata.gz", to: "vendored/tessdata/chi_sim.traineddata.gz" },
      ],
    },
  },
  {
    name: "subagent",
    package: "s2-agent-ext-subagent",
    entry: "extensions/subagent.ts",
    load: "static",
    enabled: true,
    notes: "Host-lib consumer: core-runtime + pi-ai + its own lib are all host modules.",
    deploy: { order: 60 },
  },
  {
    name: "ultracode",
    package: "s2-agent-ext-ultracode",
    entry: "extensions/ultracode.ts",
    load: "static",
    enabled: true,
    notes: [
      "Must load after subagent (registry population); acorn bundles inline.",
      "Short name = ultracode (was \"workflow\" pre-2026-08-22; see",
      "docs/agents/extension-naming.md).",
    ].join("\n"),
    deploy: { order: 70 },
  },
  {
    name: "knowledge-card",
    package: "s2-agent-ext-knowledge-card",
    entry: "extensions/knowledge-card.ts",
    load: "static",
    skills: true,
    enabled: true,
    notes: [
      "Tier-1 knowledge hub (zk_card / zk_ask / zk_ingest / knowledge_query).",
      "Imports obsidian's src/lib directly (NOT the extension entry — inlining",
      "the entry would double-register GATE_DEFS and duplicate its bulk); the",
      "dispatch imports come from the core-runtime host module.",
    ].join("\n"),
    deploy: { order: 140 },
  },
  {
    name: "power-tool",
    package: "s2-agent-ext-power-tool",
    entry: "extensions/power-tool.ts",
    load: "static",
    skills: true,
    enabled: true,
    notes: [
      "power-tool pulls playwright-core (the browser tool). It is VENDORED,",
      "not bundled: bun's cjs output rewrites __dirname to the path the file had",
      "on the BUILD MACHINE, and playwright-core locates its own resources that",
      "way — bundling it baked ~/.bun/install/cache/... into the deploy and made",
      "the tree non-relocatable (gate 4 now blocks that). Vendoring ships it as",
      "a real directory under ext/power-tool/node_modules/, where __dirname",
      "means what it says.",
      "",
      "playwright-core's own unresolvable internals + optional peers: its",
      "vendored bundle does require(\"chromium-bidi/...\") while declaring zero",
      "deps; those calls sit in esbuild's lazy __esm({...}) for bidiOverCdp,",
      "which the default CDP path never enters. kerberos / vite / @playwright/test",
      "are optional peers reached only from code paths this agent never takes.",
    ].join("\n"),
    deploy: {
      order: 100,
      vendor: ["playwright-core"],
      externals: ["chromium-bidi/*", "kerberos", "vite", "@playwright/test"],
    },
  },
  {
    name: "webui",
    package: "s2-agent-ext-webui",
    entry: "extensions/webui.ts",
    load: "dynamic",
    skills: true,
    enabled: true,
    excludeReason: "local-operator browser UI; no operator on the portable target",
    notes: [
      "Pure code: the HTML shell is a single inline string constant; Bun.serve",
      "WS works in the compiled binary. webui-audit skill + the `webui` audit",
      "TOOL live HERE (both moved from power-tool — the audit drives the",
      "webui's own surface; user directive 2026-08-25).",
      "",
      "EXCLUDED FROM DEPLOY (user decision 2026-08-24): the browser UI serves a",
      "local operator at a desk; the portable tree has no operator to point at",
      "it. Loads in source mode as before; does not ship. Re-include = give it a",
      "deploy block again (order 110).",
      "",
      "OUT OF THE STATIC SET (user decision 2026-08-25, archify-webui-decouple):",
      "dynamic `-e` keeps source-mode loading while removing the static-bundle",
      "import — and dynamic entries do not ride the --exe build, which is the",
      "right shape for a deploy-excluded local-operator UI. Coupling to archify",
      "is a frozen string-literal contract ONLY (webui:open / webui:present /",
      "webui:deck — archify emits, webui subscribes, zero imports either way).",
    ].join("\n"),
  },
  {
    name: "hyperframes",
    package: "s2-agent-ext-hyperframes",
    entry: "extensions/hyperframes.ts",
    load: "static",
    skills: true,
    enabled: false,
    disableReason: [
      "DISABLED BY DEFAULT 2026-08-24 (user decision, tool-gate precedent): the",
      "HyperFrames skills family is not yet proven must-have, so it is OFF in",
      "every dimension until that is established — not loaded in source mode,",
      "not shipped in the deploy tree.",
    ].join("\n"),
    reEnableNote: [
      "Re-enable = set enabled: true + `bun run regen:manifest` +",
      "`regen:static` once a real consumer demonstrates the need. (Pre-migration",
      "prose said: uncomment this entry + regen:manifest + regen:static.)",
    ].join("\n"),
    notes: [
      "Skills-only carrier (~5.5MB skills incl. mp3 SFX / woff2 fonts + vendored",
      "@hyperframes/core, @hyperframes/producer, and the sharp native binary).",
      "Factory is a no-op; skills copy verbatim.",
      "",
      "Vendor rationale: the skill helpers (animation-map / contrast-report)",
      "import these at runtime; vendoring their full closure lets the dist",
      "answer offline — no npm-install bootstrap. pinned exact in",
      "s2-agent-ext-hyperframes/package.json. Frame capture needs a browser:",
      "run.sh exports PUPPETEER_EXECUTABLE_PATH to system Chrome (none is",
      "bundled).",
      "",
      "producer DECLARES 11× @fontsource/* but never resolves them at runtime:",
      "its fonts are a base64 woff2 table embedded in the bundle itself",
      "(dist/services/fontData.generated.ts — fontDataUri() reads only that Map,",
      "zero @fontsource requires across producer/engine/core/skills). Vendored,",
      "the packages are ~22MB of weight no code path can reach. Recorded in",
      "ext.json vendoredClosure.excluded; Gate 5d honours it.",
    ].join("\n"),
    deploy: {
      order: 120,
      vendor: ["@hyperframes/core", "@hyperframes/producer", "sharp"],
      vendorExclude: ["@fontsource/*"],
    },
  },
  {
    name: "tool-gate",
    package: "s2-agent-ext-tool-gate",
    entry: "extensions/tool-gate.ts",
    load: "dynamic",
    version: "0.1.0",
    enabled: false,
    disableReason: [
      "DISABLED BY DEFAULT 2026-08-24 (user decision, after #1946 + its",
      "half-fix follow-up): tool-gate's discovery could not see the host",
      "built-ins (read/write/edit/bash/grep/find/ls — they live in",
      "_toolDefinitions, not getAllRegisteredTools), and",
      "setActiveToolsByName REPLACES agent.state.tools wholesale, so two",
      "deploys + the dev tree shipped sessions whose model had NO file tools",
      "while every existing gate stayed green. The builtin-union fix + the",
      "deploy-e2e `tools-probe` (asserts core builtins ACTIVE) landed on branch",
      "ci/tools-active-probe (#1952, merged);",
    ].join("\n"),
    reEnableNote: [
      "Re-enable = set enabled: true + `bun run regen:manifest` once the",
      "builtin-union fix is merged (#1952 — it is) and the tools-probe has",
      "baked green. (Pre-migration prose said: uncomment this entry +",
      "regen:manifest once that PR is merged and the probe has baked green.)",
    ].join("\n"),
    notes: [
      "History (why it shipped 2026-08-23 in the first place): the dist carries",
      "74% of the full-tree gate-managed schema mass — 12,637 gross / 12,328",
      "net (57.3%) saved at session start on the real dist; fail-open for",
      "untracked tools + the enable_tool escape hatch; the recall",
      "corpus/gate-recall probes stay repo-side and the deploy e2e",
      "`tool-gate-fire` probe smoke-gates the shipped matcher.",
    ].join("\n"),
    deploy: { order: 190 },
  },
  {
    name: "devops",
    package: "s2-agent-ext-devops",
    entry: "extensions/devops.ts",
    load: "dynamic",
    skills: true,
    version: "0.1.0",
    enabled: true,
    notes: [
      "Ships for on-this-machine use (2026-08-23): the git/PR tool family",
      "(sync/prepare/sweep/verify-merge/retrospect/show_pr_status) is portable",
      "to any git repo; the repo-bound tools (run_local_ci / check_main_health /",
      "deploy_pi_agent_sh / verify_pi_agent_deploy) FAIL CLOSED with remediation",
      "text outside this repo's source layout. deploy_pi_agent_sh spawns the",
      "repo-side CLI (never imports the pipeline — its module-scope",
      "import.meta paths would bake build-machine paths into the bundle).",
    ].join("\n"),
    deploy: { order: 180 },
  },
  {
    name: "s2-agent-ext-flux2",
    package: "s2-agent-ext-flux2",
    entry: "extensions/flux2.ts",
    load: "dynamic",
    enabled: true,
    excludeReason: "bound to this machine's swift CLIs and services",
  },
  {
    name: "s2-agent-ext-krea2",
    package: "s2-agent-ext-krea2",
    entry: "extensions/krea2.ts",
    load: "dynamic",
    enabled: true,
    excludeReason: "bound to this machine's swift CLIs and services",
  },
  {
    name: "s2-agent-ext-ltx",
    package: "s2-agent-ext-ltx",
    entry: "extensions/ltx.ts",
    load: "dynamic",
    enabled: true,
    excludeReason: "bound to this machine's swift CLIs and services",
  },
  {
    name: "s2-agent-ext-research-tool",
    package: "s2-agent-ext-research-tool",
    entry: "extensions/research-tool.ts",
    load: "dynamic",
    skills: true,
    version: "0.1.0",
    enabled: true,
    excludeReason: "bound to this machine's swift CLIs and services",
  },
  {
    name: "s2-agent-ext-zai-mcp",
    package: "s2-agent-ext-zai-mcp",
    entry: "extensions/zai-mcp.ts",
    load: "dynamic",
    version: "0.1.0",
    enabled: true,
    excludeReason: "bound to this machine's swift CLIs and services",
  },
  {
    name: "s2-agent-ext-movie-director",
    package: "s2-agent-ext-movie-director",
    entry: "extensions/movie-director.ts",
    load: "dynamic",
    version: "0.1.0",
    enabled: true,
    excludeReason: "bound to this machine's swift CLIs and services",
  },
  {
    name: "archify",
    package: "s2-agent-ext-archify",
    entry: "extensions/archify.ts",
    load: "static",
    skills: true,
    enabled: true,
    notes: [
      "Typed-IR technical diagrams → validated self-contained HTML → .pptx deck.",
      "Fully offline and zero-browser (pptx = pptxgenjs native shapes; the HTML",
      "template inlines its own script/style — audited in #809). The vendored/",
      "tree (~1.5MB) carries the renderer bins + schemas the tools spawn via",
      "process.execPath; lib/run.ts resolves it through the #pi/ext-dir idiom",
      "(import.meta folds to a build-machine path inside the cjs bundle — the",
      "#809 defect class), and the bins re-resolve renderers from their own",
      "__dirname, so the whole tree relocates with the deploy. marked/pptxgenjs",
      "are INLINED by the bundler, not vendored: they are pure JS with no",
      "__dirname resources, and a vendored pptxgenjs dies inside the compiled",
      "binary anyway — its internal require(\"jszip\") is a package specifier,",
      "which the $bunfs-virtualized resolution cannot serve (vendoring is for",
      "resource/path-sensitive packages like playwright-core/sharp/unpdf).",
      "mermaid is devDep-only: the `architecture:vendor` build step copies its",
      "UMD into vendored/ at repo time; NO extension tool imports it at runtime",
      "(kept out of deps so no closure can ever drag its ~84MB in).",
    ].join("\n"),
    deploy: { order: 150, copy: ["vendored"] },
  },
  {
    name: "compact",
    package: "s2-agent-ext-compact",
    entry: "extensions/compact.ts",
    load: "static",
    enabled: true,
    notes: "Pure code: imports only pi-coding-agent / pi-ai + node builtins. order 160 — 150 was taken by archify on main (#1783).",
    deploy: { order: 160 },
  },
  {
    name: "sv-analyzer",
    package: "s2-agent-ext-sv-analyzer",
    entry: "extensions/sv-analyzer.ts",
    load: "static",
    enabled: true,
    excludeReason:
      "wasm is a machine-built gitignored artifact; ship would require the 40MB mirror in every fresh worktree",
    notes: [
      "Verilog/SystemVerilog analyzer (sv_analyze / sv_ast) — the s2-agent face",
      "of the dsh-sv-analyzer plugin. Pure code: imports only pi-coding-agent +",
      "typebox + node builtins (node:wasi for the parser). wasm/ is the built",
      "tree-sitter binary, mirrored from dsh-plugin/sv-analyzer/build.sh and",
      "GITIGNORED (regenerated artifact, same policy as the plugin's own",
      "plugin/wasm/); resolved at runtime via require(\"#pi/ext-dir\").",
      "",
      "EXCLUDED FROM DEPLOY (user decision 2026-08-24): the wasm is a",
      "machine-built 40MB artifact that exists only where build.sh ran —",
      "promising it in the portable tree made every fresh worktree's Deploy-sh",
      "L1 gate fail on the missing mirror (gate 17, \"copy dir 'wasm' not",
      "found\"). Machine-bound like the swift-CLI extensions: loads in source",
      "mode (pure-code entry; wasm is read lazily at tool-call time), does not",
      "ship. Re-include = give it a deploy block again AFTER the wasm is either",
      "committed (LFS) or built by the deploy pipeline itself.",
    ].join("\n"),
  },
];

// ─── Pure helpers ─────────────────────────────────────────────────────────────

/** Entries that actually load/ship — the legacy YAML world only ever saw these. */
export function activeEntries(): RegistryEntry[] {
  return REGISTRY.filter((e) => e.enabled);
}

/** Entries with a live deploy block (ships), in registry order. */
export function shippedEntries(): RegistryEntry[] {
  return activeEntries().filter((e) => e.deploy !== undefined && e.deploy.enabled !== false);
}

// ─── Legacy Registry shape (consumed by src/run-dir validation) ──────────────
//
// Structural mirror of the Registry shape src/run-dir/registry.ts returns. The
// module cannot import it (zero-import contract, map D4); the projection
// below builds the shape the pre-migration YAML parser produced, so
// src/run-dir/registry.ts's `loadRegistry()` and everything downstream (manifest
// emitter, devops ShConfig projection, tests) consume an unchanged contract.
// Home comes in as an argument — the module cannot call homedir() (zero
// imports), and outRoot is stored in ~ form so it stays machine-neutral.

interface LegacyRegistryExt {
  name: string;
  package: string;
  entry: string;
  load: "static" | "dynamic";
  skills: boolean;
  version?: string;
  excludeReason?: string;
  deploy?: {
    order: number;
    copy: string[];
    vendor: string[];
    assets: RegistryDeployAsset[];
    externals: string[];
    vendorExclude: string[];
    enabled: boolean;
  };
}

interface LegacyRegistry {
  deploy: {
    outRoot: string;
    version: { from: "package.json"; gitSha: boolean };
    freeze: boolean;
    current: boolean;
    keep?: number;
  };
  hostApi: number;
  hostModules: string[];
  extensions: LegacyRegistryExt[];
  lazyExtensions: Record<string, string>;
}

function expandHome(p: string, home: string): string {
  if (p === "~") return home;
  if (p.startsWith("~/")) return `${home}/${p.slice(2)}`;
  return p;
}

export type { LegacyRegistry };

/**
 * Project the typed registry into the legacy `Registry` shape consumers have
 * always known — the post-migration counterpart of the retired parseRegistry.
 * The old projection's ShConfig half died with parseShConfig: devops builds
 * its own ShConfig out of this shape. Pure.
 */
export function legacyRegistry(opts: { home: string }): LegacyRegistry {
  const outRoot = expandHome(DEPLOY_CONFIG.outRoot, opts.home);
  const keep = DEPLOY_CONFIG.keep;

  const extensions: LegacyRegistryExt[] = activeEntries().map((e) => ({
    name: e.name,
    package: e.package,
    entry: e.entry,
    load: e.load,
    skills: e.skills === true,
    version: e.version,
    excludeReason: e.excludeReason,
    deploy:
      e.deploy === undefined
        ? undefined
        : {
            order: e.deploy.order,
            copy: e.deploy.copy ?? [],
            vendor: e.deploy.vendor ?? [],
            assets: e.deploy.assets ?? [],
            externals: e.deploy.externals ?? [],
            vendorExclude: e.deploy.vendorExclude ?? [],
            enabled: e.deploy.enabled ?? true,
          },
  }));

  return {
    deploy: {
      outRoot,
      version: { from: "package.json", gitSha: DEPLOY_CONFIG.version.gitSha },
      freeze: DEPLOY_CONFIG.freeze,
      current: DEPLOY_CONFIG.current,
      ...(keep !== undefined ? { keep } : {}),
    },
    hostApi: HOST_CONTRACT.hostApi,
    hostModules: HOST_CONTRACT.hostModules,
    extensions,
    lazyExtensions: LAZY_EXTENSIONS,
  };
}
