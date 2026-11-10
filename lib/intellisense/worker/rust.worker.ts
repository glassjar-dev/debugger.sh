/// <reference lib="webworker" />
/**
 * Rust language worker.
 *  - Diagnostics: the engine's rustc (`--emit=metadata`), so squiggles match
 *    what Run reports, including type errors with rustc's suggestions.
 *  - Completions, hover, signature help, go-to-definition, inlay hints:
 *    rust-analyzer compiled to wasm (tools/ra-wasm) with std sources.
 */

import { RUST_ANALYZER_BASE, RUST_EDITION, RUST_SYSROOT_URL, RUSTC_WASM_URL } from '../toolchains';
import type {
  CompletionItem,
  CompletionKind,
  CompletionResult,
  DefinitionTarget,
  HoverResult,
  InlayHint,
  Position,
  Range,
  SignatureResult,
} from '../types';
import { postStatus, serve } from './host';
import { parseRustcDiagnostics } from './rustcOutput';
import { compileModule, fetchBytes, gunzip, newRoot, runProcess, untar, writeFile } from './wasi';

const MAIN = '/main.rs';
/** Same flags as the engine's Run. */
const RUSTC_ARGS = [
  'rustc', MAIN, `--edition=${RUST_EDITION}`, '--sysroot', '/', '--target', 'wasm32-wasip1', '-Zthreads=1', '--emit=metadata',
  '-o', '/main.rmeta', '--error-format=json', '--crate-type', 'bin',
];

type RaApi = {
  load_std(bundle: Uint8Array): void;
  set_text(text: string): void;
  completions(line: number, character: number): string;
  hover(line: number, character: number): string;
  signature_help(line: number, character: number): string;
  goto_definition(line: number, character: number): string;
  diagnostics(): string;
  inlay_hints(): string;
};

const root = newRoot();
let rustc: WebAssembly.Module;
let ra: RaApi | null = null;
let raText: string | null = null;

const rustcReady = (async () => {
  const [module, sysroot] = await Promise.all([
    compileModule(RUSTC_WASM_URL),
    fetchBytes(RUST_SYSROOT_URL).then(gunzip),
  ]);
  // Checking only needs crate metadata, not the rlibs' object code.
  untar(sysroot, root, (path) => path.endsWith('.rmeta'));
  rustc = module;
})();

// rust-analyzer reports panics through console.error (console_error_panic_hook);
// keep the last one so a failure can say why.
let lastPanic = '';
const consoleError = console.error.bind(console);
console.error = (...args: unknown[]) => {
  lastPanic = args.map(String).join(' ').slice(0, 400);
  consoleError(...args);
};

let raGlue: { RustAnalyzer: new (edition: number) => RaApi } | null = null;
let raStd: Uint8Array | null = null;

/** A fresh analyzer over std. Indexing std takes ~1 s, so warm it up right away. */
function startAnalyzer() {
  const analyzer = new raGlue!.RustAnalyzer(RUST_EDITION);
  analyzer.load_std(raStd!);
  // Index std and the common method tables before the user's first `.`.
  analyzer.set_text('fn main() {\n    let mut v: Vec<i32> = Vec::new();\n    let s = String::new();\n    v.\n    s.\n}\n');
  analyzer.completions(3, 6);
  analyzer.completions(4, 6);
  analyzer.diagnostics();
  ra = analyzer;
  raText = null;
}

const raReady = (async () => {
  const base = new URL(RUST_ANALYZER_BASE + '/', self.location.origin).href;
  const glue = await import(/* webpackIgnore: true */ `${base}ra_wasm.js`);
  const [wasm, std] = await Promise.all([
    fetchBytes(`${base}ra_wasm_bg.wasm`),
    fetchBytes(`${base}rust-std.bin.gz`).then(gunzip),
  ]);
  glue.initSync({ module: wasm });
  raGlue = glue;
  raStd = std;
  startAnalyzer();
})();

const ready = (async () => {
  postStatus({ state: 'loading', detail: 'Loading rustc and rust-analyzer' });
  const started = performance.now();
  await rustcReady;
  try {
    await raReady;
    postStatus({ state: 'ready', detail: `rust-analyzer ready in ${Math.round(performance.now() - started)} ms` });
  } catch (error) {
    console.warn('[intellisense] rust-analyzer unavailable; diagnostics only', error);
    postStatus({ state: 'ready', detail: `rustc diagnostics only (rust-analyzer did not load: ${String(error)} ${lastPanic})` });
  }
})();
ready.catch((error: unknown) => postStatus({ state: 'error', detail: String(error) }));

function withText<T>(text: string, f: (api: RaApi) => string): T | null {
  if (!ra) return null;
  try {
    if (raText !== text) {
      ra.set_text(text);
      raText = text;
    }
    const json = f(ra);
    return json ? (JSON.parse(json) as T) : null;
  } catch (error) {
    // A rust-analyzer panic aborts its wasm instance; start a new one.
    console.warn('[intellisense] rust-analyzer crashed; restarting', error);
    ra = null;
    try {
      startAnalyzer();
    } catch (restartError) {
      console.warn('[intellisense] rust-analyzer restart failed', restartError);
    }
    return null;
  }
}

const KIND: Record<string, CompletionKind> = {
  function: 'function', method: 'method', field: 'field', variable: 'variable', struct: 'struct',
  enum: 'enum', enum_variant: 'member', trait: 'interface', module: 'module', keyword: 'keyword',
  snippet: 'snippet', constant: 'constant', static: 'constant', macro: 'macro', type_param: 'type',
  type_alias: 'type', lifetime: 'keyword', union: 'struct', binding: 'variable', self_param: 'variable',
  const_param: 'constant', label: 'keyword', builtin_type: 'type', attribute: 'keyword',
};

/** LSP snippets (`$1`, `${1:x}`, `$0`) to CodeMirror snippets (`${1}`, `${1:x}`, `${}`). */
function lspSnippetToCm(s: string): string {
  return s
    .replace(/\$\{0(?::([^}]*))?\}|\$0/g, (_m, ph) => `\${100:${ph ?? ''}}`)
    .replace(/\$(\d+)/g, '${$1}');
}

type RaCompletion = {
  label: string;
  filter_text?: string;
  label_detail?: string;
  label_description?: string;
  trigger_signature_help?: boolean;
  additional_edits?: Array<{ range: Range; new_text: string }>;
  kind: string;
  detail?: string;
  documentation?: string;
  insert_text: string;
  is_snippet: boolean;
  deprecated?: boolean;
  relevance?: number;
  edit_range: Range;
};

function complete({ text, pos }: { text: string; pos: Position }): CompletionResult | null {
  const result = withText<{ items: RaCompletion[] }>(text, (api) => api.completions(pos.line, pos.character));
  if (!result?.items.length) return null;
  const from = result.items[0].edit_range.start;
  const max = Math.max(1, ...result.items.map((i) => i.relevance ?? 0));
  const items: CompletionItem[] = result.items.map((i) => ({
    label: i.filter_text ?? i.label,
    display: i.label + (i.label_detail ? ` ${i.label_detail}` : ''),
    kind: KIND[i.kind] ?? 'text',
    detail: i.label_description ?? i.detail,
    signature: i.detail && i.detail !== i.label_description ? i.detail : undefined,
    documentation: i.documentation,
    insert: i.is_snippet ? lspSnippetToCm(i.insert_text) : i.insert_text,
    snippet: i.is_snippet,
    deprecated: i.deprecated,
    additionalEdits: i.additional_edits?.map((e) => ({ range: e.range, text: e.new_text })),
    triggerSignature: i.trigger_signature_help,
    // rust-analyzer's relevance knows about expected types; keep a gentle version of its order.
    boost:
      Math.round(((i.relevance ?? 0) / max) * 4) -
      (/^unsafe\b/.test(i.label_description ?? i.detail ?? '') ? 3 : 0) -
      (/\(\)\./.test(i.label) ? 2 : 0),
  }));
  return { from, items };
}

function hover({ text, pos }: { text: string; pos: Position }): HoverResult | null {
  const h = withText<{ markdown: string; range?: Range }>(text, (api) => api.hover(pos.line, pos.character));
  if (!h?.markdown) return null;
  // rust-analyzer: ```rust\npath\n``` + ```rust\nsignature\n``` + --- + docs
  const [head, ...rest] = h.markdown.split(/\n---\n/);
  const blocks = [...head.matchAll(/```rust\n([\s\S]*?)\n```/g)].map((m) => m[1]);
  const code = blocks.length ? blocks[blocks.length - 1] : undefined;
  const path = blocks.length > 1 ? blocks[0] : undefined;
  return {
    kind: path,
    code,
    markdown: (blocks.length ? rest.join('\n---\n') : h.markdown).trim() || undefined,
    range: h.range,
  };
}

function signature({ text, pos }: { text: string; pos: Position }): SignatureResult | null {
  const s = withText<{ label: string; parameters: Array<[number, number]>; active_parameter: number | null; documentation?: string }>(
    text,
    (api) => api.signature_help(pos.line, pos.character),
  );
  if (!s) return null;
  return {
    signatures: [{ label: s.label, parameters: s.parameters, documentation: s.documentation }],
    active: 0,
    activeParameter: s.active_parameter,
  };
}

function definition({ text, pos }: { text: string; pos: Position }): DefinitionTarget[] | null {
  const targets = withText<Array<{ in_main: boolean; range?: Range; path?: string; line?: number; snippet?: string; snippet_start_line?: number }>>(
    text,
    (api) => api.goto_definition(pos.line, pos.character),
  );
  if (!targets?.length) return null;
  return targets.map((t): DefinitionTarget => {
    if (t.in_main && t.range) return { kind: 'local', range: t.range };
    const start = t.snippet_start_line ?? t.line ?? 0;
    return {
      kind: 'external',
      path: t.path ?? 'std',
      line: (t.line ?? start) - start,
      firstLine: start + 1,
      snippet: t.snippet ?? '',
    };
  });
}

function inlayHints({ text }: { text: string }): InlayHint[] {
  const hints = withText<Array<{ position: Position; label: string; kind: InlayHint['kind']; padding_left?: boolean; padding_right?: boolean }>>(
    text,
    (api) => api.inlay_hints(),
  );
  return (hints ?? []).map((h) => ({
    position: h.position,
    label: h.label,
    kind: h.kind,
    paddingLeft: h.padding_left,
    paddingRight: h.padding_right,
  }));
}

/** rust-analyzer features wait for it; rustc diagnostics only need rustc. */
const raLoaded = raReady.catch(() => undefined);
const viaRa = <P, R>(f: (p: P) => R) => async (p: P) => {
  await raLoaded;
  return f(p);
};

serve({
  ready: rustcReady,
  async diagnose(text) {
    writeFile(root, MAIN, text);
    const { stderr } = await runProcess(rustc, RUSTC_ARGS, root);
    return parseRustcDiagnostics(stderr, MAIN, text);
  },
  handlers: {
    complete: viaRa(complete),
    hover: viaRa(hover),
    signature: viaRa(signature),
    definition: viaRa(definition),
    inlayHints: viaRa(inlayHints),
  },
});
