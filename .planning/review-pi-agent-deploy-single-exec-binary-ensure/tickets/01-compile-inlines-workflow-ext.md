---
type: research
status: closed
---

# 01 — Does `--compile` inline the workflow extension into the standalone exe?

## Question

Is `@repo/pi-agent-ext-workflow` (the pack resolver + engine) actually **baked
into** the `bun build --compile` standalone executable, or externalized such
that a repo-less machine can't resolve it? This gates every portable design: if
the ext is externalized, the first fix is the build config, not pack discovery.

## Resolution

**Yes — it is inlined.** `bun-apps/pi-agent-cli/scripts/build.ts` declares **no
`external`** field in either stage (the only `external` mentions are
sourcemap-related: `sourcemap: "external"|"none"`, `--sourcemap=external`).
`bun build src/cli.ts --compile` (and the preceding bundle stage) inline **all**
resolvable imports, including the `@repo/pi-agent-ext-workflow` workspace dep
(resolvable via the `node_modules` symlink). `bun-apps/bunfig.toml` configures
only the install linker (`linker = "isolated"`, `globalStore = true`) — it has
no bundler-external effect.

`commands/workflow.ts` imports the resolver by name with a comment claiming the
bundler "treats them as externals exactly like the other workspace deps" — that
comment is **inaccurate for the compile artifact** (it may describe dev /
source-mode intent, where the package resolves via the symlink). The resolver
(`resolveWorkflowScript` / `findRepoRoot`) and the `node:vm` engine are baked
into the exe.

**Probe confirmation (2026-07-19 build probe).** `bun run build:exe` →
`dist/pi-agent-cli/pi-agent-cli` (4220 modules bundled, 71 MB exe). Grep of the
bundled `dist/pi-agent-cli/cli.js` finds the resolver's distinctive strings
inlined (minify mangles identifiers but strings survive):
`"is a directory without a manifest.json"`, `"Pass an absolute path or a name
under"`, `".pi/workflows"` (×10), `"bun-apps"` (×20), `"manifest.json"` (×11).
Definitive — the resolver is baked into the standalone exe.
