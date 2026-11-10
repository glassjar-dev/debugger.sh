/** Parses rustc's `--error-format=json` diagnostics into editor diagnostics. */

import type { Diagnostic, Fix, Position, Severity } from '../types';

type Span = {
  file_name: string;
  line_start: number;
  line_end: number;
  /** 1-based, in Unicode scalar values. */
  column_start: number;
  column_end: number;
  is_primary: boolean;
  label: string | null;
  suggested_replacement: string | null;
  suggestion_applicability: string | null;
  expansion?: { span: Span } | null;
};

type RustcDiagnostic = {
  message: string;
  code: { code: string } | null;
  level: string;
  spans: Span[];
  children: RustcDiagnostic[];
};

/** 1-based scalar column -> 0-based UTF-16 column. */
function scalarColToUtf16(line: string, col: number): number {
  let i = 0;
  for (let n = 1; n < col && i < line.length; n++) i += line.codePointAt(i)! > 0xffff ? 2 : 1;
  return i;
}

export function parseRustcDiagnostics(stderr: string, mainFile: string, source: string): Diagnostic[] {
  const lines = source.split('\n');
  const pos = (line: number, col: number): Position => {
    const l = Math.min(Math.max(line, 1), Math.max(lines.length, 1));
    return { line: l - 1, character: scalarColToUtf16(lines[l - 1] ?? '', col) };
  };
  const inMain = (s: Span) => s.file_name === mainFile || s.file_name === mainFile.replace(/^\//, '');
  // Spans inside a macro expansion point at std; walk out to the user's call site.
  const userSpan = (s: Span): Span | null => {
    let cur: Span | null | undefined = s;
    while (cur && !inMain(cur)) cur = cur.expansion?.span;
    return cur ?? null;
  };

  const out: Diagnostic[] = [];
  for (const raw of stderr.split('\n')) {
    if (!raw.startsWith('{')) continue;
    let d: RustcDiagnostic;
    try {
      d = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!/^(error|warning)$/.test(d.level) || !d.spans.length) continue;
    const primary = d.spans.find((s) => s.is_primary) ?? d.spans[0];
    const span = userSpan(primary);
    if (!span) continue;
    const severity: Severity = d.level === 'error' ? 'error' : 'warning';
    const notes: string[] = [];
    if (primary.label && primary.label !== d.message) notes.push(primary.label);
    for (const s of d.spans) {
      if (s !== primary && s.label && inMain(s)) notes.push(`line ${s.line_start}: ${s.label}`);
    }
    const fixes: Fix[] = [];
    for (const child of d.children) {
      const edits = child.spans
        .filter((s) => s.suggested_replacement != null && inMain(s))
        .map((s) => ({
          range: { start: pos(s.line_start, s.column_start), end: pos(s.line_end, s.column_end) },
          text: s.suggested_replacement!,
        }));
      if (edits.length && child.spans.every((s) => s.suggestion_applicability !== 'HasPlaceholders')) {
        fixes.push({ title: capitalize(child.message), edits });
      } else if (child.message && child.level !== 'failure-note') {
        notes.push(`${child.level}: ${child.message}`);
      }
    }
    const code = d.code?.code;
    out.push({
      range: { start: pos(span.line_start, span.column_start), end: pos(span.line_end, span.column_end) },
      severity,
      message: d.message,
      code,
      source: 'rustc',
      notes: notes.length ? notes.slice(0, 5) : undefined,
      fixes: fixes.length ? fixes : undefined,
      unnecessary: code === 'unused_variables' || code === 'dead_code' || code === 'unused_imports' || undefined,
    });
  }
  return out;
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
