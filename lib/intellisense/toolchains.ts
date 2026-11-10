/**
 * Toolchain URLs, identical to the ones the glassjar engine downloads for Run
 * (engine `src/worker/mod.rs`). Using the same immutable URLs means the
 * browser's HTTP cache serves them to the language workers for free once the
 * user has run code, and diagnostics come from the exact compiler that builds.
 */
const CDN = 'https://cdn.yousefabuhashem.com';

export const CLANG_WASM_URL = `${CDN}/clang/2026-05-22/llvm.core.wasm`;
export const CLANG_SYSROOT_URL = `${CDN}/clang/2026-05-22/llvm-resources.tar.gz`;
export const RUSTC_WASM_URL = `${CDN}/rust/2026-05-31/rustc.wasm`;
export const RUST_SYSROOT_URL = `${CDN}/rust/2026-05-31/rust-sysroot.tar.gz`;

/** The edition Run compiles Rust with (engine `start_rust`, `--edition`). */
export const RUST_EDITION = 2024;

/**
 * rust-analyzer built for wasm from tools/ra-wasm (ra_ap 0.0.358, std from Rust 1.99).
 * Versioned path on the CDN, never overwritten. For a local build, run
 * tools/ra-wasm/build.sh and set NEXT_PUBLIC_RUST_ANALYZER_BASE=/intellisense/ra
 * (scripts/copy-intellisense.mjs copies dist/ there).
 */
export const RUST_ANALYZER_BASE =
  process.env.NEXT_PUBLIC_RUST_ANALYZER_BASE || `${CDN}/rust-analyzer/2026-11-09-ra0.0.358-v2`;
