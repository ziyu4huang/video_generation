---
type: grilling
status: closed
claimed: explorer-webui
blocked by: 01
---
## Question

Pin the **image-renderer + artifact-serving contract** for v1:

- **Artifact dir + route**: new `<runtime>/artifacts/<id>.<ext>` served at `GET /artifacts/<id>.<ext>` (Bun `serveFile`, loopback `originAllowed`-guarded) vs reusing the MLX output dir directly. Decide location + route + how the agent/tool emits artifacts there.
- **Image-path flow today (fact — find it)**: how do the MLX image-gen tools' `tool_result` `details` carry the output file path? (read `python/mlx-movie-director/run.py` image subcommands + `tool-mirror.ts` image handling). Which key?
- **Path → URL mapping**: how the renderer turns a tool_result image path into `/artifacts/<id>.<ext>` (copy / symlink / serve-in-place?).
- **Renderer output**: `md` view (`![img](/artifacts/...)`) or `html` view (`<img src>`)? (html sandboxed iframe is fine for a plain `<img>` — no scripts needed.)
- **Scope**: which image-gen tools to recognize first (t2i? all `image *` subcommands?).

**Decided upstream (don't re-litigate)**: static-dir + URL (not data-URI); loopback origin-guard is the boundary. This ticket pins the specifics.

Resolve via `grilling` + `domain-modeling` + code-read of MLX image tools + tool-mirror.

## Resolution

**Closed** (work-through-the-map; fact-find + grilling). Contract pinned:

1. **Serving — PORT the GUI handler** (not new dir, not shared lib): copy+adapt `gui-movie-director`'s `handleGalleryImage` into the webui via the existing `setHttpRoutes` seam (`web-server.ts:199`), serving `MLX_OUTPUT_DIR` at `/output/{name}` (single dir for v1; `/output/0/{name}` if GUI-dirIdx-compat desired — impl choice). Keep the GUI's hardening: MIME allowlist (png/jpg/jpeg/webp/gif + mp4), `X-Content-Type-Options: nosniff`, path-traversal containment, ETag, Range. Resolve `MLX_OUTPUT_DIR` as run.py/GUI do (env `MLX_OUTPUT_DIR` → default `../video_generation__output`).
2. **Image-path key**: `details.output` (single absolute path) + `details.outputs[].path` (list) — pinned in `Flux2Details`/`LtxDetails`. Scope: **flux2 + ltx** (both use `output`).
3. **Path → URL**: `basename(details.output)` → `/output/0/{basename}` (path is under MLX_OUTPUT_DIR). For `outputs[]`, each `.path` → its own image.
4. **Renderer — EXTEND tool-mirror, inline in "Tools"**: add a dedicated branch in `formatToolResult` (before the generic `else`) detecting image-bearing details (`details.output` ending in image ext, or `outputs[].path`) → emit md `![image](/output/0/{basename})` per image. **Also fixes the `outputs[]` → `[object Object]` bug** (objects not stringified today).
5. **View**: **md** (markdown image → `<img>` via `marked`). NOT html view. Images render inline in the existing "tools" view.
6. **Loopback/auth**: unchanged — the `/output/` route is guarded by the existing `originAllowed` loopback check (same as all webui routes). No token (loopback = trusted).

**Note**: the ported handler's MIME allowlist includes `.mp4`, so **video SERVING is covered** when video-rendering graduates from fog (only the `<video>` player view would be new).

**Fact-find evidence**: `pi-agent-ext-flux2/src/result.ts:33-58,108-200`; `pi-agent-ext-ltx/src/result.ts:29-47`; `tool-mirror.ts:67-105,157-159` (bug at 84-87); `config.py:161-191`; `gui-movie-director/api/gallery.ts` (handleGalleryImage, GALLERY_MIME); webui seam `web-server.ts:199-204,258-261`.
