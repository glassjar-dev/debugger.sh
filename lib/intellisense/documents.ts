'use client';

/**
 * Every open file gets its own editor, but a language has one backend, which checks one
 * document at a time. `documentService` gives each editor a view of the backend for its
 * own file: the file you are in owns the backend; the others keep their latest text and
 * take over when you focus them, so diagnostics never land in the wrong editor.
 */

import type { LanguageService } from './types';

type Doc = { text: string; version: number };

type Shared = {
  owner: string | null;
  /** Backend version → which document and editor version it checked. */
  versions: Map<number, { path: string; version: number }>;
  next: number;
  docs: Map<string, Doc>;
};

const shared = new WeakMap<LanguageService, Shared>();

export type DocumentService = LanguageService & {
  /** Make this file the one the backend checks (the editor gained focus). */
  claim(): void;
};

export function documentService(inner: LanguageService, path: string): DocumentService {
  let s = shared.get(inner);
  if (!s) {
    s = { owner: null, versions: new Map(), next: 1, docs: new Map() };
    shared.set(inner, s);
  }
  const state = s;

  const send = () => {
    const doc = state.docs.get(path);
    if (!doc) return;
    const v = state.next++;
    state.versions.set(v, { path, version: doc.version });
    // Old checks can't come back after a newer one is sent for any document.
    for (const k of state.versions.keys()) if (k < v - 64) state.versions.delete(k);
    inner.setActive?.(path);
    inner.update(doc.text, v);
  };

  const claim = () => {
    if (state.owner === path) return;
    state.owner = path;
    send();
  };

  /** Requests carry their own text, but the backend must also know which file it is. */
  const owned = <T>(fn: () => Promise<T>) => {
    claim();
    return fn();
  };

  return {
    triggerCharacters: inner.triggerCharacters,
    signatureTriggers: inner.signatureTriggers,
    claim,
    update(text, version) {
      state.docs.set(path, { text, version });
      if (state.owner === null) state.owner = path;
      if (state.owner === path) send();
    },
    complete: (text, pos, explicit) => owned(() => inner.complete(text, pos, explicit)),
    hover: (text, pos) => owned(() => inner.hover(text, pos)),
    signature: (text, pos) => owned(() => inner.signature(text, pos)),
    definition: (text, pos) => owned(() => inner.definition(text, pos)),
    inlayHints: inner.inlayHints ? (text) => owned(() => inner.inlayHints!(text)) : undefined,
    onDiagnostics(listener) {
      return inner.onDiagnostics((v, list) => {
        if (v === -1) {
          if (state.owner === path) listener(-1, list);
          return;
        }
        const checked = state.versions.get(v);
        if (checked?.path === path) listener(checked.version, list);
      });
    },
    onStatus: (listener) => inner.onStatus(listener),
  };
}
