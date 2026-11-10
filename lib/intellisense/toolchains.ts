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

/** rust-analyzer built for wasm from tools/ra-wasm (served from the IDE's origin by default). */
export const RUST_ANALYZER_BASE =
  process.env.NEXT_PUBLIC_RUST_ANALYZER_BASE ?? '/intellisense/ra';
