import { isShareId } from './id';
import { MAX_SHARE_BYTES, MAX_SHARE_CODE_CHARS, parseWorkspaceState } from './state';
import type { WorkspaceState } from './types';

export { parseWorkspaceState } from './state';

/** A share that failed for a reason worth showing the user as-is. */
export class ShareError extends Error {}

export async function createShare(state: WorkspaceState): Promise<string> {
  let chars = 0;
  for (const text of Object.values(state.files)) chars += text.length;
  if (chars > MAX_SHARE_CODE_CHARS) throw new ShareError('Code is too long to share');
  const parsed = parseWorkspaceState(state);
  if (!parsed) throw new Error('Invalid workspace state');

  const body = JSON.stringify(parsed);
  if (new TextEncoder().encode(body).byteLength > MAX_SHARE_BYTES) {
    throw new ShareError('Code is too large to share');
  }

  const res = await fetch('/api/share', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
  if (res.status === 503) throw new ShareError('Sharing is paused for today');
  if (!res.ok) throw new Error(`Share failed (${res.status})`);
  const { id } = (await res.json()) as { id?: unknown };
  if (typeof id !== 'string') throw new Error('Share failed (bad response)');
  return id;
}

export async function getShare(id: string): Promise<WorkspaceState | null> {
  if (!isShareId(id)) return null;
  const res = await fetch(`/api/share/${encodeURIComponent(id)}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Loading share failed (${res.status})`);
  return parseWorkspaceState(await res.json());
}

/** Path URL; Cloudflare SPA fallback serves `/` for unknown paths. */
export function shareUrl(id: string): string {
  return `${window.location.origin}/${id}`;
}
