/**
 * Parsers for clang's own text output: `-code-completion-at` results
 * (PrintingCodeCompleteConsumer) and diagnostics printed with
 * `-fdiagnostics-print-source-range-info -fdiagnostics-parseable-fixits`.
 * Pure functions, so they can be unit-tested in Node.
 */

import type { CompletionItem, CompletionKind, Diagnostic, Position, Range, Severity, TextEdit } from '../types';

// ---------------------------------------------------------------------------
// Code completion strings
// ---------------------------------------------------------------------------
//
// clang prints a CodeCompletionString with markers:
//   [#...#]  result type or informative text
//   <#...#>  placeholder (or, in OVERLOAD lines, the current parameter)
//   {#...#}  optional chunk (default arguments), may nest placeholders

type Chunk =
  | { t: 'text'; v: string }
  | { t: 'info'; v: string }
  | { t: 'ph'; v: string }
  | { t: 'opt'; v: Chunk[] };

export function parseChunks(s: string): Chunk[] {
  let i = 0;
  const parse = (close?: string): Chunk[] => {
    const out: Chunk[] = [];
    let text = '';
    const flush = () => {
      if (text) out.push({ t: 'text', v: text });
      text = '';
    };
    while (i < s.length) {
      if (close && s.startsWith(close, i)) {
        i += close.length;
        break;
      }
      const two = s.slice(i, i + 2);
      if (two === '[#' || two === '<#') {
        flush();
        const end = two === '[#' ? '#]' : '#>';
        const stop = s.indexOf(end, i + 2);
        const v = s.slice(i + 2, stop < 0 ? s.length : stop);
        out.push({ t: two === '[#' ? 'info' : 'ph', v });
        i = stop < 0 ? s.length : stop + 2;
      } else if (two === '{#') {
        flush();
        i += 2;
        out.push({ t: 'opt', v: parse('#}') });
      } else {
        text += s[i++];
      }
    }
    flush();
    return out;
  };
  return parse();
}

const plain = (chunks: Chunk[], withOptional = true): string =>
  chunks
    .map((c) =>
      c.t === 'opt' ? (withOptional ? plain(c.v) : '') : c.v,
    )
    .join('');

export type ParsedCompletion = {
  name: string;
  /** Result type (the leading [#...#]), if any. */
  result?: string;
  /** Everything after the result type, as display text, e.g. `add(const T &value) const`. */
  display: string;
  snippet: string;
  hasCall: boolean;
  isTemplate: boolean;
  brief?: string;
  hidden: boolean;
  pattern: boolean;
  raw: string;
};

function snippetFrom(chunks: Chunk[]): string {
  let n = 0;
  const esc = (v: string) => v.replace(/[$#{}\\]/g, (m) => '\\' + m);
  const walk = (cs: Chunk[]): string =>
    cs
      .map((c) => {
        if (c.t === 'text') return esc(c.v);
        if (c.t === 'info') return '';
        if (c.t === 'opt') return ''; // default arguments are left out, as in VS Code
        // Placeholder: keep the parameter name only, e.g. `const T &value` -> `value`.
        const name = c.v.match(/([A-Za-z_]\w*)\s*(?:=.*)?$/)?.[1] ?? c.v;
        return `\${${++n}:${esc(name)}}`;
      })
      .join('');
  return walk(chunks);
}

/** Parses one `COMPLETION:` entry (already joined with its continuation lines). */
export function parseCompletionLine(body: string): ParsedCompletion | null {
  // `name : ccs : brief` — the name has no spaces except the (Hidden)/(Inaccessible) tags.
  const m = body.match(/^(\S+)((?: \((?:Hidden|Inaccessible)\))*)(?: : ([\s\S]*))?$/);
  if (!m) return null;
  const [, name, tags, rest = ''] = m;
  const hidden = /Hidden|Inaccessible/.test(tags);
  // The brief comment follows the last " : " that is outside any marker.
  let ccs = rest;
  let brief: string | undefined;
  let depth = 0;
  for (let i = 0; i < rest.length; i++) {
    const two = rest.slice(i, i + 2);
    if (two === '[#' || two === '<#' || two === '{#') {
      depth++;
      i++;
    } else if (two === '#]' || two === '#>' || two === '#}') {
      depth--;
      i++;
    } else if (depth === 0 && rest.startsWith(' : ', i)) {
      ccs = rest.slice(0, i);
      brief = rest.slice(i + 3).trim() || undefined;
      break;
    }
  }
  if (!rest) {
    return { name, display: name, snippet: name, hasCall: false, isTemplate: false, hidden, pattern: false, raw: body };
  }
  const chunks = parseChunks(ccs);
  let result: string | undefined;
  if (chunks[0]?.t === 'info') result = chunks.shift()!.v as string;
  const display = plain(chunks).replace(/\s+/g, ' ').trim();
  const pattern = name === 'Pattern';
  const label = pattern ? (plain(chunks, false).match(/^[A-Za-z_][\w]*(?:\.\.\.)?/)?.[0] ?? display) : name;
  const after = display.slice(label.length);
  return {
    name: label,
    result,
    display,
    snippet: snippetFrom(chunks),
    hasCall: after.startsWith('('),
    isTemplate: after.startsWith('<'),
    brief,
    hidden,
    pattern,
    raw: body,
  };
}

/** Splits clang's stdout into `COMPLETION:` / `OVERLOAD:` entries. */
export function splitCompletionOutput(out: string): { completions: string[]; overloads: string[] } {
  const completions: string[] = [];
  const overloads: string[] = [];
  let current: string[] | null = null;
  for (const line of out.split('\n')) {
    if (line.startsWith('COMPLETION: ')) {
      completions.push(line.slice(12));
      current = completions;
    } else if (line.startsWith('OVERLOAD: ')) {
      overloads.push(line.slice(10));
      current = overloads;
    } else if (/^[A-Z-]+: /.test(line)) {
      // PREFERRED-TYPE: and similar trailers end the previous entry.
      current = null;
    } else if (current && current.length && line.length) {
      // Multi-line patterns (e.g. `for (...) {` + body) continue on the next lines.
      current[current.length - 1] += '\n' + line;
    }
  }
  return { completions, overloads };
}

const KEYWORDS_TYPES = new Set([
  'bool', 'char', 'char8_t', 'char16_t', 'char32_t', 'double', 'float', 'int', 'long', 'short', 'signed',
  'unsigned', 'void', 'wchar_t', 'auto', 'size_t',
]);

function kindOf(p: ParsedCompletion, memberAccess: boolean): CompletionKind {
  if (p.pattern) return 'snippet';
  if (!p.result && p.display === p.name) {
    if (KEYWORDS_TYPES.has(p.name) || /^[a-z_]+$/.test(p.name)) return 'keyword';
  }
  if (p.display.endsWith('::')) return /^[A-Z]/.test(p.name) ? 'class' : 'namespace';
  if (p.isTemplate && !p.hasCall) return 'class';
  if (p.hasCall) {
    if (!p.result && /^[A-Z][A-Z0-9_]+$/.test(p.name)) return 'macro';
    if (!p.result) return 'constructor';
    return memberAccess ? 'method' : 'function';
  }
  if (!p.result) {
    if (/^[A-Z][A-Z0-9_]*$/.test(p.name)) return 'macro';
    return /^[A-Z]/.test(p.name) ? 'class' : 'keyword';
  }
  if (/^[A-Z][A-Z0-9_]+$/.test(p.name)) return 'constant';
  return memberAccess ? 'field' : 'variable';
}

/** Names that are clang/libc++ internals nobody types by hand. */
const isReserved = (name: string) => /^_[_A-Z]/.test(name) || name.startsWith('operator');

export type ClangCompletionContext = {
  memberAccess: boolean;
  /** Identifiers that appear in the user's file get a boost. */
  localNames: ReadonlySet<string>;
  /** Names declared in the Stanford library headers get a boost. */
  stanfordNames: ReadonlySet<string>;
};

/**
 * Turns raw entries into editor items. Overloads that share a name are
 * bundled into one row, like clangd's bundled mode in VS Code.
 */
export function toCompletionItems(entries: string[], ctx: ClangCompletionContext): CompletionItem[] {
  const byKey = new Map<string, { item: CompletionItem; overloads: ParsedCompletion[] }>();
  for (const entry of entries) {
    const p = parseCompletionLine(entry);
    if (!p || p.hidden || isReserved(p.name) || (!p.pattern && !/^~?[A-Za-z_]\w*$/.test(p.name))) continue;
    const kind = kindOf(p, ctx.memberAccess);
    if (kind === 'constructor') continue; // `Vector<int>(…)` rows only add noise
    // After `v.`, clang also offers `Vector::` (for `v.Vector::add`); nobody wants it.
    if (ctx.memberAccess && p.display.endsWith('::')) continue;
    const key = `${kind}:${p.name}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.overloads.push(p);
      if (!existing.item.documentation && p.brief) existing.item.documentation = p.brief;
      continue;
    }
    let boost = 0;
    if (ctx.localNames.has(p.name)) boost += 3;
    if (ctx.stanfordNames.has(p.name)) boost += 1;
    if (kind === 'keyword') boost += 1;
    if (kind === 'macro' && !ctx.stanfordNames.has(p.name)) boost -= 4;
    if (p.name.startsWith('_')) boost -= 4;
    const callable = p.hasCall && kind !== 'macro' ? true : p.hasCall;
    byKey.set(key, {
      item: {
        label: p.name,
        kind,
        detail: p.result,
        signature: p.pattern ? undefined : (p.result ? `${p.result} ` : '') + p.display,
        documentation: p.brief,
        insert: callable || p.isTemplate || p.pattern ? p.snippet : p.name,
        snippet: callable || p.isTemplate || p.pattern,
        boost,
      },
      overloads: [p],
    });
  }
  const items: CompletionItem[] = [];
  for (const { item, overloads } of byKey.values()) {
    if (overloads.length > 1) {
      item.signature = overloads
        .map((o) => (o.result ? `${o.result} ` : '') + o.display)
        .join('\n');
      item.detail = `${item.detail ?? ''}${item.detail ? '  ' : ''}+${overloads.length - 1} overload${overloads.length > 2 ? 's' : ''}`;
      // Prefer the shortest overload as what gets inserted.
      const shortest = overloads.reduce((a, b) => (a.snippet.length <= b.snippet.length ? a : b));
      item.insert = shortest.snippet;
    }
    items.push(item);
  }
  return items;
}

// ---------------------------------------------------------------------------
// Signature help (OVERLOAD lines)
// ---------------------------------------------------------------------------

export type ParsedOverload = {
  label: string;
  parameters: Array<[number, number]>;
  active: number | null;
};

/** `[#bool#]inBounds(int row, <#int col#>)[# const#]` -> label + parameter offsets. */
export function parseOverload(line: string): ParsedOverload {
  const chunks = parseChunks(line);
  let label = '';
  let result: string | undefined;
  if (chunks[0]?.t === 'info') result = chunks.shift()!.v as string;
  const parts: Array<{ text: string; current: boolean }> = [];
  const walk = (cs: Chunk[], optional: boolean) => {
    for (const c of cs) {
      if (c.t === 'opt') walk(c.v, true);
      else parts.push({ text: c.v, current: c.t === 'ph' && !optional });
    }
  };
  walk(chunks, false);
  const text = parts.map((p) => p.text).join('');
  label = (result ? `${result} ` : '') + text;
  const base = result ? result.length + 1 : 0;
  // Parameters are the comma-separated pieces between the outer parentheses.
  const open = text.indexOf('(');
  const close = text.lastIndexOf(')');
  const parameters: Array<[number, number]> = [];
  let active: number | null = null;
  if (open >= 0 && close > open) {
    // Map each character back to whether it was in the current parameter.
    const currentMask: boolean[] = [];
    for (const p of parts) for (let k = 0; k < p.text.length; k++) currentMask.push(p.current);
    let depth = 0;
    let start = open + 1;
    for (let i = open + 1; i <= close; i++) {
      const ch = text[i];
      if (ch === '(' || ch === '<' || ch === '[' || ch === '{') depth++;
      else if ((ch === ')' || ch === '>' || ch === ']' || ch === '}') && i !== close) depth--;
      if ((ch === ',' && depth === 0) || i === close) {
        let s = start;
        let e = i;
        while (s < e && text[s] === ' ') s++;
        while (e > s && text[e - 1] === ' ') e--;
        if (e > s) {
          if (currentMask[s]) active = parameters.length;
          parameters.push([base + s, base + e]);
        }
        start = i + 1;
      }
    }
  }
  return { label, parameters, active };
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

/** Converts a 1-based byte column on `lineText` to a 0-based UTF-16 column. */
export function byteColToUtf16(lineText: string, col: number): number {
  const target = col - 1;
  let bytes = 0;
  let i = 0;
  while (i < lineText.length && bytes < target) {
    const code = lineText.codePointAt(i)!;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
    i += code > 0xffff ? 2 : 1;
  }
  return i + Math.max(0, target - bytes);
}

/** Converts a 0-based UTF-16 column on `lineText` to a 1-based byte column. */
export function utf16ToByteCol(lineText: string, character: number): number {
  return new TextEncoder().encode(lineText.slice(0, character)).length + 1;
}

type RawDiag = {
  file: string;
  line: number;
  col: number;
  ranges: Array<[number, number, number, number]>;
  severity: 'error' | 'warning' | 'note' | 'fatal error' | 'remark';
  message: string;
};

const DIAG_RE =
  /^(.*?):(\d+):(\d+):((?:\{\d+:\d+-\d+:\d+\})*):? ?(error|warning|note|fatal error|remark): (.*)$/;

type Fixit = TextEdit;

export function parseClangDiagnostics(
  stderr: string,
  mainFile: string,
  source: string,
): Diagnostic[] {
  const lines = source.split('\n');
  const pos = (line: number, col: number): Position => {
    const l = Math.min(Math.max(line, 1), lines.length);
    return { line: l - 1, character: byteColToUtf16(lines[l - 1] ?? '', col) };
  };
  const raws: Array<RawDiag & { fixits: Fixit[] }> = [];
  for (const line of stderr.split('\n')) {
    const fix = line.match(/^fix-it:"(.*?)":\{(\d+):(\d+)-(\d+):(\d+)\}:"(.*)"$/);
    if (fix) {
      const last = raws[raws.length - 1];
      if (last && fix[1] === mainFile) {
        last.fixits.push({
          range: { start: pos(+fix[2], +fix[3]), end: pos(+fix[4], +fix[5]) },
          text: JSON.parse(`"${fix[6]}"`),
        });
      }
      continue;
    }
    const m = line.match(DIAG_RE);
    if (!m) continue;
    const ranges = [...m[4].matchAll(/\{(\d+):(\d+)-(\d+):(\d+)\}/g)].map(
      (r) => [+r[1], +r[2], +r[3], +r[4]] as [number, number, number, number],
    );
    raws.push({
      file: m[1],
      line: +m[2],
      col: +m[3],
      ranges,
      severity: m[5] as RawDiag['severity'],
      message: m[6],
      fixits: [],
    });
  }

  const out: Diagnostic[] = [];
  for (let i = 0; i < raws.length; i++) {
    const d = raws[i];
    if (d.severity === 'note' || d.severity === 'remark') continue;
    if (/too many errors emitted/.test(d.message)) continue;
    const notes: RawDiag[] = [];
    for (let j = i + 1; j < raws.length && raws[j].severity === 'note'; j++) notes.push(raws[j]);
    // An error inside a Stanford/STL header is reported at the line of the
    // user's code that caused it (usually a template instantiation note).
    let anchor: RawDiag | undefined = d.file === mainFile ? d : notes.find((n) => n.file === mainFile);
    if (!anchor) continue;
    const severity: Severity = d.severity === 'warning' ? 'warning' : 'error';
    const range = rangeOf(anchor, lines, pos);
    // Notes in the user's file first; library notes (overload candidates) are
    // summarized so one bad call doesn't produce a wall of libc++ text.
    const header = (file: string) => file.replace(/^\/(include\/c\+\+\/v1\/|include\/)?/, '');
    const own = notes.filter((n) => n !== anchor && n.file === mainFile).map((n) => `line ${n.line}: ${n.message}`);
    const lib = notes.filter((n) => n !== anchor && n.file !== mainFile);
    const extra = [
      ...own.slice(0, 3),
      ...lib.slice(0, 2).map((n) => `${header(n.file)}:${n.line} · ${n.message}`),
      ...(lib.length > 2 ? [`… ${lib.length - 2} more ${lib.length - 2 === 1 ? 'note' : 'notes'} in library headers`] : []),
    ];
    const warningFlag = d.message.match(/ \[(-W[\w-]+)(?:,-Werror)?\]$/);
    out.push({
      range,
      severity: /-Werror/.test(d.message) ? 'error' : severity,
      message: (d === anchor ? d.message : `${d.message} (in ${header(d.file)}:${d.line})`).replace(
        / \[-W[\w-]+(?:,-Werror)?\]$/,
        '',
      ),
      code: warningFlag?.[1],
      source: 'clang',
      notes: extra.length ? extra : undefined,
      fixes: d.fixits.length ? [{ title: fixTitle(d.fixits), edits: d.fixits }] : undefined,
      unnecessary: /unused/.test(d.message) || undefined,
    });
  }
  return out;
}

function rangeOf(
  d: RawDiag,
  lines: string[],
  pos: (line: number, col: number) => Position,
): Range {
  // Prefer a source range that contains the caret location.
  const r = d.ranges.find((r) => r[0] === d.line && r[1] <= d.col && (r[2] > d.line || r[3] >= d.col)) ?? d.ranges[0];
  if (r && r[0] === r[2] && r[3] > r[1]) {
    // clang's range end points at the start of the last token; extend to its end.
    const text = lines[r[2] - 1] ?? '';
    const endTok = text.slice(r[3] - 1).match(/^[A-Za-z0-9_]+|^./)?.[0].length ?? 1;
    return { start: pos(r[0], r[1]), end: pos(r[2], r[3] + endTok) };
  }
  // Otherwise underline the token at the caret.
  const text = lines[d.line - 1] ?? '';
  const start = pos(d.line, d.col);
  const tok = text.slice(start.character).match(/^[A-Za-z0-9_]+|^\S/)?.[0].length ?? 1;
  return { start, end: { line: start.line, character: start.character + tok } };
}

function fixTitle(edits: TextEdit[]): string {
  const [e] = edits;
  if (edits.length === 1 && e.text && e.range.start.line === e.range.end.line && e.range.start.character === e.range.end.character)
    return `Insert \`${e.text}\``;
  if (edits.length === 1 && !e.text) return 'Remove';
  if (edits.length === 1) return `Replace with \`${e.text}\``;
  return 'Apply fix';
}

/** Identifiers that appear in a source text (for ranking completions). */
export function identifiersIn(text: string): Set<string> {
  return new Set(text.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []);
}
