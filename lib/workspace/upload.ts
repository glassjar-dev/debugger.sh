/**
 * Turning uploaded files into workspace edits. Pure, so it can be tested without a browser;
 * `readUpload.ts` gets the files off the disk.
 */

import { LANGS, type Lang } from '@/components/constants';

import { entryFile, folders, LOCAL_LIMITS, workspaceChars, type Workspace } from './model';
import { dirname, joinPath, normalizePath } from './paths';

/** One uploaded text file, by its path relative to what was picked or dropped. */
export type Incoming = { path: string; text: string };
export type Skipped = { path: string; reason: string };

/** The largest single file read; anything bigger is almost never source code. */
export const MAX_UPLOAD_FILE_BYTES = 256 * 1024;

// Build output, dependencies and caches: never worth uploading, and often huge.
const IGNORED_FOLDERS = new Set(['node_modules', '__pycache__', 'target', 'build', 'dist', 'venv', 'env']);

/**
 * Paths left out without mention: hidden files and folders (`.git`, `.DS_Store`) and the
 * folders above. Checking a folder before reading it saves walking all of `node_modules`.
 */
export function isIgnored(path: string): boolean {
  return path
    .split('/')
    .some((segment) => segment.startsWith('.') || IGNORED_FOLDERS.has(segment) || segment.startsWith('cmake-build-'));
}

/** Source text as the editor keeps it: no byte-order mark, `\n` line endings. */
export function cleanText(text: string): string {
  return text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
}

export type UploadPlan = {
  /** The workspace that changes. It can differ from the one on screen (see `planUpload`). */
  lang: Lang;
  ws: Workspace;
  added: string[];
  replaced: string[];
  skipped: Skipped[];
  /** The folder whose contents were spread into the workspace root, if any. */
  unwrapped: string | null;
};

const LANG_IDS = Object.keys(LANGS) as Lang[];

/** A folder name made acceptable, for the top folder of an upload (no code refers to it). */
function tidyName(name: string): string | null {
  const tidy = name
    .replace(/\s*[^A-Za-z0-9_+.\- ]+\s*/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-. ]+|[-. ]+$/g, '');
  return normalizePath(tidy);
}

/**
 * Where `incoming` goes when added under `target` (a folder, or '' for the root).
 *
 * - A single uploaded folder that holds a program (a `main.cpp`, `main.py` or `main.rs`)
 *   becomes the workspace root when uploaded there, rather than a folder inside it.
 * - When the root ends up with another language's entry file but not this one's, the
 *   files belong to that language: uploading a C++ project while on Python adds it to C++.
 * - Existing files with the same path are replaced. Paths that can't be workspace paths,
 *   and files past the workspace's limits, are skipped with a reason.
 */
export function planUpload(
  workspaces: Readonly<Record<Lang, Workspace>>,
  lang: Lang,
  incoming: readonly Incoming[],
  target: string,
): UploadPlan {
  let items = incoming.map((item) => ({ ...item, path: item.path.replace(/\\/g, '/').replace(/^\/+/, '') }));

  // Everything inside one top folder: an uploaded folder.
  const tops = new Set(items.map((item) => item.path.split('/')[0]));
  const top = tops.size === 1 && items.every((item) => item.path.includes('/')) ? [...tops][0] : null;

  let unwrapped: string | null = null;
  if (top && target === '') {
    const inside = new Set(items.map((item) => item.path.slice(top.length + 1)));
    if (LANG_IDS.some((l) => inside.has(entryFile(l)))) {
      unwrapped = top;
      items = items.map((item) => ({ ...item, path: item.path.slice(top.length + 1) }));
    }
  }
  if (top && !unwrapped) {
    // Its own name may hold characters paths don't allow, like `HW 3 (final)`.
    const name = tidyName(top);
    if (name && name !== top) items = items.map((item) => ({ ...item, path: name + item.path.slice(top.length) }));
  }

  let into = lang;
  if (target === '') {
    const atRoot = new Set(items.map((item) => item.path));
    if (!atRoot.has(entryFile(lang))) into = LANG_IDS.find((l) => atRoot.has(entryFile(l))) ?? lang;
  }

  const before = workspaces[into];
  const files: Record<string, string> = { ...before.files };
  let chars = workspaceChars(before);
  const added: string[] = [];
  const replaced: string[] = [];
  const skipped: Skipped[] = [];
  const seen = new Set<string>();

  for (const item of items) {
    const path = normalizePath(joinPath(target, item.path));
    if (!path) {
      skipped.push({ path: item.path, reason: 'name has unsupported characters' });
      continue;
    }
    if (seen.has(path)) continue;
    seen.add(path);
    const now: Workspace = { files, dirs: before.dirs };
    if (folders(now).has(path)) {
      skipped.push({ path, reason: 'a folder has this name' });
      continue;
    }
    // A file standing where this one needs a folder, like `lib` for `lib/list.h`.
    let blocked: string | null = null;
    for (let dir = dirname(path); dir; dir = dirname(dir)) if (Object.hasOwn(files, dir)) blocked = dir;
    if (blocked) {
      skipped.push({ path, reason: `${blocked} is a file` });
      continue;
    }
    const existing = Object.hasOwn(files, path) ? files[path] : null;
    const nextChars = chars - (existing?.length ?? 0) + item.text.length;
    const nextCount = Object.keys(files).length + (existing == null ? 1 : 0);
    if (nextChars > LOCAL_LIMITS.chars || nextCount > LOCAL_LIMITS.files) {
      skipped.push({ path, reason: 'workspace is full' });
      continue;
    }
    if (existing === item.text) continue;
    files[path] = item.text;
    chars = nextChars;
    (existing == null ? added : replaced).push(path);
  }

  const ws: Workspace = { files, dirs: before.dirs.filter((d) => !Object.keys(files).some((p) => p.startsWith(`${d}/`))) };
  return { lang: into, ws, added, replaced, skipped, unwrapped };
}
