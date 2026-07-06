# pi.dev Extension Ecosystem Review

> **Planning doc — `plan/ecosystem-kg-review` cycle.** Research + design audit only.
> No code shipped from this cycle. Companion: [`kg-improvement-plan.md`](./kg-improvement-plan.md).
>
> **Snapshot date:** 2026-07-07. Catalog source: <https://pi.dev/packages>
> (4,909 packages total). Download figures are npm monthly downloads as shown
> on the catalog; they reflect *demand + age + marketing*, not quality.

---

## TL;DR

- **The single hottest demand signal is context-cost.** `@hypabolic/pi-hypa`
  (204.8K/mo) is the #1 package by downloads, and `context-mode` (114.5K/mo)
  is #3. Our `--schema-cost` instrument (PR #330) is on the right track — it
  measures a lever the ecosystem actively pays to compress. We **lead** on
  *measurement*; they lead on *compression*. Document the complement, don't rebuild.
- **We already publish two packages** that are mid-pack popular:
  `@quintinshaw/pi-dynamic-workflows` (23.6K/mo) and `pi-hermes-memory`
  (15K/mo). The ecosystem accepts our design.
- **Image/video generation tooling has zero community equivalent.** Our
  `flux2`/`ltx`/`krea2`/`movie-director` extensions are a unique niche — no
  package in the top-50 does ML generation. No publish-back decision is urgent
  there (they depend on a sibling Swift/MLX runtime that is not npm-portable).
- **The one real publish-back question is `power-tool`.** It overlaps three
  high-demand community packages (`rpiv-ask-user-question` 35.2K,
  `rpiv-todo` 29.2K, `@narumitw/pi-goal` 10.8K) that we forked first-party in
  PR #326. Recommendation: **keep private for now, document the fork rationale.**
- **Diagnostics is a genuine gap** (`pi-lens` 25.2K, `pi-shazam` 10.9K) — but
  it is an *intentional* out-of-scope for an ML-generation-focused repo, not an
  oversight. Log it as a conscious non-goal.

---

## 1. Ecosystem map — top ~40 packages by monthly downloads

Bucketed by primary function. "Kind" = the pi package kind
(`extension` / `skill` / `package` / `prompt` / `theme`). Downloads are
monthly (K = thousands). **Ours** marks first-party packages we author.

### 1.1 Context-cost (the #1 demand bucket)

| Package | DL/mo | Kind | What makes it popular |
|---|---|---|---|
| **@hypabolic/pi-hypa** | 204.8K | package | Rewrites shell commands through Hypa for *deterministic compression* of noisy tool output; recoverable evidence. Pure local, no model round-trip. |
| **context-mode** | 114.5K | package | MCP plugin claiming "98% context savings": sandboxed code exec + FTS5 knowledge base + intent-driven search. Cross-agent (Claude Code, Gemini CLI, Copilot, Codex). |
| **pi-lean-ctx** | 9.1K | package | Routes bash/read/grep/find/ls through lean-ctx for token savings; persistent session cache (~13 tokens for unchanged re-reads). |

### 1.2 Memory / knowledge

| Package | DL/mo | Kind | What makes it popular |
|---|---|---|---|
| **@remnic/plugin-pi** | 17.4K | package | Remnic persistent-memory extension (cloud-or-local brain across sessions/compactions). |
| **pi-hermes-memory** *(OURS, published)* | 15.0K | ext+skill | Token-aware policy-only memory, SQLite FTS5 search, auto-consolidation, procedural skills. 368 tests. |
| **gentle-engram** | 8.4K | extension | Persistent memory — one local-or-cloud brain shared across sessions, compactions, MCP agents. |
| *(recently published)* **pi-vault-mind** | new | package | Forked subagents (Miner/Broadcaster/Heavy-Lifter) watching `@agent` markers; LanceDB vector+FTS+graph. |

### 1.3 Subagents / workflows

| Package | DL/mo | Kind | What makes it popular |
|---|---|---|---|
| **pi-subagents** | 102.8K | package | Delegation to subagents with chains, parallel exec, TUI clarification. |
| **@tintinweb/pi-subagents** | 37.4K | extension | Claude-Code-style autonomous sub-agents for pi. |
| **@quintinshaw/pi-dynamic-workflows** *(OURS, published)* | 23.6K | package | Fan-out across 100s of subagents, real model routing, token/cost accounting, resume, git-worktree isolation, `/workflows` TUI, `/deep-research`. |
| **@gotgenes/pi-subagents** | 12.2K | extension | Focused in-process sub-agent core; friendly fork of tintinweb. |
| **pi-crew** | 12.1K | package | Coordinated AI teams, workflows, worktrees, async task orchestration. |

### 1.4 Diagnostics (LSP / lint / structural) — **our gap**

| Package | DL/mo | Kind | What makes it popular |
|---|---|---|---|
| **pi-lens** | 25.2K | extension | Real-time code feedback — LSP, linters, formatters, type-checking, structural analysis. |
| **@ff-labs/pi-fff** | 22.7K | extension | FFF-powered fuzzy file + content search. |
| **pi-simplify** | 21.2K | extension | Reviews recently changed code for clarity/consistency/maintainability. |
| **pi-shazam** | 10.9K | extension | 7 structural-analysis tools; codebase awareness toolkit. Also MCP (Cursor/Claude Desktop). |
| **pi-readseek** | 10.7K | extension | Hash-anchored read/edit/grep, structural code maps, structural search. |
| **opencode-codebase-index** | 8.5K | package | Semantic codebase indexing — find code by meaning. |

### 1.5 Web / MCP bridges

| Package | DL/mo | Kind | What makes it popular |
|---|---|---|---|
| **pi-web-access** | 128.0K | extension | Web search, URL fetch, GitHub clone, PDF, YouTube, local video; 7 providers. |
| **pi-mcp-adapter** | 104.2K | extension | Generic MCP adapter (opens the whole MCP ecosystem). |
| **@ollama/pi-web-search** | 14.6K | extension | Web search/fetch via Ollama's APIs. |
| **pi-agent-browser-native** | 12.3K | extension | Browser automation as a native tool. |
| **@juicesharp/rpiv-web-tools** | 8.9K | extension | Web search/fetch with pluggable providers (Brave/Tavily/Serper/Exa/...). |

### 1.6 Dev-workflow (goal / todo / plan / clarification)

| Package | DL/mo | Kind | What makes it popular |
|---|---|---|---|
| **@juicesharp/rpiv-ask-user-question** | 35.2K | extension | Structured questionnaire with typed options instead of free-form replies. |
| **@ayulab/pi-rewind** | 32.2K | extension | `/rewind` checkpoint navigation. |
| **@juicesharp/rpiv-todo** | 29.2K | extension | Live todo overlay that survives `/reload` and compaction. |
| **@plannotator/pi-extension** | 28.4K | package | Interactive plan review with annotations. |
| **@mjasnikovs/pi-task** | 21.1K | extension | Deterministic task planning + spec orchestration; crash-safe `/task`, verify/enforce gates. |
| **gentle-pi** | 12.3K | package | Senior-architect harness: SDD/OpenSpec, subagents, strict TDD evidence. |
| **@narumitw/pi-goal** | 10.8K | extension | Keeps working on a `/goal` until the agent marks it complete. |
| **pi-soly** | 9.3K | extension | Project mgmt + workflow framework; plans, state, mandatory rules, self-review. |
| **@juicesharp/rpiv-advisor** | 8.8K | extension | A second opinion from a stronger reviewer model before acting. |
| **pi-btw** | 8.4K | extension | Parallel side conversations with `/btw`. |

### 1.7 Sandboxing / permissions / safety

| Package | DL/mo | Kind | What makes it popular |
|---|---|---|---|
| **@gotgenes/pi-permission-system** | 21.2K | extension | Permission enforcement extension. |
| **latchkey** | 11.9K | package | Injects API credentials into curl requests to third-party services. |
| **pi-landstrip** | 11.4K | extension | Landlock-based sandboxing with interactive permission prompts. |
| **cc-safety-net** | 8.9K | package | Blocks destructive git/filesystem commands before execution (hook). |

### 1.8 Model / provider

| Package | DL/mo | Kind | What makes it popular |
|---|---|---|---|
| **pi-cursor-sdk** | 10.1K | extension | Provider extension backed by `@cursor/sdk` local agents. |
| **pi-llama-cpp** | 8.3K | extension | llama.cpp integration (router, single, legacy models). |
| **pi-prompt-template-model** | 7.5K | ext+prompt | Prompt-template model selector. |

### 1.9 Skill bundles (methodology)

| Package | DL/mo | Kind | What makes it popular |
|---|---|---|---|
| **bigpowers** | 27.0K | skill | 73 prescriptive skills — 17 years of solo-dev engineering discipline. |
| **superpowers-zh** | 11.2K | skill | Chinese localization of superpowers (159K★) + 4 original CN skills. |

### 1.10 Observability / tracing

| Package | DL/mo | Kind | What makes it popular |
|---|---|---|---|
| **@raindrop-ai/pi-agent** | 15.2K | package | Automatic tracing via subscriber or extension. |
| **@braintrust/pi-extension** | 8.5K | package | Tracing for sessions/turns/LLM calls/tool execs to Braintrust. |
| **@alexanderfortin/pi-deepseek-usage** | 8.3K | extension | DeepSeek API balance monitoring. |

### 1.11 UI / chrome

| Package | DL/mo | Kind | What makes it popular |
|---|---|---|---|
| **glimpseui** | 12.6K | prompt | Native micro-UI — cross-platform WebView windows with JSON IPC. |
| **pi-powerline-footer** | 11.0K | extension | Powerline status bar. |
| **@firstpick/pi-package-webui** | 10.4K | extension | Local browser UI CLI + `/webui-start` `/webui-status`. |
| **pi-intercom** | 8.4K | package | (companion UI). |
| **@brushes/schema-to-view** | 7.5K | package | UI screenshot → low-code JSON schema. |

> **Total cataloged:** 50 packages across 11 buckets. Bucket demand rank by
> aggregate downloads: **context-cost (328K) > web/MCP (268K) > dev-workflow
> (202K) > subagents (188K) > diagnostics (99K) > memory (49K) > sandboxing
> (52K) > UI (50K) > skills (38K) > observability (32K) > model (26K).**
> Context-cost dominance is the headline.

---

## 2. Our-design audit — first-party extensions vs the buckets

Each extension gets a 2×2 verdict: **(aligns with ecosystem? × leads or lags)**
plus a recommendation: **adopt** (take a community idea) / **publish**
(push ours out) / **differentiate** (keep distinct) / **defer** (conscious non-goal).

### 2.1 `pi-agent-ext-power-tool` — goal + todo + ask_user_question + knowledge_query + graph_health + context_analyzer

- **Overlaps:** `rpiv-ask-user-question` (35.2K), `rpiv-todo` (29.2K),
  `@narumitw/pi-goal` (10.8K), plus `context-mode`'s schema awareness.
- **Verdict:** **aligns × leads.** We unified goal+todo+ask-question into one
  overlay in PR #326 (`aa07b9d0`, "unify goal+todo overlay + zero typecheck
  debt + web-access baseline") with zero typecheck debt — the community ships
  these as three separate packages. We additionally ship `context_analyzer`
  (token breakdown by component) and `tools-metrics --schema-cost` (PR #330),
  which NO community package offers. That is a genuine lead: we *measure* the
  context-cost lever the ecosystem is busy compressing.
- **Recommendation:** **differentiate (lean toward later publish).** Keep
  private now — `power-tool` is tightly coupled to our `pi-knowledge-card`
  graph surface (`knowledge_query`/`graph_health` depend on it), and the goal/
  todo/ask pieces are commodity. If we publish, publish ONLY the
  `schema-cost`/`context_analyzer` instruments as a standalone package — that
  is the defensible, novel part. See §4 decision.

### 2.2 `pi-agent-ext-web-access` — web search, fetch, GitHub, PDF, YouTube, video

- **Overlaps:** `pi-web-access` (128K, nicopreme — note: same author name as
  our package, different scope), `@juicesharp/rpiv-web-tools` (8.9K),
  `@ollama/pi-web-search` (14.6K).
- **Verdict:** **aligns × parity.** Feature-equivalent to the top community
  web-access packages. We recently folded Z.ai in as a first-class provider
  (PR #331, `a3ce0af5`).
- **Recommendation:** **keep private / coexist.** This is a commodity layer we
  need first-party control over (provider routing, the GUI movie-director
  consumes it). No publish urgency — `pi-web-access` already serves the
  community. Track the provider list for parity.

### 2.3 `pi-dynamic-workflows` — fan-out across 100s of subagents

- **Overlaps:** `pi-subagents` (102.8K), `@tintinweb/pi-subagents` (37.4K),
  `pi-crew` (12.1K).
- **Verdict:** **aligns × leads (already published).** Published as
  `@quintinshaw/pi-dynamic-workflows` (23.6K/mo). Our differentiators — real
  model routing (tier-tagged agents), token/cost accounting, resume,
  git-worktree isolation, an interactive `/workflows` TUI, `/deep-research —
  are ahead of the basic chain/parallel `pi-subagents`.
- **Recommendation:** **continue publishing.** This is our proven publish-back
  success. Maintain npm parity; the repo-local copy stays the source of truth.

### 2.4 `pi-hermes-memory` — persistent memory + session search + secret scanning

- **Overlaps:** `@remnic/plugin-pi` (17.4K), `gentle-engram` (8.4K),
  `context-mode` (FTS5 KB, 114.5K).
- **Verdict:** **aligns × leads (already published).** Published (15K/mo).
  Differentiators: token-aware *policy-only* default (not blob memory), secret
  scanning, 368 tests, procedural skills.
- **Recommendation:** **continue publishing.** Keep the repo-local `pi-knowledge-card`
  graph layer private (it depends on the Obsidian vault + vault-mind backend);
  publish only the standalone memory core. Maintain the boundary.

### 2.5 `pi-knowledge-card` — Zettelkasten KG (distill / CRUD / graph-RAG)

- **Overlaps:** `context-mode` (FTS5 KB), `gentle-engram`, the new
  `pi-vault-mind` (LanceDB vector+FTS+graph), and indirectly `bigpowers`
  (skill-as-knowledge).
- **Verdict:** **diverges × leads.** Our KG is intentionally *graph-first*
  (wiki-link edges, shared-tag cross-linking, deterministic `zk_ingest`,
  `graph_health` auto-heal) rather than *vector-first*. The vault-mind
  semantic layer is a complementary backend (`obsidian_semantic_search`), not a
  competitor. See [`kg-improvement-plan.md`](./kg-improvement-plan.md) for the
  full mechanism map.
- **Recommendation:** **differentiate.** This is the most differentiated of our
  assets — the atomic-zettel + deterministic-convergence model has no
  community equivalent. Keep private (depends on the local vault + vault-mind);
  the design is the moat.

### 2.6 `pi-obsidian` — project-local vault, 7 tools, 3 commands

- **Overlaps:** `pi-vault-mind`, `gentle-engram` (vault-aware).
- **Verdict:** **aligns × leads.** First-party Obsidian vault integration with
  auto-seeded starter notes, move/rename with backlink rewrite, semantic
  search bridged to vault-mind.
- **Recommendation:** **differentiate / candidate publish.** The Obsidian
  vault substrate is reusable across projects. Medium publish priority — but
  it currently couples to `pi-knowledge-card`. Decouple first, then consider.

### 2.7 `pi-vlm` — PDF/image → Obsidian markdown via local VLM

- **Overlaps:** none directly (closest: `@brushes/schema-to-view` 7.5K, but
  that is screenshot→low-code, not document→markdown).
- **Verdict:** **diverges × unique.** No community package does local-VLM
  document description into a vault.
- **Recommendation:** **defer (niche).** Depends on LM Studio + the vault;
  small but real audience. Low publish priority.

### 2.8 `pi-agent-ext-flux2` / `-ltx` / `-krea2` — Swift/MLX image+video directors

- **Overlaps:** **none.** Zero community packages do on-device ML generation.
- **Verdict:** **diverges × unique.** These wrap sibling Swift/MLX CLIs
  (`swift/flux2-image-director`, `swift/ltx-video-director`,
  `swift/krea2-image-director`) that are not npm-portable.
- **Recommendation:** **defer.** Cannot publish meaningfully without the
  Swift runtime + multi-GB MLX weights. This is our private stack by
  necessity, not choice.

### 2.9 `pi-agent-ext-movie-director` — agent-first video production pipeline

- **Overlaps:** none (closest: `pi-crew` async orchestration, but that is
  generic, not generation-specific).
- **Verdict:** **diverges × unique.** Orchestration layer consuming the
  Swift/MLX directors + ffmpeg/cloud providers.
- **Recommendation:** **defer.** Same Swift-runtime dependency wall as §2.8.

### 2.10 Diagnostics — **the gap**

- **Community:** `pi-lens` (25.2K, real-time LSP/lint), `pi-shazam` (10.9K,
  structural analysis), `pi-readseek` (10.7K), `opencode-codebase-index`
  (8.5K, semantic code search).
- **Ours:** none. We rely on the base agent's `read`/`grep`/`edit` + the
  `no-cd-drift.sh` PreToolUse hook.
- **Verdict:** **intentional out-of-scope.** This repo's product is
  *ML generation*, not a general-purpose coding agent. A first-party LSP/lint
  extension would serve a use-case (editing TS/Bun/Python across `bun-apps/`)
  that is real but secondary to the generation pipeline. The community already
  serves it well.
- **Recommendation:** **defer + document as conscious non-goal.** If the team
  ever wants it, *install* `pi-lens` + `pi-shazam` rather than build — they
  are mature and free. Revisit only if generation-specific structural needs
  emerge (e.g. validating `flux2` tool schemas against the Swift CLI).

---

## 3. Sharing mechanics — how to publish a pi package

> Verified against the official `packages.md`
> (<https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md>)
> and the live catalog (<https://pi.dev/packages>). Accurate as of 2026-07-07.

### 3.1 Package kinds

A pi package bundles one or more of four resource kinds, declared under the
`pi` key in `package.json` (or auto-discovered from conventional directories):

| Kind | Convention dir | Loads | Typical use |
|---|---|---|---|
| **extension** | `extensions/` | `.ts`/`.js` files | Tools, commands, hooks (runs code) |
| **skill** | `skills/` | `SKILL.md` folders + top-level `.md` | Procedural instructions for the model |
| **prompt** | `prompts/` | `.md` files | Prompt templates |
| **theme** | `themes/` | `.json` files | TUI color themes |

### 3.2 Minimal publishable manifest

```jsonc
{
  "name": "@you/your-pkg",
  "version": "0.1.0",
  "keywords": ["pi-package"],          // REQUIRED for gallery discoverability
  "pi": {
    "extensions": ["./extensions"],     // globs + !exclusions supported
    "skills": ["./skills"],
    "prompts": ["./prompts"],
    "themes": ["./themes"],
    "video": "https://example.com/demo.mp4",  // optional gallery preview
    "image": "https://example.com/shot.png"   // optional gallery preview
  }
}
```

### 3.3 Dependencies — the bundling rule

- **Runtime deps** → `dependencies` (npm-installed automatically).
- **pi core packages** (`@earendil-works/pi-ai`, `-pi-agent-core`,
  `-pi-coding-agent`, `-pi-tui`, `typebox`) → `peerDependencies` with `"*`.
  Do **not** bundle them; pi ships them.
- **Other pi packages** → `dependencies` + `bundledDependencies`, referenced
  through `node_modules/` paths (pi loads each package under a separate module
  root, so separate installs don't collide).

### 3.4 Install + discovery flow

```bash
pi install npm:@you/your-pkg          # user settings (~/.pi/agent/settings.json)
pi install npm:@you/your-pkg -l       # project settings (.pi/settings.json, shareable)
pi install git:github.com/you/repo@v1 # pinned ref, SSH/HTTPS both work
pi install ./relative/path            # local, no copy
pi -e npm:@you/your-pkg               # try without installing (temp dir, this run only)
pi list                               # show installed
pi update --all                       # update pi + packages + reconcile git refs
pi config                             # enable/disable individual resources
```

- Tag with `pi-package` → appears in the gallery at `pi.dev/packages`.
- Gallery shows: name, one-line description, downloads/mo, kind, npm + repo +
  **report** links, and the install command.
- Versions are pinned; `pi update --extensions` reconciles git clones to the
  configured ref but does **not** move to newer refs (explicit upgrade only).
- **Security:** packages run with full system access. Review source before
  installing third-party code.

### 3.5 Publishing checklist (what a teammate would actually run)

1. Ensure `package.json` has `keywords: ["pi-package"]` + a `pi` manifest.
2. Move pi-core imports to `peerDependencies` (`"*`); bundle any other pi
   packages you depend on.
3. `npm publish` (standard npm flow — pi reads the published tarball).
4. The gallery picks it up (it indexes npm packages tagged `pi-package`).
5. Verify: `pi -e npm:@you/your-pkg` in a throwaway project.
6. Add a `report` triage path — the gallery links to a
   `package-report.yml` issue template on the pi repo.

### 3.6 Our current publish footprint

- **Published:** `@quintinshaw/pi-dynamic-workflows` (23.6K/mo),
  `pi-hermes-memory` (15K/mo).
- **Private (intentional):** everything in `bun-apps/pi-agent-ext-*` that
  depends on the Swift/MLX runtime or the local vault + vault-mind backend.
- The `@repo/`-prefixed names in `bun-apps/*/package.json` are workspace-
  internal aliases, NOT npm names — they signal "not for publish as-is".

---

## 4. The one real decision — publish `power-tool`, or keep private?

**Context.** PR #326 (`aa07b9d0`) unified `goal` + `todo` + `ask_user_question`
into the first-party `power-tool` extension, retiring the implicit fork of
three community packages (`rpiv-ask-user-question` 35.2K, `rpiv-todo` 29.2K,
`@narumitw/pi-goal` 10.8K). The question is whether to publish `power-tool`
back, or keep it private.

**Trade-off (no objective answer — presented, not decided):**

| Keep private | Publish back |
|---|---|
| `power-tool` couples to `pi-knowledge-card` (`knowledge_query`/`graph_health`); publishing means either decoupling or shipping a dep on an unpublished package. | The novel part — `context_analyzer` + `tools-metrics --schema-cost` — has **no community equivalent** and real demand (context-cost is the #1 bucket). |
| First-party control lets us move fast (the goal/todo overlay is load-bearing for our own self-improve loops). | The commodity parts (goal/todo/ask) duplicate 3 mature community packages — low marginal value, high maintenance surface. |
| No npm maintenance burden; the repo is the source of truth. | Publishing raises the floor for the whole ecosystem and earns goodwill/reciprocity. |

**Recommendation (leaning, not binding):** **keep `power-tool` private; extract
ONLY the `schema-cost`/`context_analyzer` instruments into a small standalone
package if/when they stabilize.** The instruments are the defensible novelty;
the overlay is commodity we need first-party. This is the lowest-regret split:
we keep speed where we need it and publish only where we lead.

---

## 5. Next execution cycle — pick-list

Ranked top 1–2 proposals to actually build next, each with its proof metric.

1. **[P1] Extract `schema-cost` + `context_analyzer` into a publishable standalone package.**
   - *Why:* context-cost is the #1 demand bucket (328K aggregate downloads) and
     we are the only ones *measuring* it. Smallest defensible publish-back.
   - *Proof metric:* `pi -e npm:<pkg>` installs cleanly in a throwaway project
     and `tools-metrics --schema-cost` ranks a foreign extension's tools; gallery
     listing appears within one publish cycle.
   - *Effort:* S–M. *Risk:* low (pure measurement, no behavior change).

2. **[P2] Decide the diagnostics stance formally (install vs build vs ignore).**
   - *Why:* the gap is real (99K aggregate downloads across 6 packages) but the
     use-case is secondary. A formal "install `pi-lens` + `pi-shazam` for
     editing sessions" decision unblocks contributors without spending build
     budget.
   - *Proof metric:* a one-line CONTRIBUTING note + a verified
     `pi install npm:pi-lens` in a dev settings profile that surfaces real LSP
     diagnostics on `bun-apps/*/src`.
   - *Effort:* S. *Risk:* low.

*(Everything else — web-access parity, vault/obsidian decoupling for publish,
the ML-generation extensions — is **defer** by the Swift-runtime/vault coupling,
not a next-cycle action.)*

---

## 6. Methodology + caveats

- **Source:** `pi.dev/packages` "All packages" (1–50 / 4,909), fetched
  2026-07-07. Download figures are npm monthly as displayed; they were not
  independently re-queried.
- **Bucketing is subjective.** Several packages span buckets (`context-mode` is
  both context-cost and memory; `gentle-pi` is both dev-workflow and
  subagents). The primary function is what's listed.
- **Popularity ≠ quality.** A 5K/mo package (e.g. `pi-vault-mind`, new) can
  teach more than a 200K/mo one (`pi-hypa`'s dominance is partly first-mover +
  the universal pain of context cost). Treat downloads as a *demand signal*.
- **"Should we publish?" depends on appetite,** not on an objective quality
  bar. The doc presents the trade-off; the team owns the call.
- **No code changed producing this doc.** Spike + research only.
