# dsh-sv-analyzer

A **self-contained DeepSeek Harness (DSH) plugin** that analyzes
Verilog / SystemVerilog source with [tree-sitter](https://tree-sitter.github.io/)
compiled from **Rust to WASM** (`wasm32-wasip1`).

- **Two grammars, one binary**: [tree-sitter-systemverilog](https://github.com/gmlarumbe/tree-sitter-systemverilog)
  (IEEE 1800-2023) with automatic fallback to [tree-sitter-verilog](https://github.com/tree-sitter/tree-sitter-verilog)
  for legacy code (`dialect: auto`).
- **Zero runtime dependencies**: the plugin ships the `.wasm` inside the npm
  package and runs it with Node's built-in [WASI](https://nodejs.org/api/wasi.html)
  (`node:wasi`). No native binaries, no wasmtime, no install-time build.
- **One fully-linked module**: the tree-sitter C library and both grammar
  parsers are linked *into* the Rust wasm (no `env` imports, no separate
  provider module). 40 MB unpacked, **1.6 MB in the tarball**.
- **Two model tools**:
  - `sv_analyze` — design summary: modules/interfaces/programs/packages,
    ports (direction/type/width), parameters, module instances, signal
    declarations, always blocks (kind + sensitivity), continuous assigns, and
    syntax issues with positions.
  - `sv_ast` — the raw tree-sitter parse tree as JSON.

## Layout

```
dsh-sv-analyzer/
├── build.sh              # batch CLI: rust → wasm → tests → tarball
├── rust/                 # Rust crate (lib + wasm ABI entry + native CLI)
│   ├── src/lib.rs        # analysis core (dialects, extraction, AST dump)
│   ├── src/main.rs       # wasm32-wasip1 ABI exports (alloc/run/response_len/...)
│   ├── src/bin/cli.rs    # native debug CLI (dsh-sv-cli)
│   └── .cargo/config.toml# wasm-only link args (single self-contained module)
├── plugin/               # the DSH plugin package (bundle form)
│   ├── index.js          # registers sv_analyze / sv_ast on ctx.tools
│   ├── lib/wasm-runner.js# node:wasi loader + JSON-over-linear-memory ABI
│   ├── cordis.patch.yml  # bundle layer: activates the plugin row
│   └── wasm/sv-analyzer.wasm  # build output, ships inside the tarball
├── examples/counter.sv   # self-test fixture
└── test/                 # wasm.mjs (end-to-end) + plugin-smoke.mjs (wiring)
```

## Requirements

- Rust toolchain with `rustup` (adds `wasm32-wasip1` automatically)
- Node.js ≥ 22 (for `node:wasi`; tested on 26)
- `npm` (for packing) — `pnpm` only if you use `--install`
- First build vendors the [zig](https://ziglang.org) toolchain (~90 MB) into
  `toolchain/`: Apple's clang has no WebAssembly backend, while zig's bundled
  clang compiles the grammars' C parsers for `wasm32-wasip1` with its own
  wasi-libc (a small `zig-cc-wasi.sh` wrapper translates the target triple).

## Build (the batch CLI)

```bash
./build.sh                          # full: native tests → wasm → tests → tarball
./build.sh --no-tests               # skip wasm + plugin smoke tests
./build.sh --check-patch            # validate the bundle patch against `dsh --dump-config`
./build.sh --install web            # also install the tarball into dsh profile `web`
```

Pipeline (all idempotent):

1. `cargo test --lib` + native CLI self-test on `examples/counter.sv`
2. `rustup target add wasm32-wasip1` + `cargo build --release --target wasm32-wasip1`
3. copy `plugin/wasm/sv-analyzer.wasm`
4. `node test/wasm.mjs` — drives the wasm through `node:wasi`, asserts extraction
5. `node test/plugin-smoke.mjs` — registers the tools through a ctx stub and runs them
6. `npm pack` → `dist/dsh-sv-analyzer-<version>.tgz` (fully self-contained)

## Install into DSH

The package is a dsh **bundle** (its `package.json` declares `dsh.bundle`), so
installing it auto-activates the layer:

```bash
# from the tarball (no build permissions needed — the wasm ships prebuilt)
dsh plugin --profile web add ./dist/dsh-sv-analyzer-0.1.0.tgz

# or from the local checkout
dsh plugin --profile web add ./plugin
```

Then restart the profile's dsh process (bundle layers compose at boot):

```bash
dsh --profile web --dump-config   # confirm a "# == dsh-sv-analyzer" layer
```

The tools `sv_analyze` / `sv_ast` become available to every agent in that
profile. To remove:

```bash
dsh plugin --profile web remove dsh-sv-analyzer
```

## Using the tools

```
sv_analyze { code?: string, file?: string, dialect?: auto|systemverilog|verilog, include_ast?: boolean }
sv_ast     { code?: string, file?: string, dialect?: auto|systemverilog|verilog }
```

- Pass source inline via `code`, or a workspace-relative path via `file`
  (read through the harness `fs` service, so the sandbox still applies).
- `dialect: auto` (default) parses with SystemVerilog and falls back to the
  classic Verilog grammar when the parse has errors; the result reports which
  dialect was used.
- `sv_analyze` result shape:

```jsonc
{
  "dialect": "systemverilog",
  "parse_ok": true,
  "error_count": 0,
  "issues": [ /* { kind: "error"|"missing", node_type, start:{row,column}, end, snippet } */ ],
  "design_units": [
    {
      "kind": "module", "name": "counter", "start_line": 3,
      "parameters":   [{ "name": "WIDTH", "default": "8" }],
      "ports":        [{ "name": "clk", "direction": "input", "port_type": "wire", "width": "" }],
      "instances":    [{ "module": "reg_sync", "name": "sync_inst", "start_line": 31 }],
      "signals":      [{ "name": "next_count", "kind": "logic", "width": "[WIDTH-1:0]" }],
      "always_blocks":[{ "kind": "always_ff", "trigger": "@(posedge clk or negedge rst_n)", "start_line": 15 }],
      "continuous_assigns": [{ "lhs": "next_count", "rhs": "count + 1'b1", "start_line": 24 }]
    }
  ],
  "stats": { "modules": 2, "ports": 9, "instances": 1, "signals": 2, "always_blocks": 2, /* ... */ },
  "ast": null  // present when include_ast: true
}
```

## How the WASM is built and called

`rust/src/main.rs` exports a tiny allocator + dispatch ABI over linear memory —
`alloc` / `run` / `response_len` / `free_response` / `dealloc` — and
`plugin/lib/wasm-runner.js` marshals JSON across it with a persistent WASI
instance. No stdin/stdout plumbing, no temp files, no spawned processes.

The one non-obvious build step: the `tree-sitter` and grammar crates compile
their C code with `cc`, but cargo does not forward their `rustc-link-lib`
directives on the `wasm32-wasip1` target, so rust-lld would leave the C API
undefined (turning into `env` imports via `--allow-undefined`).
`rust/.cargo/config.toml` links the archives explicitly by filename, and the
build script points cc's `AR`/`RANLIB` at zig's (Apple's `ranlib` cannot index
wasm objects). Result: a single self-contained module with zero `env` imports.

## Developing

- Edit the analyzer → `cargo test` (native, fast) → `./build.sh`.
- Debug a single file: `./rust/target/release/dsh-sv-cli <file> --ast`.
- Both grammars are pure `parser.c` (no external scanners), so the wasm
  cross-compile needs no extra C toolchain beyond the vendored zig clang.

## License

MIT
