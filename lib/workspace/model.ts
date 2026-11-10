/**
 * A language's workspace: its files and any empty folders. Pure functions only, shared by
 * the browser store and the Worker's share validation, so keep it free of DOM imports.
 */

import { LANGS, type Lang } from '@/components/constants';

import { basename, dirname, extname, isWithin, joinPath, normalizePath } from './paths';

export type Workspace = {
  /** File contents by path. */
  files: Readonly<Record<string, string>>;
  /** Folders that exist without files in them yet. Folders holding files are implied. */
  dirs: readonly string[];
};

export const MAX_FILES = 64;
/** Total characters across all files, which keeps a workspace shareable. */
export const MAX_WORKSPACE_CHARS = 100_000;

/** The file a run starts from. It can't be renamed or deleted. */
export function entryFile(lang: Lang): string {
  return LANGS[lang].fsKey;
}

export function defaultWorkspace(lang: Lang): Workspace {
  return { files: { [entryFile(lang)]: LANGS[lang].defaultCode }, dirs: [] };
}

export function workspaceChars(ws: Workspace): number {
  let total = 0;
  for (const text of Object.values(ws.files)) total += text.length;
  return total;
}

/** Validate an untrusted workspace (storage or a share). Bad paths make the whole thing invalid. */
export function parseWorkspace(value: unknown, lang: Lang): Workspace | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as { files?: unknown; dirs?: unknown };
  if (!record.files || typeof record.files !== 'object' || Array.isArray(record.files)) return null;
  const files: Record<string, string> = {};
  const entries = Object.entries(record.files as Record<string, unknown>);
  if (entries.length === 0 || entries.length > MAX_FILES) return null;
  for (const [raw, text] of entries) {
    const path = normalizePath(raw);
    if (!path || path !== raw || typeof text !== 'string' || Object.hasOwn(files, path)) return null;
    files[path] = text;
  }
  if (!Object.hasOwn(files, entryFile(lang))) return null;
  const dirs: string[] = [];
  if (record.dirs !== undefined) {
    if (!Array.isArray(record.dirs) || record.dirs.length > MAX_FILES) return null;
    for (const raw of record.dirs) {
      const path = typeof raw === 'string' ? normalizePath(raw) : null;
      if (!path || path !== raw || Object.hasOwn(files, path)) return null;
      dirs.push(path);
    }
  }
  const ws = { files, dirs };
  if (workspaceChars(ws) > MAX_WORKSPACE_CHARS) return null;
  for (const path of Object.keys(files)) if (isFolder(ws, path)) return null;
  return ws;
}

/** Every folder in the workspace: explicit ones and the parents of every file. */
export function folders(ws: Workspace): Set<string> {
  const out = new Set<string>();
  const add = (path: string) => {
    for (let dir = path; dir; dir = dirname(dir)) out.add(dir);
  };
  for (const dir of ws.dirs) add(dir);
  for (const path of Object.keys(ws.files)) add(dirname(path));
  return out;
}

export function isFolder(ws: Workspace, path: string): boolean {
  return folders(ws).has(path);
}

export function exists(ws: Workspace, path: string): boolean {
  return Object.hasOwn(ws.files, path) || isFolder(ws, path);
}

// ---------------------------------------------------------------------------
// Edits. Each returns the new workspace, or an error message the UI shows as-is.
// ---------------------------------------------------------------------------

export type EditResult = { ok: true; ws: Workspace } | { ok: false; error: string };

function checkNew(ws: Workspace, raw: string): { ok: true; path: string } | { ok: false; error: string } {
  const path = normalizePath(raw);
  if (!path) return { ok: false, error: 'Use letters, numbers, dots, dashes and underscores' };
  if (exists(ws, path)) return { ok: false, error: `${basename(path)} already exists` };
  if (Object.hasOwn(ws.files, dirname(path))) return { ok: false, error: `${dirname(path)} is a file` };
  return { ok: true, path };
}

export function createFile(ws: Workspace, raw: string, text = ''): EditResult {
  const checked = checkNew(ws, raw);
  if (!checked.ok) return checked;
  if (Object.keys(ws.files).length >= MAX_FILES) return { ok: false, error: `At most ${MAX_FILES} files` };
  return {
    ok: true,
    ws: { files: { ...ws.files, [checked.path]: text }, dirs: ws.dirs.filter((d) => !isWithin(checked.path, d)) },
  };
}

export function createFolder(ws: Workspace, raw: string): EditResult {
  const checked = checkNew(ws, raw);
  if (!checked.ok) return checked;
  return { ok: true, ws: { files: ws.files, dirs: [...ws.dirs, checked.path] } };
}

export function writeFile(ws: Workspace, path: string, text: string): Workspace {
  if (ws.files[path] === text) return ws;
  return { files: { ...ws.files, [path]: text }, dirs: ws.dirs };
}

/** Rename or move a file or folder (with everything inside it). */
export function renamePath(ws: Workspace, from: string, raw: string, entry: string): EditResult {
  const to = normalizePath(raw);
  if (!to) return { ok: false, error: 'Use letters, numbers, dots, dashes and underscores' };
  if (to === from) return { ok: true, ws };
  if (isWithin(entry, from)) return { ok: false, error: `${entry} is where runs start, so it stays put` };
  if (isWithin(to, from)) return { ok: false, error: 'A folder can’t move inside itself' };
  if (exists(ws, to)) return { ok: false, error: `${basename(to)} already exists` };
  if (Object.hasOwn(ws.files, dirname(to))) return { ok: false, error: `${dirname(to)} is a file` };
  const move = (path: string) => (isWithin(path, from) ? to + path.slice(from.length) : path);
  const files: Record<string, string> = {};
  for (const [path, text] of Object.entries(ws.files)) files[move(path)] = text;
  return { ok: true, ws: { files, dirs: ws.dirs.map(move) } };
}

export function deletePath(ws: Workspace, path: string, entry: string): EditResult {
  if (isWithin(entry, path)) return { ok: false, error: `${entry} is where runs start, so it can’t be deleted` };
  const files: Record<string, string> = {};
  for (const [p, text] of Object.entries(ws.files)) if (!isWithin(p, path)) files[p] = text;
  const dirs = ws.dirs.filter((d) => !isWithin(d, path));
  // Keep the parent folder visible after its last child goes.
  const parent = dirname(path);
  const ws2 = { files, dirs };
  if (parent && !isFolder(ws2, parent)) dirs.push(parent);
  return { ok: true, ws: ws2 };
}

/** Where `path` lands when `from` moves to `to`, for anything keyed by path (tabs, breakpoints). */
export function movedPath(path: string, from: string, to: string): string {
  return isWithin(path, from) ? to + path.slice(from.length) : path;
}

// ---------------------------------------------------------------------------
// Tree for the explorer
// ---------------------------------------------------------------------------

export type TreeNode =
  | { kind: 'folder'; name: string; path: string; children: TreeNode[] }
  | { kind: 'file'; name: string; path: string };

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** Folders first, then files, each in natural order (file2 before file10). */
export function buildTree(paths: readonly string[], dirs: Iterable<string>): TreeNode[] {
  const root: TreeNode[] = [];
  const byPath = new Map<string, TreeNode[]>([['', root]]);
  const ensureFolder = (path: string): TreeNode[] => {
    const existing = byPath.get(path);
    if (existing) return existing;
    const children: TreeNode[] = [];
    byPath.set(path, children);
    ensureFolder(dirname(path)).push({ kind: 'folder', name: basename(path), path, children });
    return children;
  };
  for (const dir of dirs) ensureFolder(dir);
  for (const path of paths) ensureFolder(dirname(path)).push({ kind: 'file', name: basename(path), path });
  const sort = (nodes: TreeNode[]) => {
    nodes.sort((a, b) => (a.kind === b.kind ? collator.compare(a.name, b.name) : a.kind === 'folder' ? -1 : 1));
    for (const n of nodes) if (n.kind === 'folder') sort(n.children);
  };
  sort(root);
  return root;
}

/** Files a language's compiler builds on its own (headers and data files ride along). */
export function isCompiledSource(lang: Lang, path: string): boolean {
  const ext = extname(path);
  if (lang === 'c') return ['c', 'cc', 'cp', 'cpp', 'cxx', 'c++'].includes(ext);
  if (lang === 'rust') return ext === 'rs';
  return ext === 'py';
}

/** A sensible starting text for a new file, by extension. */
export function starterText(path: string): string {
  const ext = extname(path);
  return ext === 'h' || ext === 'hpp' ? '#pragma once\n\n' : '';
}

export { joinPath };
