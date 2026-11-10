#!/usr/bin/env bash
# Builds the rust-analyzer wasm module and the std sources bundle.
#
# Outputs (in tools/ra-wasm/dist/):
#   ra_wasm.js, ra_wasm.d.ts, ra_wasm_bg.wasm   wasm-bindgen `--target web` module
#   rust-std.bin.gz               core/alloc/std sources for RustAnalyzer.load_std
#
# Env:
#   CARGO_TARGET_DIR   reuse an existing target dir (the ra_ap_* build is slow)
#   SKIP_WASM=1        only rebuild the std bundle
#   SKIP_STD=1         only rebuild the wasm module
set -euo pipefail

cd "$(dirname "$0")"
HERE="$(pwd)"
DIST="$HERE/dist"
mkdir -p "$DIST"

if [[ "${SKIP_WASM:-0}" != "1" ]]; then
  rustup target add wasm32-unknown-unknown >/dev/null
  # wasm-pack runs wasm-bindgen and then wasm-opt with the flags from
  # [package.metadata.wasm-pack.profile.release] in Cargo.toml.
  wasm-pack build --release --target web --no-pack --out-dir pkg --out-name ra_wasm
  cp pkg/ra_wasm.js pkg/ra_wasm.d.ts pkg/ra_wasm_bg.wasm "$DIST/"
fi

if [[ "${SKIP_STD:-0}" != "1" ]]; then
  SYSROOT="$(rustc --print sysroot)"
  LIB="$SYSROOT/lib/rustlib/src/rust/library"
  if [[ ! -d "$LIB/core" ]]; then
    rustup component add rust-src
  fi
  node "$HERE/pack-std.mjs" "$LIB" "$DIST/rust-std.bin.gz"
fi

ls -l "$DIST"
