/**
 * Detect PROVIDED_TEST / STUDENT_TEST, rewrite macros with stable keys,
 * rename user main → original_main (normalized to argc/argv),
 * and assemble the filesystem overlay for a test run.
 *
 * SimpleTest.h is always available via the Stanford support FS (like map.h).
 * This module only rewrites + injects the runner when live tests are present.
 */

import { simpleTestRunner } from '@/cs106b/generated/simpleTestRunner';

export type PreparedCppRun = {
  /** The workspace files for engine.fs (besides Stanford headers), rewritten where tests need it. */
  files: Record<string, string>;
  /** Absolute virtual paths of every C++ source to compile. */
  sources: string[];
  /** Whether this run uses the injected test runner as the entrypoint. */
  hasTests: boolean;
  nonce: string;
};

type SourceToken = { value: string; start: number; end: number };

function isIdentifierStart(character: string): boolean {
  return /[A-Za-z_]/.test(character);
}
function isIdentifierPart(character: string): boolean {
  return /[A-Za-z0-9_]/.test(character);
}

function quotedLiteralEnd(source: string, start: number, quote: '"' | "'"): number {
  let index = start + 1;
  while (index < source.length) {
    if (source[index] === '\\') {
      index += 2;
      continue;
    }
    if (source[index] === quote) return index + 1;
    index += 1;
  }
  return source.length;
}

function rawStringLiteralEnd(source: string, start: number): number | undefined {
  const prefixes = ['u8R"', 'uR"', 'UR"', 'LR"', 'R"'] as const;
  const prefix = prefixes.find((candidate) => source.startsWith(candidate, start));
  if (!prefix) return undefined;
  const delimiterStart = start + prefix.length;
  const openingParen = source.indexOf('(', delimiterStart);
  if (openingParen === -1 || openingParen - delimiterStart > 16) return source.length;
  const delimiter = source.slice(delimiterStart, openingParen);
  if (/[\s()\\]/.test(delimiter)) return source.length;
  const terminator = `)${delimiter}"`;
  const close = source.indexOf(terminator, openingParen + 1);
  return close === -1 ? source.length : close + terminator.length;
}

function logicalLineEnd(source: string, start: number): number {
  let index = start;
  while (index < source.length) {
    const newline = source.indexOf('\n', index);
    if (newline === -1) return source.length;
    let beforeNewline = newline - 1;
    if (beforeNewline >= start && source[beforeNewline] === '\r') beforeNewline -= 1;
    if (beforeNewline < start || source[beforeNewline] !== '\\') return newline + 1;
    index = newline + 1;
  }
  return source.length;
}

function isAtLogicalLineStart(source: string, index: number): boolean {
  const lineStart = source.lastIndexOf('\n', index - 1) + 1;
  return /^[\t\v\f ]*$/.test(source.slice(lineStart, index));
}

export function tokenizeCpp(source: string): SourceToken[] {
  const tokens: SourceToken[] = [];
  let index = 0;
  while (index < source.length) {
    const character = source[index];
    if (/\s/.test(character)) {
      index += 1;
      continue;
    }
    if (source.startsWith('//', index)) {
      index = logicalLineEnd(source, index + 2);
      continue;
    }
    if (source.startsWith('/*', index)) {
      const close = source.indexOf('*/', index + 2);
      index = close === -1 ? source.length : close + 2;
      continue;
    }
    if (character === '#' && isAtLogicalLineStart(source, index)) {
      index = logicalLineEnd(source, index + 1);
      continue;
    }
    const rawStringEnd = rawStringLiteralEnd(source, index);
    if (rawStringEnd !== undefined) {
      tokens.push({ value: source.slice(index, rawStringEnd), start: index, end: rawStringEnd });
      index = rawStringEnd;
      continue;
    }
    if (/[0-9]/.test(character) || (character === '.' && /[0-9]/.test(source[index + 1] ?? ''))) {
      const start = index++;
      while (index < source.length) {
        const next = source[index];
        if (
          /[A-Za-z0-9_.]/.test(next) ||
          (next === "'" && /[A-Za-z0-9]/.test(source[index + 1] ?? '')) ||
          ((next === '+' || next === '-') && /[eEpP]/.test(source[index - 1]))
        ) {
          index++;
        } else break;
      }
      tokens.push({ value: source.slice(start, index), start, end: index });
      continue;
    }
    if (character === '"' || character === "'") {
      const end = quotedLiteralEnd(source, index, character);
      tokens.push({ value: source.slice(index, end), start: index, end });
      index = end;
      continue;
    }
    if (isIdentifierStart(character)) {
      const start = index;
      index += 1;
      while (index < source.length && isIdentifierPart(source[index])) index += 1;
      tokens.push({ value: source.slice(start, index), start, end: index });
      continue;
    }
    tokens.push({ value: character, start: index, end: index + 1 });
    index += 1;
  }
  return tokens;
}

function testKey(value: string): string {
  let a = 2166136261;
  let b = 3339675911;
  for (const byte of new TextEncoder().encode(value)) {
    a = Math.imul(a ^ byte, 16777619) >>> 0;
    b = Math.imul(b ^ byte, 16777619) >>> 0;
  }
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
}

function literalName(tokens: readonly SourceToken[]): string | undefined {
  let result = '';
  for (const token of tokens) {
    const raw = /^(?:u8|u|U|L)?R"([^ ()\\\t\r\n]{0,16})\(([\s\S]*)\)\1"$/.exec(token.value);
    if (raw) {
      result += raw[2];
      continue;
    }
    if (!/^"[\s\S]*"$/.test(token.value)) return undefined;
    try {
      result += JSON.parse(token.value) as string;
    } catch {
      return undefined;
    }
  }
  return result || undefined;
}

type Declaration = {
  edits: { start: number; end: number; text: string }[];
};

function declarations(path: string, source: string): Declaration[] {
  const tokens = tokenizeCpp(source);
  const ordinals = new Map<number, number>();
  const found: Declaration[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const macro = tokens[i];
    if (!['STUDENT_TEST', 'PROVIDED_TEST'].includes(macro.value) || tokens[i + 1]?.value !== '(') continue;
    let depth = 1;
    let end = i + 2;
    for (; end < tokens.length; end++) {
      if (tokens[end].value === '(') depth++;
      if (tokens[end].value === ')' && --depth === 0) break;
    }
    if (end >= tokens.length) continue;
    const line = source.slice(0, macro.start).split('\n').length;
    const ordinal = ordinals.get(line) ?? 0;
    ordinals.set(line, ordinal + 1);
    const origin = macro.value === 'STUDENT_TEST' ? 'student' : 'provided';
    const name = literalName(tokens.slice(i + 2, end)) ?? `Test at ${path.split('/').pop()}:${line}`;
    const key = testKey(`${path}\n${line}\n${ordinal}\n${origin}\n${name}`);
    found.push({
      edits: [
        { start: macro.start, end: macro.end, text: 'SIMPLETEST_KEY' },
        { start: tokens[i + 1].end, end: tokens[i + 1].end, text: `"${key}",` },
        { start: tokens[end].start, end: tokens[end].start, text: `,"${origin}"` },
      ],
    });
    i = end;
  }
  return found;
}

/** Rename `main` → `original_main(int argc, char** argv)` so the runner can call it. */
function hideUserMain(source: string): { source: string; hadMain: boolean } {
  const tokens = tokenizeCpp(source);
  const scopes: boolean[] = [];
  const mainTokens: { name: SourceToken; open: SourceToken; close: SourceToken }[] = [];
  tokens.forEach((token, index) => {
    if (token.value === '{') {
      scopes.push(
        tokens[index - 2]?.value === 'extern' && ['"C"', '"C++"'].includes(tokens[index - 1]?.value ?? ''),
      );
    } else if (token.value === '}') scopes.pop();
    else if (
      token.value === 'main' &&
      scopes.every((linkage) => linkage) &&
      ['int', 'void', 'auto', 'signed'].includes(tokens[index - 1]?.value ?? '') &&
      tokens[index + 1]?.value === '('
    ) {
      let depth = 1;
      let end = index + 2;
      for (; end < tokens.length; end++) {
        if (tokens[end].value === '(') depth++;
        if (tokens[end].value === ')' && --depth === 0) break;
      }
      if (end < tokens.length) {
        mainTokens.push({ name: token, open: tokens[index + 1], close: tokens[end] });
      }
    }
  });
  if (mainTokens.length === 0) return { source, hadMain: false };

  let renamed = source;
  for (const { name, open, close } of [...mainTokens].reverse()) {
    renamed =
      renamed.slice(0, name.start) +
      'original_main' +
      renamed.slice(name.end, open.end) +
      'int argc, char** argv' +
      renamed.slice(close.start);
  }
  // Keep line numbers identical to the editor; callers wrap with `#line 1 "/…"`.
  return { source: renamed, hadMain: true };
}

function makeConfig(nonce: string, hasUserMain: boolean): string {
  return [
    `#define SIMPLETEST_NONCE "${nonce}"`,
    `#define SIMPLETEST_ALL true`,
    `#define SIMPLETEST_SELECTION std::vector<std::string>{}`,
    `#define DEBUGGER_HAS_USER_MAIN ${hasUserMain ? 1 : 0}`,
    '',
  ].join('\n');
}

function randomNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** True when the student source declares at least one SimpleTest block. */
export function sourceHasTests(source: string): boolean {
  return declarations('/main.c', source).length > 0;
}

/** C++ sources the engine compiles; headers and data files ride along. */
function isCppSource(path: string): boolean {
  return /\.(c|cc|cp|cpp|cxx|c\+\+)$/i.test(path);
}

/**
 * Prepare a C/C++ workspace for a Run. When any file has tests, rewrites their macros in
 * every file, renames the user's main in the file that defines it and appends the runner
 * there, so the runner calls main and then the tests. Paths are workspace-relative
 * (`main.cpp`, `lib/list.cpp`); `sources` lists the absolute paths to compile.
 * SimpleTest.h itself always comes from the Stanford support FS.
 */
export function prepareCppRun(
  workspace: Readonly<Record<string, string>>,
  entry = 'main.cpp',
): PreparedCppRun {
  const paths = Object.keys(workspace).filter(isCppSource).sort();
  const sources = paths.map((p) => `/${p}`);
  const tests = new Map(paths.map((p) => [p, declarations(`/${p}`, workspace[p]!)] as const));
  if (![...tests.values()].some((found) => found.length > 0)) {
    return { files: { ...workspace }, sources, hasTests: false, nonce: '' };
  }

  const nonce = randomNonce();
  // The runner goes where main is (it calls it), or into the entry file when nothing defines main.
  const mainFile = paths.find((p) => hideUserMain(workspace[p]!).hadMain) ?? (paths.includes(entry) ? entry : paths[0]!);
  const files: Record<string, string> = { ...workspace };
  let hadMain = false;
  for (const path of paths) {
    const found = tests.get(path)!;
    if (found.length === 0 && path !== mainFile) continue;
    const edits = found.flatMap((f) => f.edits).sort((a, b) => b.start - a.start);
    let transformed = workspace[path]!;
    for (const edit of edits) {
      transformed = transformed.slice(0, edit.start) + edit.text + transformed.slice(edit.end);
    }
    const lines = [
      '#pragma clang diagnostic push',
      '#pragma clang diagnostic ignored "-Wreturn-type"',
      '#pragma clang diagnostic ignored "-Wunused-parameter"',
      // DAP breakpoints use the absolute virtual path, and the engine matches DWARF paths
      // exactly, so `#line` must name that same path to keep breakpoints hitting.
      `#line 1 "/${path}"`,
    ];
    if (path === mainFile) {
      const hidden = hideUserMain(transformed);
      hadMain = hidden.hadMain;
      // Fold the tiny runner into this TU. SimpleTest.cpp lives in the precompiled CS106B
      // archive (run.a / debug.a), so tests add no extra clang invocation.
      const runnerBody = simpleTestRunner.replace(/^#include\s+"SimpleTest(?:_config)?\.h"\s*\n/gm, '');
      files[path] = [...lines, hidden.source, '#pragma clang diagnostic pop', '', '#include "SimpleTest_config.h"', runnerBody].join('\n');
    } else {
      files[path] = [...lines, transformed, '#pragma clang diagnostic pop', ''].join('\n');
    }
  }
  // Header is already in the Stanford FS; only the per-run config is injected.
  files['SimpleTest_config.h'] = makeConfig(nonce, hadMain);
  return { files, sources, hasTests: true, nonce };
}
