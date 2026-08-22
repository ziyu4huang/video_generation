# s2-agent-ext-sv-analyzer

Verilog / SystemVerilog analyzer for **s2-agent** — the same two model tools as
the `dsh-sv-analyzer` DeepSeek Harness plugin, backed by the **same**
self-contained tree-sitter WASM (`wasm32-wasip1`):

- `sv_analyze` — design summary: modules/interfaces/programs/packages, ports
  (direction/type/width), parameters, module instances, signal declarations,
  always blocks (kind + sensitivity), continuous assigns, and syntax issues
  with positions.
- `sv_ast` — the raw tree-sitter parse tree as JSON.

## How it relates to dsh-plugin/sv-analyzer

The Rust core lives ONCE at `dsh-plugin/sv-analyzer/rust/` (two grammars, one
fully-linked wasm binary, zero `env` imports). Both hosts consume the same
build output:

| Host | Runtime | Ships |
|---|---|---|
| DSH | `dsh-plugin/sv-analyzer/plugin/` | `plugin/wasm/sv-analyzer.wasm` inside the npm tarball |
| s2-agent | this package | `wasm/sv-analyzer.wasm` (gitignored, mirrored by `dsh-plugin/sv-analyzer/build.sh`) |

`dsh-plugin/sv-analyzer/build.sh` mirrors the freshly built wasm into
`wasm/sv-analyzer.wasm` here (a regenerated artifact, gitignored — same policy
as the plugin's own `plugin/wasm/`), so a fresh clone runs `build.sh` first to
mirror it before deploy/test. If you edit the Rust core, rebuild + re-mirror
locally: this package's tests drive the wasm when present and skip when absent
(they fail on a stale module, so keep the mirror in sync).

## Running

- Source mode: the extension is in the registry base set (`load: static`), so
  `./s2-agent.sh` picks it up automatically after `bun run regen:manifest` +
  `regen:static`.
- Deployed (`s2-agent-ext-devops` deploy): the registry's `copy: [wasm]` ships
  the wasm beside the bundle; the loader's `#pi/ext-dir` serve locates it at
  runtime (no build-machine paths — the relocatability gate stays green).

## Tools

```
sv_analyze { code?: string, file?: string, dialect?: auto|systemverilog|verilog, include_ast?: boolean }
sv_ast     { code?: string, file?: string, dialect?: auto|systemverilog|verilog }
```

- Pass source inline via `code`, or a `.v` / `.sv` / `.vh` / `.svh` file path
  via `file` (resolved against the session cwd; extension + size checked before
  buffering; total input capped at 1 MiB).
- `dialect: auto` (default) parses with SystemVerilog; on errors it falls back
  to the classic Verilog grammar and keeps the cleaner parse.
- Runs inline (a CLI agent's tool call blocking for a bounded parse is normal —
  the DSH plugin runs the same wasm on a worker thread because its host is a
  long-lived server). Every tree walk is depth-capped in the Rust core; the
  model-facing render is capped at 256 KiB with an explicit truncation notice.

## Disable

`BUN_PI_SV_ANALYZER=0` disables the whole extension (registers nothing) —
the symmetric knob every portable base-set extension honors.

## License

MIT
