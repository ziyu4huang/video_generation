# Vendor Dependencies

Vendored MLX implementations for image and video generation, tracked as
snapshots within this repository.

## Overview

| Metric | Value |
|---|---|
| Total files | 1,333 |
| Total disk size | 80 MB |
| Python files | 1,114 |
| Real code LOC (non-blank, non-comment) | 117,444 |
| Source LOC (excl. tests) | 93,734 |

## Projects

| Project | Description | Files | Disk | .py | Real LOC | src | test |
|---|---|---|---|---|---|---|---|
| `mflux/` | Flux image generation on MLX | 920 | 61 MB | 678 | 41,984 | 36,181 | 5,803 |
| `ltx-2-mlx/` | LTX-2 video model (upstream) | 212 | 7.0 MB | 178 | 26,691 | 19,077 | 7,614 |
| `ltx-2-mlx-dgrauet/` | LTX-2 video model (dgrauet fork) | 212 | 7.0 MB | 178 | 26,691 | 19,077 | 7,614 |
| `ltx-2-mlx-acelogic/` | LTX-2 video model (acelogic fork) | 109 | 5.2 MB | 80 | 22,078 | 19,399 | 2,679 |

## File Types

| Extension | Count | Note |
|---|---|---|
| `.py` | 1,114 | Source + tests |
| `.md` | 59 | Documentation |
| `.png` / `.jpg` / `.jpeg` | 85 | Test assets & examples |
| `.toml` | 13 | Build configs |
| `.json` | 10 | Configs & fixtures |
| `.yaml` / `.yml` | 13 | CI & configs |
| Other | 39 | mp4, txt, lock, pdf, etc. |

---

_Metrics measured 2025-06-08. Rerun with `find vendor/ -name '*.py' -exec grep -cvE '^\s*(#|$)' {} + | awk -F: '{sum+=$2} END{print sum}'` to refresh._
