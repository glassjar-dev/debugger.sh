/**
 * Workspace paths are relative and slash-separated, like `main.cpp` or `lib/list.h`.
 * Shared by the browser and the Worker (share validation), so keep it free of DOM imports.
 */

export const MAX_PATH_LENGTH = 160;
export const MAX_DEPTH = 8;
const MAX_SEGMENT_LENGTH = 64;
// Letters, digits and a few separators; no leading dot or space, so no hidden or `..` names.
const SEGMENT = /^[A-Za-z0-9_+\-][A-Za-z0-9_+.\- ]*$/;

/** The canonical form of `input`, or null when it isn't an acceptable workspace path. */
export function normalizePath(input: string): string | null {
  const segments = input.trim().replace(/\\/g, '/').split('/').filter(Boolean);
  if (segments.length === 0 || segments.length > MAX_DEPTH) return null;
  for (const segment of segments) {
    if (segment.length > MAX_SEGMENT_LENGTH || !SEGMENT.test(segment) || /[ .]$/.test(segment)) {
      return null;
    }
    // Workspaces are plain objects keyed by path; this one name would set their prototype.
    if (segment === '__proto__') return null;
  }
  const path = segments.join('/');
  return path.length <= MAX_PATH_LENGTH ? path : null;
}

export function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/** The parent folder, or '' for top-level paths. */
export function dirname(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? '' : path.slice(0, slash);
}

/** Lowercase extension without the dot, or ''. */
export function extname(path: string): string {
  const name = basename(path);
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase();
}

export function joinPath(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name;
}

/** `path` is `dir` itself or somewhere inside it. */
export function isWithin(path: string, dir: string): boolean {
  return path === dir || path.startsWith(`${dir}/`);
}
