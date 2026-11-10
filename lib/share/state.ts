import { LANGS, type Lang } from '@/components/constants';
import { parseDockState } from '@/components/dock/types';
import { entryFile, MAX_WORKSPACE_CHARS, parseWorkspace } from '@/lib/workspace/model';

import type { WorkspaceState } from './types';

// Shared by the browser and the Worker, so it must stay free of DOM and React imports.

/** Total characters across a shared workspace's files. */
export const MAX_SHARE_CODE_CHARS = MAX_WORKSPACE_CHARS;
/** Largest share request body the Worker accepts, in UTF-8 bytes of its JSON. */
export const MAX_SHARE_BYTES = 128 * 1024;

function isLang(value: unknown): value is Lang {
  return typeof value === 'string' && Object.hasOwn(LANGS, value);
}

export function parseWorkspaceState(value: unknown): WorkspaceState | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (!isLang(record.lang)) return null;
  const lang = record.lang;
  const entry = entryFile(lang);
  // Shares from before multi-file workspaces carry a single `code` string.
  const ws =
    record.files !== undefined
      ? parseWorkspace({ files: record.files, dirs: record.dirs }, lang)
      : typeof record.code === 'string' && record.code.length <= MAX_SHARE_CODE_CHARS
        ? { files: { [entry]: record.code }, dirs: [] }
        : null;
  if (!ws) return null;
  const layout = parseDockState(record.layout, entry);
  return {
    lang,
    files: { ...ws.files },
    ...(ws.dirs.length ? { dirs: [...ws.dirs] } : {}),
    ...(layout ? { layout } : {}),
  };
}
