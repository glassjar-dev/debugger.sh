export type PaneId = 'editor' | 'variables' | 'output' | 'tests';

export const PANE_IDS: readonly PaneId[] = ['editor', 'variables', 'output', 'tests'];

export const PANE_LABELS: Record<PaneId, string> = {
  editor: 'Code',
  variables: 'Variables',
  output: 'Terminal',
  tests: 'Tests',
};

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

export function defaultDockState(): DockState {
  return {
    root: {
      type: 'split',
      id: 'split-root',
      dir: 'h',
      sizes: [62, 38],
      children: [
        { type: 'tabs', id: 'tabs-main', tabs: ['editor'], active: 'editor' },
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
              active: 'tests',
            },
          ],
        },
      ],
    },
  };
}

/** Phone layout: code on top, everything else as tabs underneath. */
export function stackedDockState(): DockState {
  return {
    root: {
      type: 'split',
      id: 'split-root',
      dir: 'v',
      sizes: [56, 44],
      children: [
        { type: 'tabs', id: 'tabs-main', tabs: ['editor'], active: 'editor' },
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

export function closedPanes(state: DockState): PaneId[] {
  const vis = visiblePanes(state);
  return PANE_IDS.filter((p) => !vis.has(p));
}

function isPaneId(value: unknown): value is PaneId {
  return typeof value === 'string' && (PANE_IDS as readonly string[]).includes(value);
}

function parseDockNode(value: unknown): DockNode | null {
  if (!value || typeof value !== 'object') return null;
  const n = value as Record<string, unknown>;

  if (n.type === 'tabs') {
    if (typeof n.id !== 'string' || !Array.isArray(n.tabs) || !isPaneId(n.active)) return null;
    const tabs = n.tabs.filter(isPaneId);
    if (tabs.length === 0 || !tabs.includes(n.active)) return null;
    return { type: 'tabs', id: n.id, tabs, active: n.active };
  }

  if (n.type === 'split') {
    if (typeof n.id !== 'string' || (n.dir !== 'h' && n.dir !== 'v')) return null;
    if (!Array.isArray(n.children) || n.children.length !== 2) return null;
    if (!Array.isArray(n.sizes) || n.sizes.length !== 2) return null;
    const s0 = Number(n.sizes[0]);
    const s1 = Number(n.sizes[1]);
    if (!Number.isFinite(s0) || !Number.isFinite(s1)) return null;
    const a = parseDockNode(n.children[0]);
    const b = parseDockNode(n.children[1]);
    if (!a || !b) return null;
    return { type: 'split', id: n.id, dir: n.dir, children: [a, b], sizes: [s0, s1] };
  }

  return null;
}

/** Best-effort parse of a persisted dock tree; null if unusable. */
export function parseDockState(value: unknown): DockState | null {
  if (!value || typeof value !== 'object') return null;
  const root = parseDockNode((value as { root?: unknown }).root);
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
