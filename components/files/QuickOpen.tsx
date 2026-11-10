'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { CornerDownLeft, FilePlus2, Search } from 'lucide-react';

import { basename, dirname, normalizePath } from '@/lib/workspace/paths';

import { FileIcon } from './FileIcon';
import './files.css';

type Match = { path: string; score: number; hits: number[] };

/**
 * Subsequence match over the path, scored so that hits in the file name, at word
 * starts and in runs rank first. Returns null when `query` isn't a subsequence.
 */
export function fuzzyMatch(query: string, path: string): Match | null {
  if (!query) return { path, score: 0, hits: [] };
  const q = query.toLowerCase().replace(/\s+/g, '');
  const p = path.toLowerCase();
  const nameStart = path.lastIndexOf('/') + 1;
  const hits: number[] = [];
  let score = 0;
  let from = 0;
  for (const ch of q) {
    const i = p.indexOf(ch, from);
    if (i < 0) return null;
    const prev = hits[hits.length - 1];
    score += 1;
    if (i >= nameStart) score += 2;
    if (prev !== undefined && i === prev + 1) score += 3;
    if (i === 0 || /[/._\-]/.test(path[i - 1]!) || (path[i] !== p[i] && path[i - 1] === p[i - 1])) score += 2;
    hits.push(i);
    from = i + 1;
  }
  // Shorter paths win ties: `main.cpp` over `lib/main_helpers.cpp`.
  return { path, score: score - path.length * 0.01, hits };
}

function Highlighted({ text, hits, offset }: { text: string; hits: ReadonlySet<number>; offset: number }) {
  return (
    <>
      {[...text].map((ch, i) => (hits.has(i + offset) ? <mark key={i}>{ch}</mark> : ch))}
    </>
  );
}

export function QuickOpen({
  paths,
  recent,
  onOpen,
  onCreate,
  onClose,
}: {
  paths: readonly string[];
  /** Open tabs, most recent first; shown when the query is empty. */
  recent: readonly string[];
  onOpen: (path: string) => void;
  /** Create and open; returns an error to show, or null. */
  onCreate: (path: string) => string | null;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => inputRef.current?.focus(), []);

  const matches = useMemo(() => {
    if (!query.trim()) {
      const rest = paths.filter((p) => !recent.includes(p)).sort();
      return [...recent.filter((p) => paths.includes(p)), ...rest].map((path) => ({ path, score: 0, hits: [] }));
    }
    return paths
      .map((p) => fuzzyMatch(query.trim(), p))
      .filter((m): m is Match => !!m)
      .sort((a, b) => b.score - a.score)
      .slice(0, 50);
  }, [query, paths, recent]);

  const newPath = normalizePath(query);
  const canCreate = !!newPath && !paths.includes(newPath) && /\.[A-Za-z0-9+]+$/.test(newPath);
  const count = matches.length + (canCreate ? 1 : 0);

  const choose = (i: number) => {
    if (i < matches.length) {
      onOpen(matches[i]!.path);
      onClose();
    } else if (canCreate) {
      const err = onCreate(newPath!);
      if (err) setError(err);
      else onClose();
    }
  };

  return (
    <div className="gj-palette-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="gj-palette" role="dialog" aria-label="Go to file">
        <div className="gj-palette-field">
          <Search size={15} aria-hidden />
          <input
            ref={inputRef}
            value={query}
            spellCheck={false}
            placeholder="Go to file, or type a new name to create it"
            aria-label="File name"
            aria-activedescendant={count ? `gj-palette-${index}` : undefined}
            onChange={(e) => {
              setQuery(e.target.value);
              setIndex(0);
              setError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') setIndex((i) => (count ? (i + 1) % count : 0));
              else if (e.key === 'ArrowUp') setIndex((i) => (count ? (i - 1 + count) % count : 0));
              else if (e.key === 'Enter') choose(index);
              else if (e.key === 'Escape') onClose();
              else return;
              e.preventDefault();
            }}
          />
        </div>
        <ul className="gj-palette-list" role="listbox">
          {matches.map((m, i) => {
            const hits = new Set(m.hits);
            const name = basename(m.path);
            const dir = dirname(m.path);
            return (
              <li
                key={m.path}
                id={`gj-palette-${i}`}
                role="option"
                aria-selected={i === index}
                className="gj-palette-item"
                onPointerMove={() => setIndex(i)}
                onClick={() => choose(i)}
              >
                <FileIcon path={m.path} />
                <span className="gj-palette-name">
                  <Highlighted text={name} hits={hits} offset={m.path.length - name.length} />
                </span>
                {dir && (
                  <span className="gj-palette-dir">
                    <Highlighted text={dir} hits={hits} offset={0} />
                  </span>
                )}
                {i === index && <CornerDownLeft className="gj-palette-enter" size={12} aria-hidden />}
              </li>
            );
          })}
          {canCreate && (
            <li
              id={`gj-palette-${matches.length}`}
              role="option"
              aria-selected={index === matches.length}
              className="gj-palette-item gj-palette-create"
              onPointerMove={() => setIndex(matches.length)}
              onClick={() => choose(matches.length)}
            >
              <FilePlus2 size={14} aria-hidden />
              <span className="gj-palette-name">
                Create <strong>{newPath}</strong>
              </span>
            </li>
          )}
          {count === 0 && <li className="gj-palette-empty">No matching files</li>}
        </ul>
        {error && <div className="gj-palette-error" role="alert">{error}</div>}
        <footer className="gj-palette-foot">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> move
          </span>
          <span>
            <kbd>↵</kbd> open
          </span>
          <span>
            <kbd>esc</kbd> close
          </span>
        </footer>
      </div>
    </div>
  );
}
