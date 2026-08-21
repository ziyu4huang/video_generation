#!/usr/bin/env bash
#
# dsh-sv-analyzer — batch CLI build.
#
# Builds the Rust → WASM analyzer and assembles a self-contained DSH plugin
# tarball (the .wasm ships inside the npm package, zero runtime deps).
#
# Pipeline (all idempotent):
#   1. native unit tests (cargo test --lib) + native CLI self-test
#   2. rustup target add wasm32-wasip1 + cargo build --release
#      (single self-contained module: tree-sitter C lib + both grammars are
#      linked in via rust/.cargo/config.toml; zero `env` imports remain)
#   3. WASM tests through Node's built-in WASI (node:wasi)
#   4. plugin smoke tests (tool registration + execution)
#   5. npm pack -> dist/dsh-sv-analyzer-<version>.tgz (fully self-contained)
#
# Optional:
#   ./build.sh --install <profile>   also install the tarball into a dsh
#                                    profile (needs pnpm + dsh on PATH);
#                                    bundle auto-joins the layer stack.
#   ./build.sh --check-patch         validate the bundle patch layer against
#                                    a dsh profile dump (needs dsh on PATH).
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUST_DIR="$ROOT/rust"
PLUGIN_DIR="$ROOT/plugin"
WASM_OUT="$PLUGIN_DIR/wasm/sv-analyzer.wasm"
DIST_DIR="$ROOT/dist"
TOOLCHAIN_DIR="$ROOT/toolchain"
CC_WRAPPER="$TOOLCHAIN_DIR/zig-cc-wasi.sh"
TARGET="wasm32-wasip1"
VERSION="$(node -p "require('$PLUGIN_DIR/package.json').version")"

say()  { printf '\033[1;34m[build]\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m[build]\033[0m ERROR: %s\n' "$*" >&2; exit 1; }

# The grammar crates compile a plain C parser with cc/clang. Apple's clang
# has no WebAssembly backend, so we vendor the zig toolchain (bundled clang
# with all targets + wasi-libc) into toolchain/ and point cc at a small
# wrapper that translates cc's wasm32-wasip1 triple to zig's wasm32-wasi.
ensure_zig() {
  if [[ -x "$CC_WRAPPER" ]]; then
    return
  fi
  say "downloading zig toolchain for the C parser cross-build"
  local ver="0.15.2"
  local url="https://ziglang.org/download/$ver/zig-aarch64-macos-$ver.tar.xz"
  local tarball="$(mktemp -t zig.XXXXXX).tar.xz"
  curl -sL -o "$tarball" "$url" || fail "download failed: $url"
  mkdir -p "$TOOLCHAIN_DIR"
  tar -xJf "$tarball" -C "$TOOLCHAIN_DIR"
  rm -f "$tarball"
  local zig="$(echo "$TOOLCHAIN_DIR"/zig-aarch64-macos-*/zig)"
  "$zig" version >/dev/null || fail "zig toolchain broken at $zig"
  # cc-rs passes --target=wasm32-wasip1; zig spells it wasm32-wasi.
  cat > "$CC_WRAPPER" <<EOF
#!/usr/bin/env bash
ZIG="$zig"
args=()
for a in "\$@"; do
  case "\$a" in
    --target=wasm32-wasip1) args+=("--target=wasm32-wasi") ;;
    *) args+=("\$a") ;;
  esac
done
exec "\$ZIG" cc "\${args[@]}"
EOF
  chmod +x "$CC_WRAPPER"
  say "   $(du -sh "$TOOLCHAIN_DIR"/zig-aarch64-macos-* | cut -f1)  zig toolchain"
}

usage() {
  cat <<'EOF'
Usage: ./build.sh [--install <profile>] [--check-patch [profile]] [--no-tests]

  (default)        full build: native tests, wasm build, wasm + plugin tests, pack
  --install <p>    after packing, install the tarball into dsh profile <p>
                   (requires pnpm on PATH; the bundle auto-joins the profile)
  --check-patch    validate plugin/cordis.patch.yml as a dsh patch overlay
                   (requires dsh on PATH; uses --dump-config, does not boot)
  --no-tests       skip the wasm + plugin smoke tests (native tests always run)
EOF
}

step_native_tests() {
  say "1/6 native unit tests + CLI self-test"
  cargo test --manifest-path "$RUST_DIR/Cargo.toml" --lib
  cargo build --release --manifest-path "$RUST_DIR/Cargo.toml" --bin dsh-sv-cli
  "$RUST_DIR/target/release/dsh-sv-cli" "$ROOT/examples/counter.sv" >/dev/null
  say "   native CLI self-test on examples/counter.sv: ok"
}

step_wasm_build() {
  say "2/6 building wasm ($TARGET)"
  ensure_zig
  rustup target add "$TARGET"
  local zig="$(echo "$TOOLCHAIN_DIR"/zig-aarch64-macos-*/zig)"
  # - cc-rs reads CC_<target>; the hyphenated spelling needs `env` (not export).
  # - Apple's ar/ranlib cannot index wasm objects (archive members would be
  #   invisible to rust-lld), so the C archives must be built with zig's.
  # - rust/.cargo/config.toml adds `-l:libtree-sitter*.a` so the C API links
  #   into the module instead of becoming `env` imports.
  env "CC_wasm32-wasip1=$CC_WRAPPER" "CC_wasm32_wasip1=$CC_WRAPPER" \
    AR="$zig ar" RANLIB="$zig ranlib" \
    cargo build --release --manifest-path "$RUST_DIR/Cargo.toml" --target "$TARGET" --bin dsh-sv-wasm
  mkdir -p "$(dirname "$WASM_OUT")"
  cp "$RUST_DIR/target/$TARGET/release/dsh-sv-wasm.wasm" "$WASM_OUT"
  say "   $(du -h "$WASM_OUT" | cut -f1)  $WASM_OUT (gzip: $(gzip -c "$WASM_OUT" | wc -c | awk '{printf "%.1f MB", $1/1048576}'))"
}

step_wasm_tests() {
  say "3/6 wasm tests (node:wasi)"
  node "$ROOT/test/wasm.mjs"
}

step_plugin_tests() {
  say "4/6 plugin smoke tests"
  node "$ROOT/test/plugin-smoke.mjs"
}

step_pack() {
  say "5/6 packing self-contained plugin tarball"
  mkdir -p "$DIST_DIR"
  rm -f "$DIST_DIR"/dsh-sv-analyzer-*.tgz
  # A scratch npm cache keeps packing hermetic: a user-level cache with
  # root-owned files (a known old-npm artifact) must not break the build.
  local scratch_cache
  scratch_cache="$(mktemp -d)"
  (cd "$PLUGIN_DIR" && npm pack --cache "$scratch_cache" --pack-destination "$DIST_DIR" >/dev/null)
  rm -rf "$scratch_cache"
  say "   $(ls "$DIST_DIR")"
}

step_check_patch() {
  local profile="$1"
  say "6/6 validating bundle patch layer against dsh profile '$profile'"
  command -v dsh >/dev/null || fail "--check-patch needs the dsh CLI on PATH"
  dsh --profile "$profile" --dump-config --patch "$PLUGIN_DIR/cordis.patch.yml" >/dev/null \
    && say "   patch layer composes cleanly" \
    || fail "patch layer failed to compose (see output above)"
}

step_install() {
  local profile="$1"
  command -v dsh >/dev/null || fail "--install needs the dsh CLI on PATH"
  command -v pnpm >/dev/null || fail "--install needs pnpm on PATH (npm install -g pnpm)"
  say "installing into dsh profile '$profile'"
  dsh plugin --profile "$profile" add "$DIST_DIR"/dsh-sv-analyzer-*.tgz
  say "installed. Restart the profile's dsh process for the Node half to load."
}

INSTALL_PROFILE=""
CHECK_PATCH=0
CHECK_PATCH_PROFILE="web"
RUN_TESTS=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --install) INSTALL_PROFILE="${2:?--install needs a profile name}"; shift 2 ;;
    --check-patch)
      CHECK_PATCH=1; shift
      if [[ $# -gt 0 && ! "$1" =~ ^- ]]; then CHECK_PATCH_PROFILE="$1"; shift; fi ;;
    --no-tests) RUN_TESTS=0; shift ;;
    -h|--help) usage; exit 0 ;;
    *) fail "unknown argument: $1 (see --help)" ;;
  esac
done

command -v cargo >/dev/null || fail "cargo not found on PATH"
command -v node >/dev/null || fail "node not found on PATH"

step_native_tests
step_wasm_build
if [[ "$RUN_TESTS" == "1" ]]; then
  step_wasm_tests
  step_plugin_tests
fi
step_pack

if [[ "$CHECK_PATCH" == "1" ]]; then
  step_check_patch "$CHECK_PATCH_PROFILE"
fi
if [[ -n "$INSTALL_PROFILE" ]]; then
  step_install "$INSTALL_PROFILE"
fi

say "done: $DIST_DIR/dsh-sv-analyzer-$VERSION.tgz"
