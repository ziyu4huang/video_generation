# 04 — Dev-worktree disconnected-vault footgun

## Question

The vault submodule is uninitialized in dev worktrees (`git submodule status`
shows `-`) → `zk_ingest` / `convergeHermesMemory` silently write cards to a
disconnected LOCAL vault that the primary worktree never sees. **How do we make
a wrong-vault write IMPOSSIBLE (loud), not just possible-to-notice-later?**

### Candidates

- **(a) Refuse to write.** `resolveVault` errors loudly when the submodule is
  uninitialized, pointing at `git submodule update --init` (or the env var to
  override). No silent write ever happens.
- **(b) Auto-init.** First write auto-runs `git submodule update --init` so the
  shared vault is always present.
- **(c) Redirect.** Dev worktrees resolve to the PRIMARY worktree's vault via a
  shared absolute path (env or worktree-discovery), so all worktrees converge
  into one vault.

### Decide

- Which fix, and does the check live in `resolveVault` (shared by all
  convergence entry points) or only at the convergence entry points?
- Does (a)'s loud error break the shutdown auto-converge hook (which today
  silently tolerates a missing vault)? Reconcile with T03's failure semantics.
- Is "converge into the primary worktree's vault from a dev worktree" ever
  desirable, or always a footgun to refuse?

type: grilling
claimed: wayfinder-session
blocked by: —
status: closed

## Resolution (closed this session)

**Refuse + detect (loud), via `resolveVault` write-path strictness.**

`resolveVault` (the shared chokepoint at
`pi-agent-ext-obsidian/src/obsidian-lib.ts:268`, used by ALL convergence callers
— zk_ingest, the shutdown hook, host-fns) gains a **write-strictness mode**.
When a write-path caller resolves to a **Tier-3 auto-created `./vault`** OR an
**empty/uninitialized submodule** (`vaults_root/pi-agent-vault` checked out
empty / `git submodule status` shows `-`), it does NOT write:
- **Explicit callers** (zk_ingest tool, CLI) → ERROR loud, pointing at
  `git submodule update --init vaults_root/pi-agent-vault` or setting
  `OB_VAULT_PATH`.
- **The shutdown auto-converge hook** → records the wrong-vault condition in
  the T03 receipt (`.pi/kcard-last-receipt.json` as `{wrongVault, reason, ts}`)
  and skips the write (never blocks shutdown).

`OB_VAULT_PATH` stays as the **opt-in redirect** for shared-vault-from-worktree
(point it at the primary worktree's absolute vault path).

**Rejected:** auto-init (convergence shouldn't mutate git state; per-worktree
submodule checkouts diverge so there's no shared vault; fails on no-network);
redirect-to-primary (cross-worktree write races; fragile worktree-discovery —
primary path varies per machine).

**Build includes (implementation):**
- `resolveVault` distinguishes read vs write resolution — a `writable`/`forWrite`
  option (or a separate `resolveWritableVault`) so Tier-3 auto-create stays
  available for benign reads but is REFUSED for writes.
- Uninitialized-submodule detection: `vaults_root/pi-agent-vault` exists but is
  empty (no checked-out content) → treated as uninitialized.
- The shutdown hook's wrong-vault skip feeds the T03 receipt.

**No new tickets; no fog graduation; no out-of-scope change.**
