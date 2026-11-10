export const EDIT_MERGE_MS = 500;

export type EditReason = 'paste' | 'undo' | 'redo' | 'language';

/** One textual change, positioned in the document produced by prior changes. */
export type EditAtom = {
  /** Workspace path of the edited file. */
  file?: string;
  offset: number;
  deleted: number;
  inserted: string;
  reason?: EditReason;
  language?: string;
  /** Client time of this fragment, in ms. */
  at: number;
};

export type OpenEdit = EditAtom & {
  /** Client time of the first fragment in this merged edit. */
  startedAt: number;
};

/**
 * Combine `next` into `open` when they are within 500ms, share a reason, and
 * their ranges touch — so the pair is still one replacement. Returns null when
 * the edits must stay separate.
 */
export function tryMerge(open: OpenEdit, next: EditAtom): OpenEdit | null {
  if (next.at < open.at) return null;
  if (next.at - open.at > EDIT_MERGE_MS) return null;
  if (open.reason !== next.reason) return null;
  if (open.file !== next.file) return null;
  if ((open.language ?? undefined) !== (next.language ?? undefined)) return null;
  const composed = compose(open, next);
  if (!composed) return null;
  return {
    ...composed,
    file: open.file,
    reason: open.reason,
    language: open.language,
    at: next.at,
    startedAt: open.startedAt,
  };
}

/**
 * Two replacements compose when B (applied after A) touches A's inserted span.
 * Positions in B are in the post-A document.
 */
function compose(
  a: { offset: number; deleted: number; inserted: string },
  b: { offset: number; deleted: number; inserted: string },
): { offset: number; deleted: number; inserted: string } | null {
  const aStart = a.offset;
  const aInsEnd = a.offset + a.inserted.length;
  const aDelEnd = a.offset + a.deleted;
  const bStart = b.offset;
  const bEnd = b.offset + b.deleted;
  if (bEnd < aStart || bStart > aInsEnd) return null;

  const mapToOrig = (pos: number) => {
    if (pos <= aStart) return pos;
    if (pos >= aInsEnd) return pos - a.inserted.length + a.deleted;
    return aStart;
  };
  const origStart = Math.min(aStart, mapToOrig(bStart));
  const origEnd = Math.max(aDelEnd, mapToOrig(bEnd));
  const prefixEnd = Math.max(0, Math.min(a.inserted.length, bStart - aStart));
  const suffixStart = Math.max(0, Math.min(a.inserted.length, bEnd - aStart));
  return {
    offset: origStart,
    deleted: origEnd - origStart,
    inserted: a.inserted.slice(0, prefixEnd) + b.inserted + a.inserted.slice(suffixStart),
  };
}

/** Microseconds since the Unix epoch, formatted as a UTC timestamptz literal. */
function formatMicros(us: number): string {
  const ms = Math.floor(us / 1000);
  const extra = us - ms * 1000;
  return new Date(ms).toISOString().slice(0, -1) + String(extra).padStart(3, '0') + 'Z';
}

/** Strictly increasing client timestamps. Resolution is 1µs, matching timestamptz. */
export function createStampClock() {
  let last = Number.NEGATIVE_INFINITY;
  return (at: number) => {
    const us = Math.max(Math.floor(at) * 1000, last + 1);
    last = us;
    return formatMicros(us);
  };
}
