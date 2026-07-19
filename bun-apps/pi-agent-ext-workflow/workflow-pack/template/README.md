# REPLACE_ME

A self-contained workflow pack. Edit `manifest.json` + `entry.js` + `agents/`.

Runtime state (`outputs/ intermediate/ runs/`) is gitignored and purgeable via
`workflow pack clean`. Checked-in packs (under `bun-apps/<pkg>/workflows/`)
auto-redirect their state to `.pi/workflows/.state/<packId>/`.
