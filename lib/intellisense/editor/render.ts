/**
 * DOM builders shared by the completion docs panel, hover cards, signature
 * help and the definition peek: syntax-highlighted code (with the editor's
 * own Lezer parser + highlight style) and a small, safe Markdown renderer.
 */

import type { Parser } from '@lezer/common';
import { highlightCode, type Highlighter } from '@lezer/highlight';
import type { CompletionKind } from '../types';

export type CodeRenderer = (code: string, into?: HTMLElement) => HTMLElement;

export function makeCodeRenderer(parser: Parser, highlighter: Highlighter): CodeRenderer {
  return (code, into = document.createElement('div')) => {
    into.classList.add('gj-code');
    try {
      const tree = parser.parse(code);
      highlightCode(
        code,
        tree,
        highlighter,
        (text, classes) => {
          if (!classes) into.append(text);
          else {
            const span = document.createElement('span');
            span.className = classes;
            span.textContent = text;
            into.append(span);
          }
        },
        () => into.append('\n'),
      );
    } catch {
      into.textContent = code;
    }
    return into;
  };
}

/**
 * Highlights a multi-line snippet as one unit (so block comments stay
 * comments) and returns one element per line. A snippet that starts inside a
 * `/* … *\/` comment gets a synthetic opener so it highlights correctly.
 */
export function makeLineRenderer(parser: Parser, highlighter: Highlighter) {
  return (code: string): HTMLElement[] => {
    const lines: HTMLElement[] = [];
    let line = document.createElement('span');
    const opener = /^\s*\*(?!\/)/.test(code) && !/^\s*\*\s*\w+\s*[=(;]/.test(code) ? '/*\n' : '';
    let skip = opener.length;
    const put = (text: string, classes: string) => {
      if (skip > 0) {
        const cut = Math.min(skip, text.length);
        skip -= cut;
        text = text.slice(cut);
        if (!text) return;
      }
      if (!classes) line.append(text);
      else {
        const span = document.createElement('span');
        span.className = classes;
        span.textContent = text;
        line.append(span);
      }
    };
    try {
      const source = opener + code;
      highlightCode(source, parser.parse(source), highlighter, put, () => {
        if (skip > 0) {
          skip--;
          return;
        }
        lines.push(line);
        line = document.createElement('span');
      });
    } catch {
      return code.split('\n').map((t) => {
        const span = document.createElement('span');
        span.textContent = t;
        return span;
      });
    }
    lines.push(line);
    return lines;
  };
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
};

const ENTITIES: Record<string, string> = { nbsp: '\u00a0', lt: '<', gt: '>', amp: '&', quot: '"', '#39': "'" };

/** Markdown backslash escapes and the few HTML entities docstring converters emit. */
function decode(text: string): string {
  return text
    .replace(/\\([\\`*_{}[\]()#+\-.!|<>~])/g, '$1')
    .replace(/&(nbsp|lt|gt|amp|quot|#39);/g, (_m, name: string) => ENTITIES[name]);
}

/** Inline Markdown: `code`, **bold**, *em*, [links](https://…). Everything else is text. */
function inline(text: string, into: HTMLElement) {
  // Escaped markers (`\*`) are text; `snake_case` is not emphasis.
  const re =
    /(`+)([\s\S]*?)\1|(?<!\\)\*\*([^*]+?)(?<!\\)\*\*|(?<!\\)\*([^*\s][^*]*?)(?<!\\)\*|(?<![\\\w])_([^_\s][^_]*?)_(?!\w)|\[([^\]]+)\]\(([^)\s]+)\)/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index! > last) into.append(decode(text.slice(last, m.index)));
    if (m[2] != null) into.append(el('code', 'gj-md-code', m[2]));
    else if (m[3] != null) into.append(el('strong', undefined, decode(m[3])));
    else if (m[4] != null || m[5] != null) into.append(el('em', undefined, decode(m[4] ?? m[5])));
    else if (m[6] != null) {
      const href = m[7];
      if (/^https?:\/\//.test(href)) {
        const a = el('a', 'gj-md-link');
        inline(m[6], a);
        a.href = href;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        into.append(a);
      } else inline(m[6], into); // intra-doc links (rustdoc) have nowhere to go
    }
    last = m.index! + m[0].length;
  }
  if (last < text.length) into.append(decode(text.slice(last)));
}

/**
 * Block Markdown: fenced code (highlighted when the fence names the file's
 * language), headings, lists, rules, paragraphs. Rustdoc's hidden `# ` lines
 * in code are dropped.
 */
export function renderMarkdown(md: string, code: CodeRenderer, lang: string): HTMLElement {
  const root = el('div', 'gj-md');
  const lines = md.replace(/\r/g, '').split('\n');
  let para: string[] = [];
  let list: HTMLElement | null = null;
  const flush = () => {
    if (para.length) {
      const p = el('p');
      inline(para.join(' '), p);
      root.append(p);
      para = [];
    }
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = line.match(/^\s*(```+|~~~+)\s*([\w+-]*)/);
    if (fence) {
      flush();
      list = null;
      const body: string[] = [];
      for (i++; i < lines.length && !lines[i].trimStart().startsWith(fence[1]); i++) body.push(lines[i]);
      const fenceLang = fence[2] || lang;
      const text = body
        .filter((l) => !(fenceLang === 'rust' || fenceLang === '') || !/^\s*#(\s|$)/.test(l))
        .join('\n');
      const pre = el('pre', 'gj-md-pre');
      if (!fence[2] || fence[2] === lang || (lang === 'cpp' && /^c(\+\+|pp)?$/.test(fence[2]))) code(text, pre);
      else pre.textContent = text;
      root.append(pre);
      continue;
    }
    if (/^\s*$/.test(line)) {
      flush();
      list = null;
      continue;
    }
    if (/^\s*(---+|\*\*\*+)\s*$/.test(line)) {
      flush();
      list = null;
      root.append(el('hr'));
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flush();
      list = null;
      const h = el('div', 'gj-md-h');
      inline(heading[2], h);
      root.append(h);
      continue;
    }
    const item = line.match(/^\s*(?:[-*+]|\d+\.)\s+(.*)$/);
    if (item) {
      flush();
      if (!list) {
        list = el('ul');
        root.append(list);
      }
      const li = el('li');
      inline(item[1], li);
      list.append(li);
      continue;
    }
    if (list && /^\s{2,}\S/.test(line)) {
      inline(' ' + line.trim(), list.lastElementChild as HTMLElement);
      continue;
    }
    list = null;
    para.push(line.trim());
  }
  flush();
  return root;
}

/** One glyph per kind; colors come from theme.ts (`.gj-kind-<kind>`). */
export const KIND_GLYPH: Record<CompletionKind, string> = {
  function: 'ƒ',
  method: 'm',
  constructor: 'c',
  field: '◇',
  property: '◇',
  variable: 'x',
  class: 'C',
  struct: 'S',
  enum: 'E',
  member: 'e',
  interface: 'T',
  module: '{}',
  namespace: '::',
  keyword: 'k',
  snippet: '⌘',
  constant: 'π',
  macro: '#',
  type: 't',
  text: '·',
};

export function kindLabel(kind: CompletionKind): string {
  return kind === 'interface' ? 'trait' : kind === 'member' ? 'variant' : kind;
}

export function kindIcon(kind: CompletionKind): HTMLElement {
  const icon = el('span', `gj-kind gj-kind-${kind}`, KIND_GLYPH[kind] ?? '·');
  icon.setAttribute('aria-hidden', 'true');
  return icon;
}

export { el };
