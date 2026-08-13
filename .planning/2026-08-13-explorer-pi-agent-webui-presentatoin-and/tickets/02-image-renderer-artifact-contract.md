---
type: grilling
status: open
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
