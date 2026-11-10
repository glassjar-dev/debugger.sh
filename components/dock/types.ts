import { basename, normalizePath } from '@/lib/workspace/paths';

/** Tool panes that always exist; they reopen from a tab bar's + menu. */
export type BuiltinPane = 'variables' | 'output' | 'tests';
/** An open file, one tab per path. Closing the tab doesn't delete the file. */
export type FilePane = `file:${string}`;
export type PaneId = BuiltinPane | FilePane;

export const BUILTIN_PANES: readonly BuiltinPane[] = ['variables', 'output', 'tests'];

export const PANE_LABELS: Record<BuiltinPane, string> = {
  variables: 'Variables',
  output: 'Terminal',
  tests: 'Tests',
};

export function filePane(path: string): FilePane {
  return `file:${path}`;
}

/** The file a pane shows, or null for a tool pane. */
export function paneFile(pane: PaneId): string | null {
  return pane.startsWith('file:') ? pane.slice(5) : null;
}

export function paneLabel(pane: PaneId): string {
  const file = paneFile(pane);
  return file ? basename(file) : PANE_LABELS[pane as BuiltinPane];
}

export type SplitDir = 'h' | 'v';
export type DropEdge = 'center' | 'left' | 'right' | 'top' | 'bottom';

export type TabGroup = {
  type: 'tabs';
  id: string;
  tabs: PaneId[];
  active: PaneId;
};

export type SplitNode = {
  type: 'split';
  id: string;
  dir: SplitDir;
  children: [DockNode, DockNode];
  sizes: [number, number];
};

export type DockNode = TabGroup | SplitNode;

export type DockState = {
  root: DockNode;
};

let nextId = 1;
export function newId(prefix: string): string {
  nextId += 1;
  return `${prefix}-${nextId}`;
}

export function defaultDockState(entry: string): DockState {
  const main = filePane(entry);
  return {
    root: {
      type: 'split',
      id: 'split-root',
      dir: 'h',
      sizes: [62, 38],
      children: [
        { type: 'tabs', id: 'tabs-main', tabs: [main], active: main },
        {
          type: 'split',
          id: 'split-right',
          dir: 'v',
          sizes: [52, 48],
          children: [
            { type: 'tabs', id: 'tabs-side', tabs: ['variables'], active: 'variables' },
            {
              type: 'tabs',
              id: 'tabs-bottom',
              tabs: ['output', 'tests'],
              // Only C++ has a test runner; other languages open on their output.
              active: entry.endsWith('.cpp') ? 'tests' : 'output',
            },
          ],
        },
      ],
    },
  };
}

/** Phone layout: code on top, everything else as tabs underneath. */
export function stackedDockState(entry: string): DockState {
  const main = filePane(entry);
  return {
    root: {
      type: 'split',
      id: 'split-root',
      dir: 'v',
      sizes: [56, 44],
      children: [
        { type: 'tabs', id: 'tabs-main', tabs: [main], active: main },
        {
          type: 'tabs',
          id: 'tabs-bottom',
          tabs: ['output', 'tests', 'variables'],
          active: 'output',
        },
      ],
    },
  };
}

export function isTabGroup(n: DockNode): n is TabGroup {
  return n.type === 'tabs';
}

export function isSplitNode(n: DockNode): n is SplitNode {
  return n.type === 'split';
}

/** Walk the tree and collect every tab group. */
export function collectGroups(node: DockNode, out: TabGroup[] = []): TabGroup[] {
  if (isTabGroup(node)) {
    out.push(node);
    return out;
  }
  collectGroups(node.children[0], out);
  collectGroups(node.children[1], out);
  return out;
}

export function findGroup(node: DockNode, groupId: string): TabGroup | null {
  if (isTabGroup(node)) return node.id === groupId ? node : null;
  return findGroup(node.children[0], groupId) ?? findGroup(node.children[1], groupId);
}

export function visiblePanes(state: DockState): Set<PaneId> {
  const set = new Set<PaneId>();
  for (const g of collectGroups(state.root)) {
    for (const t of g.tabs) set.add(t);
  }
  return set;
}

/** Tool panes not in the layout, offered by the + menu. Closed files reopen from the explorer. */
export function closedPanes(state: DockState): BuiltinPane[] {
  const vis = visiblePanes(state);
  return BUILTIN_PANES.filter((p) => !vis.has(p));
}

/** Every file with a tab, in layout order. */
export function openFiles(state: DockState): string[] {
  const out: string[] = [];
  for (const g of collectGroups(state.root))
    for (const t of g.tabs) {
      const file = paneFile(t);
      if (file) out.push(file);
    }
  return out;
}

/** Old layouts had one `editor` pane; it becomes the entry file's tab. */
function parsePaneId(value: unknown, entry: string): PaneId | null {
  if (value === 'editor') return filePane(entry);
  if (typeof value !== 'string') return null;
  if ((BUILTIN_PANES as readonly string[]).includes(value)) return value as BuiltinPane;
  const file = value.startsWith('file:') ? value.slice(5) : null;
  return file && normalizePath(file) === file ? filePane(file) : null;
}

function parseDockNode(value: unknown, entry: string): DockNode | null {
  if (!value || typeof value !== 'object') return null;
  const n = value as Record<string, unknown>;

  if (n.type === 'tabs') {
    const active = parsePaneId(n.active, entry);
    if (typeof n.id !== 'string' || !Array.isArray(n.tabs) || !active) return null;
    const tabs = [...new Set(n.tabs.map((t) => parsePaneId(t, entry)).filter((t): t is PaneId => !!t))];
    if (tabs.length === 0 || !tabs.includes(active)) return null;
    return { type: 'tabs', id: n.id, tabs, active };
  }

  if (n.type === 'split') {
    if (typeof n.id !== 'string' || (n.dir !== 'h' && n.dir !== 'v')) return null;
    if (!Array.isArray(n.children) || n.children.length !== 2) return null;
    if (!Array.isArray(n.sizes) || n.sizes.length !== 2) return null;
    const s0 = Number(n.sizes[0]);
    const s1 = Number(n.sizes[1]);
    if (!Number.isFinite(s0) || !Number.isFinite(s1)) return null;
    const a = parseDockNode(n.children[0], entry);
    const b = parseDockNode(n.children[1], entry);
    if (!a || !b) return null;
    return { type: 'split', id: n.id, dir: n.dir, children: [a, b], sizes: [s0, s1] };
  }

  return null;
}

/** Best-effort parse of a persisted dock tree; null if unusable. `entry` replaces a legacy `editor` pane. */
export function parseDockState(value: unknown, entry: string): DockState | null {
  if (!value || typeof value !== 'object') return null;
  const root = parseDockNode((value as { root?: unknown }).root, entry);
  return root ? { root } : null;
}

/** Advance `newId` past any numeric suffixes already used in a loaded tree. */
export function adoptDockIds(state: DockState): void {
  let max = nextId;
  const walk = (node: DockNode) => {
    const m = /-(\d+)$/.exec(node.id);
    if (m) max = Math.max(max, Number(m[1]));
    if (isSplitNode(node)) {
      walk(node.children[0]);
      walk(node.children[1]);
    }
  };
  walk(state.root);
  nextId = max;
}
