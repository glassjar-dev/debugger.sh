'use client';

/**
 * Reading what someone picked or dropped into `Incoming` text files. Binary and oversized
 * files are skipped with a reason; hidden files and build folders silently (`isIgnored`).
 */

import { cleanText, isIgnored, MAX_UPLOAD_FILE_BYTES, type Incoming, type Skipped } from './upload';

export type Found = { path: string; file: File };

/** Stop walking a dropped folder after this many files; the workspace can't hold more anyway. */
const MAX_FOUND = 2000;

/** Files from an `<input type="file">`, with folder structure when it picked a folder. */
export function fromInput(list: FileList): Found[] {
  return Array.from(list, (file) => ({ path: file.webkitRelativePath || file.name, file }));
}

/** True when a drag carries files from the desktop (not a tab or a tree row). */
export function hasFiles(dt: DataTransfer | null): boolean {
  return !!dt && Array.from(dt.types).includes('Files');
}

/**
 * Files and folders dropped from the desktop. The entries must be taken during the drop
 * event itself; reading them can happen after.
 */
export function fromDrop(dt: DataTransfer): Promise<Found[]> {
  const entries = Array.from(dt.items)
    .filter((item) => item.kind === 'file')
    .map((item) => item.webkitGetAsEntry?.())
    .filter((entry): entry is FileSystemEntry => !!entry);
  if (entries.length === 0) return Promise.resolve(fromInput(dt.files));
  return walk(entries);
}

async function walk(roots: FileSystemEntry[]): Promise<Found[]> {
  const found: Found[] = [];
  const visit = async (entry: FileSystemEntry, path: string): Promise<void> => {
    if (found.length >= MAX_FOUND || isIgnored(path)) return;
    if (entry.isFile) {
      const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject));
      found.push({ path, file });
    } else if (entry.isDirectory) {
      for (const child of await readAll(entry as FileSystemDirectoryEntry)) await visit(child, `${path}/${child.name}`);
    }
  };
  for (const root of roots) await visit(root, root.name);
  return found;
}

/** A folder's entries; `readEntries` hands them over in batches until an empty one. */
async function readAll(dir: FileSystemDirectoryEntry): Promise<FileSystemEntry[]> {
  const reader = dir.createReader();
  const all: FileSystemEntry[] = [];
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
    if (batch.length === 0) return all;
    all.push(...batch);
  }
}

/** The text of every readable source file, and why the others were left out. */
export async function readTexts(found: readonly Found[]): Promise<{ incoming: Incoming[]; skipped: Skipped[] }> {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const incoming: Incoming[] = [];
  const skipped: Skipped[] = [];
  for (const { path, file } of found) {
    if (isIgnored(path)) continue;
    if (file.size > MAX_UPLOAD_FILE_BYTES) {
      skipped.push({ path, reason: 'too large' });
      continue;
    }
    try {
      const text = decoder.decode(await file.arrayBuffer());
      if (text.includes('\0')) throw new Error('binary');
      incoming.push({ path, text: cleanText(text) });
    } catch {
      skipped.push({ path, reason: 'not a text file' });
    }
  }
  return { incoming, skipped };
}
