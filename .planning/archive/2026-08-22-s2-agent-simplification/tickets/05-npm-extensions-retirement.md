# T5 — NPM_EXTENSIONS retirement

deps-probe.ts:

- Delete `NPM_EXTENSIONS = []` + its long comment block (:21-40).
- Delete `probeMissingNpm()`.
- `missingExtensionPackages` dedupes only `probeMissingExtensionDeps`.
- `resolveNpmExtensionPaths` reduces to `return []` — export KEPT (resolve.ts
  re-exports it; call sites unchanged).
- Keep the `autoInstalled` flag (still set by maybeAutoInstall, read by
  emitMissingDepsGuide) — auto-install/guide serve real transitive deps.

**Verify**: run-dir/resolve.test.ts + full suite; boot smoke
`./s2-agent.sh -p "reply OK"`.

Status: **closed**
