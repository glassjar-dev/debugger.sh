'use client';

/**
 * The live workspaces, one per language, outside React so typing in one file doesn't
 * re-render the explorer. Components subscribe to either the full workspace or just its
 * shape (paths and folders), which only changes when files are added, moved or removed.
 *
 * Workspaces autosave to localStorage, except while a share is open: a shared project
 * never overwrites your own.
 */

import { useSyncExternalStore } from 'react';

import { LANGS, type Lang } from '@/components/constants';

import { defaultWorkspace, parseWorkspace, type Workspace } from './model';

export type WorkspaceShape = { paths: readonly string[]; dirs: readonly string[] };

const STORAGE_PREFIX = 'glassjar.workspace.v1.';
const SAVE_DELAY_MS = 400;
const LANG_IDS = Object.keys(LANGS) as Lang[];

function load(lang: Lang): Workspace {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + lang);
    if (raw) return parseWorkspace(JSON.parse(raw), lang) ?? defaultWorkspace(lang);
  } catch {
    // Storage blocked or corrupt: start fresh.
  }
  return defaultWorkspace(lang);
}

function shapeOf(ws: Workspace): WorkspaceShape {
  return { paths: Object.keys(ws.files), dirs: ws.dirs };
}

function sameShape(a: WorkspaceShape, b: WorkspaceShape): boolean {
  return (
    a.paths.length === b.paths.length &&
    a.dirs.length === b.dirs.length &&
    a.paths.every((p, i) => p === b.paths[i]) &&
    a.dirs.every((d, i) => d === b.dirs[i])
  );
}

class WorkspaceStore {
  private workspaces = {} as Record<Lang, Workspace>;
  private shapes = {} as Record<Lang, WorkspaceShape>;
  private listeners = new Set<() => void>();
  private pending = new Set<Lang>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private persist = true;
  private loaded = false;

  private ensure() {
    if (this.loaded) return;
    this.loaded = true;
    const browser = typeof window !== 'undefined';
    for (const lang of LANG_IDS) {
      this.workspaces[lang] = browser ? load(lang) : defaultWorkspace(lang);
      this.shapes[lang] = shapeOf(this.workspaces[lang]);
    }
    if (browser) window.addEventListener('pagehide', () => this.flush());
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };

  get(lang: Lang): Workspace {
    this.ensure();
    return this.workspaces[lang];
  }

  shape(lang: Lang): WorkspaceShape {
    this.ensure();
    return this.shapes[lang];
  }

  set(lang: Lang, ws: Workspace) {
    this.ensure();
    if (this.workspaces[lang] === ws) return;
    this.workspaces[lang] = ws;
    const shape = shapeOf(ws);
    if (!sameShape(shape, this.shapes[lang])) this.shapes[lang] = shape;
    this.schedule(lang);
    for (const l of this.listeners) l();
  }

  /** Stop autosaving, e.g. while a share is open. */
  setPersistence(on: boolean) {
    this.persist = on;
    if (!on) this.pending.clear();
  }

  private schedule(lang: Lang) {
    if (!this.persist) return;
    this.pending.add(lang);
    if (this.timer == null) this.timer = setTimeout(() => this.flush(), SAVE_DELAY_MS);
  }

  private flush() {
    if (this.timer != null) clearTimeout(this.timer);
    this.timer = null;
    for (const lang of this.pending) {
      try {
        localStorage.setItem(STORAGE_PREFIX + lang, JSON.stringify(this.workspaces[lang]));
      } catch {
        // Quota or private mode: the workspace stays in memory for this visit.
      }
    }
    this.pending.clear();
  }
}

export const workspaceStore = new WorkspaceStore();

export function useWorkspace(lang: Lang): Workspace {
  return useSyncExternalStore(
    workspaceStore.subscribe,
    () => workspaceStore.get(lang),
    () => defaultWorkspace(lang),
  );
}

const serverShapes = Object.fromEntries(LANG_IDS.map((l) => [l, shapeOf(defaultWorkspace(l))])) as Record<
  Lang,
  WorkspaceShape
>;

/** Paths and folders only: stable across edits to file contents. */
export function useWorkspaceShape(lang: Lang): WorkspaceShape {
  return useSyncExternalStore(
    workspaceStore.subscribe,
    () => workspaceStore.shape(lang),
    () => serverShapes[lang],
  );
}
