import { LANGS, type Lang } from '@/components/constants';
import { parseDockState } from '@/components/dock/types';

import type { WorkspaceState } from './types';

/** Shared by the browser and the Worker, so it must stay free of DOM and React imports. */
export const MAX_SHARE_CODE_CHARS = 100_000;

function isLang(value: unknown): value is Lang {
  return typeof value === 'string' && Object.hasOwn(LANGS, value);
}

export function parseWorkspaceState(value: unknown): WorkspaceState | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (!isLang(record.lang) || typeof record.code !== 'string') return null;
  if (record.code.length > MAX_SHARE_CODE_CHARS) return null;
  const layout = parseDockState(record.layout);
  return layout
    ? { lang: record.lang, code: record.code, layout }
    : { lang: record.lang, code: record.code };
}
