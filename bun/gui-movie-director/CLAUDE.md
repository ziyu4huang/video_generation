# Bun GUI Movie Director — Development Guide

## Start the server

**Always use dev mode** for development — it provides hot reload for both backend and frontend:

```bash
bun run dev
```

This runs `bun run --watch server.ts`, which:
1. **Backend hot reload**: `--watch` auto-restarts the server when `*.ts` files change
2. **Frontend HMR**: File watcher on `frontend/` rebuilds the bundle on `.tsx`/`.ts`/`.css` changes, then broadcasts `hmr-reload` via WebSocket to auto-refresh the browser

**Never use `bun run start`** during development — it has no file watching.

If port 3099 is occupied: `lsof -ti :3099 | xargs kill`

## Project structure

```
server.ts              # Entry point — build bundle → start server → start file watcher
api/routes.ts          # HTTP routing + bundle build/rebuild
api/ws.ts              # WebSocket (job logs, HMR reload broadcast)
api/jobs.ts            # Job CRUD + run
api/model-check.ts     # Model inventory scan + cache
api/config.ts          # Server config read/write
api/vlm.ts             # VLM test endpoint
lib/config.ts          # Config loader (config.json)
lib/paths.ts           # Resolved paths (PYTHON_BIN, RUN_PY, FRONTEND_DIR, etc.)
lib/subprocess.ts      # Job execution engine
lib/jobstore.ts        # Job persistence
frontend/
  app.tsx              # React SPA entry — COMMAND_GROUPS + VIEW_MAP
  styles.css           # Global dark theme CSS
  index.html           # HTML shell + HMR client script
  views/               # View components organized by group
  components/          # Shared UI components (Layout, CommandForm, etc.)
  hooks/               # React hooks (useWebSocket, useJobs, useCommandView)
  context/             # React context providers
  schemas/             # Form validation schemas
  types.ts             # Shared TypeScript types
```

## Adding a new view

1. Create `frontend/views/<group>/FooView.tsx`
2. In `frontend/app.tsx`:
   - Add import
   - Add entry to the appropriate `COMMAND_GROUPS` group: `{ id: "foo", label: "Foo", icon: "🔧" }`
   - Add to `VIEW_MAP`: `foo: FooView`
3. If the view needs an API endpoint, add handler in `api/` and register route in `api/routes.ts`

## CSS conventions

- Dark theme using CSS custom properties (`--bg-surface`, `--accent`, etc.)
- Class naming: lowercase-hyphen (`.mc-badge`, `.cmd-form`, `.job-card`)
- All styles in `frontend/styles.css` (no CSS modules)

## Python subprocess calls

The server calls `python/mlx-movie-director/run.py` via `Bun.spawnSync` for:
- Model check (`check-model --json`)
- Job execution (image generation commands)

Python path resolution: `config.pythonPath` → fallback `ComfyUI/.venv/bin/python`.

Note: `check-model` uses mlx which is NOT in ComfyUI's venv. The correct Python for mlx-movie-director is the system Python 3.13 with mlx installed. The config UI lets users set this path.
