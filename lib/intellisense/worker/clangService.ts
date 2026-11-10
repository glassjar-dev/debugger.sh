/**
 * C++ IntelliSense from the engine's own clang (the same llvm.core.wasm and
 * flags the Run button uses), driven through clang's built-in code completion
 * (`-code-completion-at`) and `-fsyntax-only`.
 */

import type {
  CompletionResult,
  DefinitionTarget,
  Diagnostic,
  HoverResult,
  Position,
  SignatureResult,
} from '../types';
import {
  byteColToUtf16,
  identifiersIn,
  parseClangDiagnostics,
  parseCompletionLine,
  parseOverload,
  splitCompletionOutput,
  toCompletionItems,
  utf16ToByteCol,
} from './clangOutput';
import { docMarkdown, indexStanfordDocs, type StanfordDoc } from './stanfordDocs';
import { readFile, runProcess, writeFile, type FsRoot } from './wasi';

export const MAIN = '/main.cpp';
export const PCH = '/__cs106b/support.pch';

/** Run's flags (engine `cpp_clang_args`), minus codegen. */
const BASE_ARGS = [
  'clang', '-cc1', '-triple', 'wasm32-wasip1', '-Werror', '-fsyntax-only', '-disable-free',
  '-isysroot', '/', '-internal-isystem', '/include/c++/v1', '-internal-isystem', '/include',
  '-internal-isystem', '/include/wasm32-wasip1', '-x', 'c++', '-std=c++23', '-fexceptions',
  '-fcxx-exceptions', '-exception-model=wasm', '-target-feature', '+exception-handling',
  '-include-pch', PCH, '-fno-validate-pch',
  // Like the engine: quoted includes also resolve from the workspace root.
  '-iquote', '/',
  // Headers are checked on their own when you edit them; `#pragma once` is right there.
  '-Wno-pragma-once-outside-header',
];

const IDENT = /[A-Za-z0-9_]/;

function offsetOf(text: string, pos: Position): number {
  let offset = 0;
  for (let line = 0; line < pos.line; line++) {
    const nl = text.indexOf('\n', offset);
    if (nl < 0) return text.length;
    offset = nl + 1;
  }
  return Math.min(offset + pos.character, text.length);
}

function positionOf(text: string, offset: number): Position {
  const before = text.slice(0, offset);
  const line = before.split('\n').length - 1;
  return { line, character: offset - (before.lastIndexOf('\n') + 1) };
}

/** `file:line:col` for clang, with a 1-based byte column. */
function clangLoc(file: string, text: string, offset: number): string {
  const pos = positionOf(text, offset);
  const lineText = text.split('\n')[pos.line] ?? '';
  return `${file}:${pos.line + 1}:${utf16ToByteCol(lineText, pos.character)}`;
}

function wordAt(text: string, offset: number): { start: number; end: number } {
  let start = offset;
  while (start > 0 && IDENT.test(text[start - 1])) start--;
  let end = offset;
  while (end < text.length && IDENT.test(text[end])) end++;
  return { start, end };
}

/**
 * Finds the call whose argument list contains `offset`.
 * Returns the offset just after the `(` or `,` that starts the current argument.
 */
function enclosingCall(text: string, offset: number): { argStart: number; open: number } | null {
  let depth = 0;
  let lastComma = -1;
  for (let i = offset - 1; i >= 0 && offset - i < 4000; i--) {
    const ch = text[i];
    if (ch === '"' || ch === "'") {
      // Skip back over a string or char literal on this line.
      const lineStart = text.lastIndexOf('\n', i) + 1;
      const j = text.lastIndexOf(ch, i - 1);
      if (j >= lineStart) i = j;
      continue;
    }
    if (ch === ')' || ch === ']' || ch === '}') depth++;
    else if (ch === '(' || ch === '[' || ch === '{') {
      if (depth === 0) {
        if (ch !== '(') return null;
        return { open: i, argStart: (lastComma >= 0 ? lastComma : i) + 1 };
      }
      depth--;
    } else if (ch === ',' && depth === 0 && lastComma < 0) lastComma = i;
    else if (ch === ';' && depth === 0) return null;
  }
  return null;
}

/** Classes whose members are being completed: clang lists them as `Map : Map::` entries. */
function receiverClasses(entries: string[]): string[] {
  const out: string[] = [];
  for (const e of entries) {
    const m = e.match(/^([A-Z]\w*) : \1::$/);
    if (m) out.push(m[1]);
  }
  return out;
}

export class ClangService {
  /** Absolute path of the file being edited; its relative #includes resolve from its folder. */
  private main = MAIN;
  private stanfordNames: Set<string>;
  private docs: Map<string, StanfordDoc>;

  constructor(
    private readonly module: WebAssembly.Module,
    private readonly root: FsRoot,
    stanfordHeaders: Record<string, string>,
  ) {
    this.stanfordNames = new Set();
    for (const src of Object.values(stanfordHeaders)) for (const id of identifiersIn(src)) this.stanfordNames.add(id);
    this.docs = indexStanfordDocs(stanfordHeaders);
  }

  /** Stanford docs for `name`, looked up on the receiver's class first. */
  private docFor(name: string, classes: string[], member: boolean): string | undefined {
    for (const c of classes) {
      const d = this.docs.get(`${c}.${name}`);
      if (d) return docMarkdown(d);
    }
    const d = member ? undefined : this.docs.get(name);
    return d ? docMarkdown(d) : undefined;
  }

  /** Which workspace file `update` and requests are about, like `lib/list.cpp`. */
  setActive(path: string) {
    this.main = `/${path}`;
  }

  /** One clang process per request; the worker host runs them one at a time. */
  private run(text: string, extra: string[]) {
    writeFile(this.root, this.main, text);
    return runProcess(this.module, [...BASE_ARGS, ...extra, this.main], this.root);
  }

  async diagnose(text: string): Promise<Diagnostic[]> {
    const { stderr } = await this.run(text, [
      // Fix-its are only printed with caret diagnostics, so keep those on (the parser skips them).
      '-ferror-limit', '30', '-fdiagnostics-print-source-range-info', '-fdiagnostics-parseable-fixits',
    ]);
    return parseClangDiagnostics(stderr, this.main, text);
  }

  private async completeAt(text: string, offset: number, extra: string[] = []) {
    const { stdout } = await this.run(text, [
      `-code-completion-at=${clangLoc(this.main, text, offset)}`, '-code-completion-brief-comments', ...extra,
    ]);
    return splitCompletionOutput(stdout);
  }

  async complete(text: string, pos: Position): Promise<CompletionResult | null> {
    const offset = offsetOf(text, pos);
    const { start } = wordAt(text, offset);
    const before = text.slice(Math.max(0, start - 2), start);
    const memberAccess = before.endsWith('.') || before.endsWith('->');
    const qualified = before.endsWith('::');
    // Inside `#include "` or `<` there is nothing useful clang can add.
    const lineStart = text.lastIndexOf('\n', start - 1) + 1;
    const lineBefore = text.slice(lineStart, start);
    if (/^\s*#\s*include\b/.test(lineBefore)) return null;
    const { completions } = await this.completeAt(
      text,
      start,
      memberAccess || qualified ? [] : ['-code-completion-macros', '-code-completion-patterns'],
    );
    const items = toCompletionItems(completions, {
      memberAccess,
      localNames: identifiersIn(text.slice(0, start) + text.slice(offset)),
      stanfordNames: this.stanfordNames,
    });
    const classes = memberAccess ? receiverClasses(completions) : [];
    for (const item of items) {
      if (item.documentation || !this.stanfordNames.has(item.label)) continue;
      item.documentation = this.docFor(item.label, classes, memberAccess);
    }
    return { from: positionOf(text, start), items };
  }

  async signature(text: string, pos: Position): Promise<SignatureResult | null> {
    const offset = offsetOf(text, pos);
    const call = enclosingCall(text, offset);
    if (!call) return null;
    // Callee name must directly precede the `(` (skip `if (`, `for (`…).
    const callee = text.slice(0, call.open).match(/([A-Za-z_]\w*)\s*(?:<[^;()]*>)?\s*$/)?.[1];
    if (!callee || /^(if|for|while|switch|return|sizeof|catch|decltype|alignof)$/.test(callee)) return null;
    const { overloads } = await this.completeAt(text, call.argStart);
    if (!overloads.length) return null;
    const parsed = overloads.map(parseOverload);
    // Rank the overload whose current parameter clang marked first.
    let active = parsed.findIndex((p) => p.active != null);
    if (active < 0) active = 0;
    return {
      signatures: parsed.map((p) => ({ label: p.label, parameters: p.parameters })),
      active,
      activeParameter: parsed[active].active ?? null,
    };
  }

  async hover(text: string, pos: Position): Promise<HoverResult | null> {
    const offset = offsetOf(text, pos);
    const { start, end } = wordAt(text, offset);
    if (start === end || /^\d/.test(text[start])) return null;
    const name = text.slice(start, end);
    const range = { start: positionOf(text, start), end: positionOf(text, end) };
    let classes: string[] = [];
    const findIn = async (at: number) => {
      const { completions } = await this.completeAt(text, at, ['-code-completion-macros']);
      classes = receiverClasses(completions);
      return completions
        .map(parseCompletionLine)
        .filter((p) => p && p.name === name && !p.pattern) as NonNullable<ReturnType<typeof parseCompletionLine>>[];
    };
    let matches = await findIn(start);
    if (!matches.length) {
      // A declaration (`Vector<int> v;`) has no completion at its own name;
      // ask from the start of the next statement instead, where it is in scope.
      const nextLine = text.indexOf('\n', end);
      if (nextLine >= 0) {
        let at = nextLine + 1;
        while (at < text.length && (text[at] === ' ' || text[at] === '\t')) at++;
        matches = await findIn(at);
      }
    }
    if (!matches.length) return declarationHover(text, start, end, range);
    const before = text.slice(Math.max(0, start - 2), start);
    const member = before.endsWith('.') || before.endsWith('->');
    const p = matches[0];
    const kind = p.hasCall
      ? member ? 'method' : /^[A-Z][A-Z0-9_]+$/.test(name) && !p.result ? 'macro' : 'function'
      : p.isTemplate || (!p.result && /^[A-Z]/.test(name)) ? 'class'
        : member ? 'field' : p.result ? 'variable' : 'symbol';
    const code = matches
      .slice(0, 6)
      .map((m) => (m.result ? `${m.result} ` : '') + m.display)
      .join('\n');
    const docs = [...new Set(matches.map((m) => m.brief).filter(Boolean))];
    if (!docs.length && this.stanfordNames.has(name)) {
      const extra = this.docFor(name, member ? classes : [], member) ?? (kind === 'class' ? this.docFor(name, [], false) : undefined);
      if (extra) docs.push(extra);
    }
    return {
      kind: matches.length > 1 ? `${kind} · ${matches.length} overloads` : kind,
      code: kind === 'class' && !p.result && p.display === name ? `class ${name}` : code,
      markdown: docs.join('\n\n') || undefined,
      range,
    };
  }

  async definition(text: string, pos: Position): Promise<DefinitionTarget[] | null> {
    const offset = offsetOf(text, pos);
    const { start, end } = wordAt(text, offset);
    if (start === end) return null;
    const name = text.slice(start, end);
    const { stdout } = await this.run(text, ['-ast-dump=json', `-ast-dump-filter=${name}`]);
    const decls = splitJsonObjects(stdout);
    // Collect every declaration with exactly this name, with its file location.
    type Loc = { file: string; line: number; col: number };
    const found: Array<{ loc: Loc; kind: string; isDefinition: boolean }> = [];
    // The JSON dumper only prints `file` when it differs from the previously
    // printed location, so track the last one seen in document order.
    let lastFile = this.main;
    const see = (l?: AstLoc) => {
      const f = l?.file ?? l?.spellingLoc?.file ?? l?.expansionLoc?.file;
      if (f) lastFile = f;
    };
    const visit = (node: AstNode) => {
      see(node.loc);
      const loc = node.loc;
      const line = loc?.line ?? loc?.expansionLoc?.line;
      const col = loc?.col ?? loc?.expansionLoc?.col;
      if (node.name === name && typeof line === 'number' && /Decl$/.test(node.kind ?? '') && !node.isImplicit) {
        found.push({
          loc: { file: lastFile, line, col: col ?? 1 },
          kind: node.kind ?? '',
          isDefinition: !!node.inner?.some((n) => n.kind === 'CompoundStmt'),
        });
      }
      see(node.range?.begin);
      see(node.range?.end);
      for (const child of node.inner ?? []) visit(child);
    };
    for (const d of decls) visit(d);
    if (!found.length) return null;
    const lines = text.split('\n');
    // Prefer the nearest declaration above the cursor in the user's file.
    const local = found
      .filter((f) => f.loc.file === this.main)
      .sort((a, b) => Number(b.isDefinition) - Number(a.isDefinition) || a.loc.line - b.loc.line);
    const above = local.filter((f) => f.loc.line - 1 <= pos.line).pop();
    const pick = above ?? local[0];
    if (pick) {
      const l = pick.loc.line - 1;
      const c = byteColToUtf16(lines[l] ?? '', pick.loc.col);
      return [{ kind: 'local', range: { start: { line: l, character: c }, end: { line: l, character: c + name.length } } }];
    }
    const out: DefinitionTarget[] = [];
    for (const f of found.slice(0, 4)) {
      const bytes = readFile(this.root, f.loc.file);
      if (!bytes) continue;
      const fileLines = new TextDecoder().decode(bytes).split('\n');
      const first = Math.max(0, f.loc.line - 1 - 6);
      out.push({
        kind: 'external',
        path: f.loc.file.replace(/^\/(include\/c\+\+\/v1\/)?/, ''),
        line: f.loc.line - 1 - first,
        firstLine: first + 1,
        snippet: fileLines.slice(first, first + 16).join('\n'),
      });
    }
    return out.length ? out : null;
  }
}

/**
 * Hover over a name where it is declared (`int helper(int a)`), where clang
 * offers no completion: show the declaration itself plus the comment above it.
 */
function declarationHover(
  text: string,
  start: number,
  end: number,
  range: HoverResult['range'],
): HoverResult | null {
  const lineStart = text.lastIndexOf('\n', start - 1) + 1;
  const lineEnd = text.indexOf('\n', end);
  const lead = text.slice(lineStart, start);
  if (!/[\w>&*]\s+[&*]*$/.test(lead) || /\b(return|else|case|goto)\s+$/.test(lead)) return null;
  const line = text.slice(lineStart, lineEnd < 0 ? text.length : lineEnd);
  const code = line.replace(/\s*\{.*$/, '').replace(/\s*[;=].*$/, '').trim();
  if (!code) return null;
  const comments: string[] = [];
  const above = text.slice(0, lineStart).split('\n');
  above.pop();
  for (let i = above.length - 1; i >= 0; i--) {
    const l = above[i].trim();
    if (!/^(\/\/|\/\*|\*)/.test(l)) break;
    comments.unshift(l.replace(/^(\/\/+|\/\*+|\*\/|\*)\s?/, '').replace(/\*\/$/, ''));
  }
  return {
    kind: text.slice(end).trimStart().startsWith('(') ? 'function' : 'declaration',
    code,
    markdown: comments.join('\n').trim() || undefined,
    range,
  };
}

type AstLoc = {
  file?: string;
  line?: number;
  col?: number;
  spellingLoc?: { file?: string; line?: number; col?: number };
  expansionLoc?: { file?: string; line?: number; col?: number };
};

type AstNode = {
  kind?: string;
  name?: string;
  isImplicit?: boolean;
  loc?: AstLoc;
  range?: { begin?: AstLoc; end?: AstLoc };
  inner?: AstNode[];
};

/** `-ast-dump=json` with a filter prints one JSON object per match, back to back. */
function splitJsonObjects(s: string): AstNode[] {
  const out: AstNode[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inString) {
      if (c === '\\') i++;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === '{') {
      if (depth++ === 0) start = i;
    } else if (c === '}' && --depth === 0) {
      try {
        out.push(JSON.parse(s.slice(start, i + 1)));
      } catch {
        // A truncated dump; ignore that node.
      }
    }
  }
  return out;
}
