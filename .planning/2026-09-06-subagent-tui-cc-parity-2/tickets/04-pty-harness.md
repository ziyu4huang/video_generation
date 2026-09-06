# 04 — Bun.Terminal TUI drive harness (self-evolve vehicle)

## Done when
- `bun-apps/s2-agent-ext-subagent/scripts/tui-drive.ts` runs the real
  `./s2-agent.sh` TUI through `Bun.spawn(..., { terminal })`, decodes the
  screen with xterm-headless (64-byte awaited chunks — large writes stall in
  Bun), answers primary DA, stays silent on kitty ?u, forces
  TERM=xterm-256color, injects ZAI_API_KEY from ~/.zshrc when absent.
- Scenario `dispatch`: submits a spawn_subagent prompt, captures snapshots on
  screen-change, presses ctrl+o mid-run, waits for settle, opens /subagents.
- Emits receipt.json: model line from the status bar (silent lm-studio
  fallback visible), per-check booleans (live row / expanded trace / hint /
  settled badge / viewer), snapshot dir. Exit 0 only when checks pass.
- Allowlisted in s2-agent-ext-devops tests/scripts-dir-contract.test.ts;
  xterm-headless added as a devDep of s2-agent-ext-subagent.
