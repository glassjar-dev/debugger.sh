#!/usr/bin/env node
// Packs the rust-src sources rust-analyzer needs for `core`, `alloc` and `std`
// into one gzipped bundle that `RustAnalyzer.load_std` reads (after gunzip).
//
// Usage: node pack-std.mjs <rust-src library dir> <out.bin.gz>
//
// Format (little endian):
//   "RSTD" u32:version(1) u32:count
//   count * { u32:path_len path_utf8 u32:text_len text_utf8 }
// Paths are relative to `library/`, e.g. `core/src/lib.rs`.

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const [libDir, outFile] = process.argv.slice(2);
if (!libDir || !outFile) {
  console.error("usage: node pack-std.mjs <library dir> <out.bin.gz>");
  process.exit(2);
}

// Directory trees to include, relative to library/.
const ROOTS = [
  "core/src",
  "alloc/src",
  "std/src",
  // core::arch is `#[path]`-included from stdarch; only the wasm32 part is
  // reachable with our wasm32 cfgs (the rest is ~20 MB of x86/arm intrinsics).
  "stdarch/crates/core_arch/src/wasm32",
];
const EXTRA_FILES = [
  "stdarch/crates/core_arch/src/mod.rs",
  "stdarch/crates/core_arch/src/macros.rs",
  "stdarch/crates/core_arch/src/simd.rs",
  "stdarch/crates/core_arch/src/core_arch_docs.md",
];

// Platform-specific std modules that are cfg'd out for wasm32-wasip1. Only
// pruned under std/src/sys and std/src/os; `unix` stays because wasi reuses it.
const OTHER_PLATFORMS = new Set([
  "windows", "windows_prefix", "uefi", "sgx", "fortanix_sgx", "hermit", "itron", "solid",
  "teeos", "trusty", "vexos", "xous", "zkvm", "motor", "horizon", "vita", "nuttx", "aix",
  "android", "ios", "macos", "freebsd", "netbsd", "openbsd", "dragonfly", "illumos",
  "solaris", "haiku", "l4re", "fuchsia", "redox", "vxworks", "espidf", "hurd", "nto",
  "rtems", "cygwin", "emscripten", "darwin", "apple", "qnx", "linux", "watchos", "tvos",
  "visionos", "fortanix", "nintendo", "wasip2", "wasip3",
]);

function isExcluded(rel) {
  const parts = rel.split("/");
  const base = parts[parts.length - 1];
  if (!/\.(rs|md)$/.test(base)) return true;
  if (parts.includes("tests") || parts.includes("benches")) return true;
  if (base === "tests.rs" || base === "benches.rs") return true;
  if (rel.startsWith("std/src/sys/") || rel.startsWith("std/src/os/")) {
    for (const p of parts.slice(3)) {
      if (OTHER_PLATFORMS.has(p.replace(/\.rs$/, ""))) return true;
    }
  }
  return false;
}

function walk(dir, out) {
  for (const ent of fs.readdirSync(path.join(libDir, dir), { withFileTypes: true })) {
    const rel = `${dir}/${ent.name}`;
    if (ent.isDirectory()) walk(rel, out);
    else if (ent.isFile() && !isExcluded(rel)) out.push(rel);
  }
}

const files = [];
for (const r of ROOTS) walk(r, files);
for (const f of EXTRA_FILES) if (fs.existsSync(path.join(libDir, f))) files.push(f);
files.sort();

const chunks = [];
const u32 = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
};
chunks.push(Buffer.from("RSTD"), u32(1), u32(files.length));
let rawText = 0;
for (const f of files) {
  const p = Buffer.from(f, "utf8");
  const t = fs.readFileSync(path.join(libDir, f));
  rawText += t.length;
  chunks.push(u32(p.length), p, u32(t.length), t);
}
const raw = Buffer.concat(chunks);
const gz = zlib.gzipSync(raw, { level: 9 });
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, gz);
console.log(
  `rust-std bundle: ${files.length} files, ${(raw.length / 1e6).toFixed(2)} MB raw, ` +
    `${(gz.length / 1e6).toFixed(2)} MB gzip -> ${outFile}`,
);
