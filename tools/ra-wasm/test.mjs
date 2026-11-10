#!/usr/bin/env node
// Smoke test for dist/: loads the wasm + std bundle in Node and exercises every
// RustAnalyzer method. Run `./build.sh` first, then `node test.mjs`.
import fs from "node:fs";
import zlib from "node:zlib";
import { performance } from "node:perf_hooks";
import { initSync, RustAnalyzer } from "./dist/ra_wasm.js";

const dist = new URL("./dist/", import.meta.url);
const ms = (t0) => `${(performance.now() - t0).toFixed(0)} ms`;
const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;
let failures = 0;
function check(name, ok, extra = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
  if (!ok) failures++;
}

// `$0` marks the cursor; returns [text, line, character(UTF-16)].
function cursor(src) {
  const i = src.indexOf("$0");
  const text = src.slice(0, i) + src.slice(i + 2);
  const before = src.slice(0, i).split("\n");
  return [text, before.length - 1, before[before.length - 1].length];
}

const MAIN = `use std::collections::HashMap;

/// Adds two numbers.
fn add(a: i32, b: i32) -> i32 {
    a + b
}

fn main() {
    let mut v: Vec<i32> = Vec::new();
    v.push(1);
    let total = add(v.len() as i32, 2);
    let doubled = v.iter().map(|x| x * 2).collect::<Vec<_>>();
    let mut m = HashMap::new();
    m.insert("a", total);
    let s: i32 = "hello";
    let emoji = "😀"; let n = emoji.len();
    println!("{} {:?} {:?} {} {}", total, doubled, m, s, n);
}
`;
const posOf = (needle, nth = 0, delta = 0) => {
  let idx = -1;
  for (let k = 0; k <= nth; k++) idx = MAIN.indexOf(needle, idx + 1);
  const before = MAIN.slice(0, idx + delta).split("\n");
  return [before.length - 1, before[before.length - 1].length];
};
const withBody = (body) => cursor(`use std::collections::HashMap;\nfn helper_fn() {}\nfn main() {\n    let mut v: Vec<i32> = Vec::new();\n    let local_var = 5;\n${body}\n}\n`);

// --- load -------------------------------------------------------------------
let t0 = performance.now();
const wasmBytes = fs.readFileSync(new URL("ra_wasm_bg.wasm", dist));
const wasm = initSync({ module: wasmBytes });
const tInst = ms(t0);

t0 = performance.now();
const ra = new RustAnalyzer(2024);
let badEdition = null;
try { new RustAnalyzer(2019); } catch (e) { badEdition = String(e.message ?? e); }
check("unknown edition is rejected", badEdition?.includes("unsupported edition 2019"), badEdition ?? "");
const bundle = zlib.gunzipSync(fs.readFileSync(new URL("rust-std.bin.gz", dist)));
const tGunzip = ms(t0);
t0 = performance.now();
ra.load_std(bundle);
const tLoad = ms(t0);
console.log(`instantiate: ${tInst}   gunzip: ${tGunzip}   load_std: ${tLoad}`);

// Labels follow rust-analyzer/VS Code (`push(…)`, `println!(…)`); `filter_text`
// is the bare name.
const labels = (json) => JSON.parse(json).items.map((i) => i.filter_text ?? i.label);

// --- completions after v. (cold, then warm) ----------------------------------
{
  const [text, l, c] = withBody("    v.$0");
  ra.set_text(text);
  t0 = performance.now();
  const out = ra.completions(l, c);
  const tCold = ms(t0);
  const items = JSON.parse(out).items;
  const ls = items.map((i) => i.filter_text ?? i.label);
  check("v. completions include push/len/iter", ["push", "len", "iter"].every((x) => ls.includes(x)), `(${items.length} items, cold ${tCold})`);
  console.log("   sample:", JSON.stringify(items.find((i) => i.filter_text === "push")));
  console.log("   top 15 by relevance:", items.slice().sort((a, b) => a.sort_text.localeCompare(b.sort_text)).slice(0, 15).map((i) => `${i.label}:${i.kind}`).join(" "));
  t0 = performance.now();
  ra.completions(l, c);
  console.log(`   warm (same text): ${ms(t0)}`);
  // Edit then complete again (typical keystroke).
  const [text2, l2, c2] = withBody("    v.pu$0");
  ra.set_text(text2);
  t0 = performance.now();
  const ls2 = labels(ra.completions(l2, c2));
  console.log(`   warm after edit (v.pu): ${ms(t0)}, has push: ${ls2.includes("push")}`);
}

// --- iterator chain -----------------------------------------------------------
{
  const [text, l, c] = withBody("    let r = v.iter().map(|x| x + 1).$0");
  ra.set_text(text);
  t0 = performance.now();
  const ls = labels(ra.completions(l, c));
  check("iter().map(..). completions include filter/collect/sum", ["filter", "collect", "sum"].every((x) => ls.includes(x)), ms(t0));
}

// --- path completions --------------------------------------------------------
{
  const [text, l, c] = withBody("    let x = std::collections::$0");
  ra.set_text(text);
  t0 = performance.now();
  const ls = labels(ra.completions(l, c));
  check("std::collections:: completions", ["HashMap", "BTreeMap", "VecDeque"].every((x) => ls.includes(x)), `${ms(t0)}  ${ls.slice(0, 12).join(" ")}`);
}
{
  const [text, l, c] = withBody("    let x = HashMap::$0");
  ra.set_text(text);
  const ls = labels(ra.completions(l, c));
  check("HashMap:: completions", ["new", "with_capacity"].every((x) => ls.includes(x)), ls.slice(0, 10).join(" "));
}
{
  const [text, l, c] = withBody("    loc$0");
  ra.set_text(text);
  const items = JSON.parse(ra.completions(l, c)).items;
  const ls = items.map((i) => i.filter_text ?? i.label);
  check("locals / fns / keywords / macros in scope", ls.includes("local_var") && ls.includes("helper_fn") && ls.includes("loop") && ls.includes("println!"), `(${items.length} items)`);
  const pl = items.find((i) => i.filter_text === "println!");
  console.log("   println!:", JSON.stringify(pl && { label: pl.label, kind: pl.kind, insert_text: pl.insert_text, is_snippet: pl.is_snippet }));
}
{
  const [text, l, c] = withBody("    let b = Rc$0");
  ra.set_text(text);
  t0 = performance.now();
  const items = JSON.parse(ra.completions(l, c)).items;
  const rc = items.find((i) => i.filter_text === "Rc");
  check("flyimport Rc adds a use edit", !!rc?.additional_edits?.some((e) => /rc::Rc/.test(e.new_text)), `${ms(t0)} ${JSON.stringify(rc && { label: rc.label, additional_edits: rc.additional_edits })}`);
}
{
  const [text, l, c] = withBody("    local_var.i$0");
  ra.set_text(text);
  const it = JSON.parse(ra.completions(l, c)).items.find((i) => i.filter_text === "dbg" && i.kind === "snippet");
  console.log("   postfix .dbg:", JSON.stringify(it && { label: it.label, insert_text: it.insert_text, edit_range: it.edit_range, additional_edits: it.additional_edits }));
}
{
  // UTF-16 columns: emoji before the cursor.
  const [text, l, c] = withBody(`    let e = "😀"; e.$0`);
  ra.set_text(text);
  const ls = labels(ra.completions(l, c));
  check("UTF-16 column after emoji", ls.includes("len") && ls.includes("chars"));
}

// --- hover / signature help / goto / diagnostics / inlay hints on MAIN -------
ra.set_text(MAIN);
{
  const [l, c] = posOf("push", 0, 1);
  t0 = performance.now();
  const h = JSON.parse(ra.hover(l, c));
  check("hover on push", !!h && h.markdown.includes("fn push"), ms(t0));
  console.log("   " + (h?.markdown ?? "null").slice(0, 400).replace(/\n/g, "\n   "));
  console.log("   range:", JSON.stringify(h?.range));
}
{
  const [l, c] = posOf("total", 0, 1);
  const h = JSON.parse(ra.hover(l, c));
  check("hover on local `total`", !!h && h.markdown.includes("i32"), JSON.stringify(h?.markdown));
}
{
  const [text, l, c] = withBody("    v.push($0)");
  ra.set_text(text);
  t0 = performance.now();
  const sh = JSON.parse(ra.signature_help(l, c));
  check("signature help in v.push(", !!sh && sh.label.includes("push(&mut self, value: i32)"), ms(t0));
  console.log("   ", JSON.stringify({ label: sh?.label, parameters: sh?.parameters, active_parameter: sh?.active_parameter, params: sh?.parameters.map(([a, b]) => sh.label.slice(a, b)) }));
  console.log("    doc:", (sh?.documentation ?? "").slice(0, 120).replace(/\n/g, " "));
}
{
  const [text, l, c] = cursor("fn add(a: i32, b: i32) -> i32 { a + b }\nfn main() { add(1, $0) }\n");
  ra.set_text(text);
  const sh = JSON.parse(ra.signature_help(l, c));
  check("signature help active_parameter=1 for add(1, |)", sh?.active_parameter === 1, JSON.stringify(sh));
}
ra.set_text(MAIN);
{
  t0 = performance.now();
  const d = JSON.parse(ra.diagnostics());
  const tDiag = ms(t0);
  const mismatch = d.find((x) => x.code === "E0308");
  check("type-mismatch diagnostic", !!mismatch, `${tDiag} ${JSON.stringify(mismatch)}`);
  console.log("   all:", JSON.stringify(d));
}
{
  t0 = performance.now();
  const hints = JSON.parse(ra.inlay_hints());
  const tHints = ms(t0);
  check("inlay hints (type + parameter)", hints.some((h) => h.kind === "type") && hints.some((h) => h.kind === "parameter"), `${tHints} (${hints.length} hints)`);
  for (const h of hints) console.log("   ", JSON.stringify(h));
}
{
  const [l, c] = posOf("add(v.len", 0, 1);
  const g = JSON.parse(ra.goto_definition(l, c));
  check("goto-def local fn add", g.length === 1 && g[0].in_main && g[0].range.start.line === 3, JSON.stringify(g));
}
{
  const [l, c] = posOf("Vec::new", 0, 6);
  t0 = performance.now();
  const g = JSON.parse(ra.goto_definition(l, c));
  check("goto-def Vec::new -> std", g.length >= 1 && !g[0].in_main && g[0].path?.startsWith("alloc/"), ms(t0));
  for (const x of g) console.log("   ", JSON.stringify({ ...x, snippet: undefined }), "\n" + x.snippet?.replace(/^/gm, "      | "));
}
{
  const [l, c] = posOf("HashMap::new", 0, 1);
  const g = JSON.parse(ra.goto_definition(l, c));
  console.log("   goto HashMap:", JSON.stringify(g.map((x) => ({ path: x.path, line: x.line }))));
}

// --- typing simulation: 40 keystrokes, each followed by the queries an editor
// would run (completions + diagnostics + inlay hints) -------------------------
{
  const word = "let some_new_value = v.len() + local_var;";
  const times = [];
  for (let k = 1; k <= word.length; k++) {
    const [text, l, c] = withBody("    " + word.slice(0, k) + "$0");
    const t = performance.now();
    ra.set_text(text);
    ra.completions(l, c);
    ra.diagnostics();
    ra.inlay_hints();
    times.push(performance.now() - t);
  }
  times.sort((a, b) => a - b);
  console.log(`typing ${times.length} keystrokes (set_text+completions+diagnostics+inlay_hints): median ${times[times.length >> 1].toFixed(1)} ms, max ${times[times.length - 1].toFixed(1)} ms`);
}

const memBytes = wasm.memory.buffer.byteLength;
console.log(`\nwasm memory: ${mb(memBytes)}   node rss: ${mb(process.memoryUsage().rss)}`);
console.log(failures ? `${failures} FAILED` : "all checks passed");
process.exit(failures ? 1 : 0);
