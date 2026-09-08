status: closed (2026-09-08, PR with the arc's implementation)

# t02 — isolation semantics gates

- [x] non-repo base: `isolated:false` → loud `isolation ignored` log; child cwd
      = main tree (pinned as DOCUMENTED HAZARD, not silent).
- [x] precedence: call-site `isolation` beats agentDef (workflow-runtime
      :344-345); documented gotcha — no sentinel to suppress a def's isolation.
- [x] deterministic naming: `${runId}-${callIndex}-${label}` — same runId+shape
      → stable keys (resume annotation basis, :98-101).
