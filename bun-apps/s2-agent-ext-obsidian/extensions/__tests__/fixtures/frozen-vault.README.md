# Frozen contract vault (DO NOT EDIT NOTE CONTENT)

This is a **content-controlled fixture vault** for `baseline-contract.test.mjs`.
It exists so the search backward-compatibility contract can be asserted
**byte-for-byte** without depending on the `vaults_root/s2-agent-vault` submodule
(which is not initialized in CI / on fresh clone).

## The rule

The vault lives at `fixtures/frozen-vault/` (this doc is a sibling, kept out of
the vault dir so doc edits can't drift the snapshot). **Never edit the note
content under `frozen-vault/`.** Any content change breaks the committed
`frozen-baseline.txt` snapshot. If you genuinely need to change the fixture,
edit the notes AND regenerate in the same commit:

```
bun run --cwd bun-apps/pi-obsidian regen:contract
```

Adding a *new* note file also drifts the snapshot (file traversal order /
counts) — regenerate in the same commit.

## Why separate from the real vault

The real submodule vault legitimately grows (notes are added), which would
false-alarm a byte snapshot. This frozen vault decouples the *search impl
contract* (must never change) from *real-vault content* (drifts by design).
