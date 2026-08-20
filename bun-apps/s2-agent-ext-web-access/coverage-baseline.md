# web-access coverage baseline

*Established 2026-07-06 as part of the non-media extension quality pass. This is
a baseline + risk-weighted gap analysis, not a pursuit of a coverage percentage
— fetch plumbing is wasteful to unit-test, but the security-critical and
shared-logic paths must be covered.*

## What's covered (32 tests, 3 files)

| Area | File | Tests | Why it matters |
|---|---|---|---|
| **SSRF guard** | `__tests__/ssrf-protection.test.ts` | 13 | Security-critical. `validateRemoteUrl` is the only thing between the agent and internal/metadata endpoints. Covers protocol/hostname guards, literal-IP blocks (loopback, RFC1918, link-local/metadata, IPv6), DNS-rebinding defense (injected `lookup`), and the `allowRanges` exemption. Fully deterministic (mock DNS). |
| **Search error/cancel rendering** | `__tests__/pure-helpers.test.ts` | 4 | `buildSearchErrorPlan` is the shared renderer for EVERY provider adapter's cancel/error state. Covers null-signal, bare-error, partial-query diagnostics, extraLines. |
| **fetch_content arg normalization** | `__tests__/pure-helpers.test.ts` | 4 | `normalizeFetchContentParams` is the input boundary for the most-used web tool. Covers single/array URL handling, dedup, forceClone typing, the frames-gating rule. |
| **Model-scope gating** | `__tests__/pure-helpers.test.ts` | 5 | `summaryModelValue` + `modelMatchesEnabledPatterns` decide which models the summary layer runs on. Covers composition, null-patterns-allow-all, exact + glob + thinking-suffix matching. |
| **Smoke** | `__tests__/smoke.test.ts` | 1 (pre-existing) | Module import smoke. |

The provider adapters (`searchWithBrave`, `searchWithExa`, `searchWithTavily`,
`searchWithPerplexity`, `searchWithOpenAI`, `searchWithParallel`, gemini) all
funnel through this shared spine — so the logic most likely to harbor bugs
(SSRF, error rendering, arg normalization, model gating) is now covered.

## What's NOT covered (and why that's acceptable)

| Gap | LOC | Why uncovered / risk |
|---|---|---|
| **Per-provider HTTP search paths** (`brave.ts`, `exa.ts`, `tavily.ts`, `perplexity.ts`, `openai-search.ts`, `parallel.ts`, `gemini-*.ts`) | ~3500 | Thin glue over `fetch` to a vendor API. Testing meaningfully needs (a) recorded HTTP responses (nock/msw-style harness) or (b) live API keys. Both are non-deterministic / secret-bearing and excluded from the CI gate by design. The request-building (`URLSearchParams`, headers) is low-logic; the response shaping feeds `buildSearchErrorPlan` (covered). **Risk: LOW-MEDIUM.** A future hardening goal should add a recorded-response harness. |
| **curator-server live-browser** (`curator-server.ts`, `curator-page.ts`) | ~1200 | Drives a headless browser via a sidecar process. Inherently stateful + external (needs the browser binary + a running server). Untestable without a browser fixture. **Risk: MEDIUM** (it's the blocked-bot fallback path). Tracked as a future goal item. |
| **Extractors** (`pdf-extract`, `github-extract`, `youtube-extract`, `video-extract`, `rsc-extract`) | ~1800 | Each wraps a distinct external source (pdf parse, GitHub API, yt-dlp, ffmpeg, RSC hydration). Same recorded-response story as the providers. **Risk: LOW** (failure modes are surfaced as tool errors, not silent). |
| **chrome-cookies.ts** | ~150 | Reads the user's Chrome cookie DB for authenticated fetches. Touches the filesystem + a locked SQLite DB; testing needs a fixture DB. **Risk: LOW** (opt-in auth path; failures degrade gracefully to anonymous fetch). |
| **activity.ts, storage.ts, utils.ts** | ~600 | Bookkeeping (activity log, cache store, misc helpers). Low logic, low risk. Could be covered opportunistically but no known bug surface. |

## CI gate

`cd bun-apps/s2-agent-ext-web-access && bun test` — **must stay green** (currently
32 pass / 0 fail). New shared-logic or security code MUST add tests here before
merge; new vendor HTTP adapters may land without per-provider tests but should
route errors through the covered `buildSearchErrorPlan`.

## Next step (future goal)

Add a recorded-HTTP-response harness (mock `global.fetch` with fixture JSON per
provider) so the provider search paths get deterministic request-shaping +
response-parsing tests without live keys. This closes the largest remaining gap
(the ~3500-LOC provider layer) and is the natural follow-up to this baseline.
