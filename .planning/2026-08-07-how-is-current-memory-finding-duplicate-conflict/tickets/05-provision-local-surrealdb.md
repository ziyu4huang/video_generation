claimed: pi-agent (2026-08-07 work session)
type: task

## Question

Stand up a local SurrealDB v3 instance the benchmark harness can connect to (the `src/store/surreal/` backend targets a local server) and prove connectivity from the existing `SurrealBackend` (`init` + `healthCheck`). Capture the connection params / CLI invocation so ticket 06's harness can spin it up deterministically. If SurrealDB isn't installed: decide install-locally vs Docker vs document-as-prerequisite. Resolved when a reproducible connection is demonstrated.

## Resolution

**Provisioned & connectivity proven from the real backend.** SurrealDB v3.2.3 (Homebrew, `/opt/homebrew/bin/surreal`) is running at `http://127.0.0.1:8000`, in-memory backend, root/root auth.

**Reproducible recipe:**
- Start: `nohup surreal start --user root --pass root --bind 127.0.0.1:8000 memory > /tmp/hermes-surreal.log 2>&1 & disown`
- Health: `curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:8000/health` -> `200`
- Stop: `lsof -ti :8000 | xargs kill`

**Connectivity proof (acceptance criterion):** ran the existing `tests/store/surreal/surreal-backend.test.ts` (guarded by `isSurrealUp()` -> runs only when the server is up). Result: **RAN-green** — `init() bootstraps schema and is idempotent; healthCheck passes`. Not skipped. So `SurrealBackend.init()` (runs `SURREAL_BOOTSTRAP_SQL`, idempotent) + `healthCheck()` (`RETURN 1;`) both succeed against the live server.

**Connection params the harness (06) uses** (all defaults, no config change):
- endpoint `http://127.0.0.1:8000`, user `root`, pass `root`
- namespace auto-derived `user_huangziyu` via `derivePerUserNamespace()`
- database `memory`
- No external surreal SDK — hand-rolled HTTP client posting to `{endpoint}/sql` with `surreal-ns`/`surreal-db` headers.

**Notes for the harness (06):**
- Backend is **in-memory** -> clean slate each restart; harness generates its own corpus per run (matches 03's "build corpus generator from scratch"). Fairness flag for 06: in-memory surreal vs file-backed SQLite is a confound -> 06 may also test disk-backed surreal (`surreal start ... surrealkv:<dir>`) for an apples-to-apples storage comparison.
- Use an isolated namespace per run (like the tests' `uniqueNs()` -> `hm_test_<pid>_<nonce>_<ts>`) for clean teardown (`REMOVE NAMESPACE IF EXISTS`).
- `init()` is idempotent -> safe at harness setup.

closed: 2026-08-07 (surreal up + real-backend test green)
