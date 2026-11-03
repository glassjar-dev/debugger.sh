import { isShareId } from './id';
import { parseWorkspaceState } from './state';
import type { WorkspaceState } from './types';

export { parseWorkspaceState } from './state';

export async function createShare(state: WorkspaceState): Promise<string> {
  const parsed = parseWorkspaceState(state);
  if (!parsed) throw new Error('Invalid workspace state');

  const res = await fetch('/api/share', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(parsed),
  });
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
