'use client';

import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { ChevronRight, Copy, FilePlus2, FolderPlus, ListCollapse, Pencil, Play, Trash2 } from 'lucide-react';

import type { Lang } from '@/components/constants';
import { buildTree, type TreeNode } from '@/lib/workspace/model';
import { basename, dirname, extname, joinPath } from '@/lib/workspace/paths';
import { useWorkspaceShape } from '@/lib/workspace/store';

import { FileIcon, FolderIcon } from './FileIcon';
import './files.css';

/** What the explorer can ask for. Each returns an error to show, or null when it worked. */
export type FileOps = {
  create: (path: string, kind: 'file' | 'folder') => string | null;
  rename: (from: string, to: string) => string | null;
  remove: (path: string) => string | null;
};

type Editing =
  | { mode: 'file' | 'folder'; parent: string }
  | { mode: 'rename'; path: string; folder: boolean };

type Menu = { x: number; y: number; path: string | null; folder: boolean };

type ExplorerProps = {
  lang: Lang;
  entry: string;
  /** The file in the focused editor. */
  activeFile: string | null;
  openFiles: ReadonlySet<string>;
  onOpen: (path: string) => void;
  ops: FileOps;
};

/** Rows in display order, for arrow-key movement. */
function flatten(nodes: TreeNode[], collapsed: ReadonlySet<string>, out: TreeNode[] = []): TreeNode[] {
  for (const n of nodes) {
    out.push(n);
    if (n.kind === 'folder' && !collapsed.has(n.path)) flatten(n.children, collapsed, out);
  }
  return out;
}

export function Explorer({ lang, entry, activeFile, openFiles, onOpen, ops }: ExplorerProps) {
  const shape = useWorkspaceShape(lang);
  const tree = useMemo(() => buildTree(shape.paths, shape.dirs), [shape]);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  // Follow the editor: the focused file is the selection, and its folders open.
  useEffect(() => {
    if (!activeFile) return;
    setSelected(activeFile);
    setCollapsed((prev) => {
      let next: Set<string> | null = null;
      for (let dir = dirname(activeFile); dir; dir = dirname(dir))
        if (prev.has(dir)) (next ??= new Set(prev)).delete(dir);
      return next ?? prev;
    });
  }, [activeFile]);

  const folderPaths = useMemo(() => {
    const out = new Set<string>();
    const walk = (nodes: TreeNode[]) => {
      for (const n of nodes) if (n.kind === 'folder') (out.add(n.path), walk(n.children));
    };
    walk(tree);
    return out;
  }, [tree]);
  const isFolder = (path: string) => folderPaths.has(path);

  /** New things go into the selected folder, or next to the selected file. */
  const targetFolder = () => (selected == null ? '' : isFolder(selected) ? selected : dirname(selected));

  const startCreate = (mode: 'file' | 'folder', parent = targetFolder()) => {
    setMenu(null);
    if (parent) setCollapsed((prev) => (prev.has(parent) ? new Set([...prev].filter((p) => p !== parent)) : prev));
    setEditing({ mode, parent });
  };

  const toggle = (path: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (!next.delete(path)) next.add(path);
      return next;
    });

  const move = (from: string, folder: string) => {
    const to = joinPath(folder, basename(from));
    if (to !== from) ops.rename(from, to);
  };

  const rows = flatten(tree, collapsed);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (editing || e.target !== e.currentTarget) return;
    const index = rows.findIndex((r) => r.path === selected);
    const current = rows[index];
    const go = (i: number) => {
      const row = rows[Math.max(0, Math.min(rows.length - 1, i))];
      if (row) setSelected(row.path);
    };
    if (e.key === 'ArrowDown') go(index + 1);
    else if (e.key === 'ArrowUp') go(index < 0 ? 0 : index - 1);
    else if (e.key === 'ArrowRight' && current?.kind === 'folder') {
      if (collapsed.has(current.path)) toggle(current.path);
      else go(index + 1);
    } else if (e.key === 'ArrowLeft' && current) {
      if (current.kind === 'folder' && !collapsed.has(current.path)) toggle(current.path);
      else if (dirname(current.path)) setSelected(dirname(current.path));
    } else if (e.key === 'Enter' && current) {
      if (current.kind === 'folder') toggle(current.path);
      else onOpen(current.path);
    } else if (e.key === 'F2' && current) setEditing({ mode: 'rename', path: current.path, folder: current.kind === 'folder' });
    else if ((e.key === 'Delete' || (e.key === 'Backspace' && e.metaKey)) && current) ops.remove(current.path);
    else return;
    e.preventDefault();
  };

  const renderNodes = (nodes: TreeNode[], depth: number, parent: string): ReactNode => (
    <>
      {editing && editing.mode !== 'rename' && editing.parent === parent && (
        <NameInput
          depth={depth}
          kind={editing.mode}
          initial=""
          onCancel={() => setEditing(null)}
          onCommit={(name) => {
            const path = joinPath(parent, name);
            const error = ops.create(path, editing.mode as 'file' | 'folder');
            if (!error) {
              setEditing(null);
              setSelected(path);
            }
            return error;
          }}
        />
      )}
      {nodes.map((node) => {
        const renaming = editing?.mode === 'rename' && editing.path === node.path;
        const open = node.kind === 'folder' && !collapsed.has(node.path);
        return (
          <div key={node.path} role="none">
            {renaming ? (
              <NameInput
                depth={depth}
                kind={node.kind}
                initial={node.name}
                onCancel={() => setEditing(null)}
                onCommit={(name) => {
                  const to = joinPath(dirname(node.path), name);
                  const error = ops.rename(node.path, to);
                  if (!error) {
                    setEditing(null);
                    setSelected(to);
                  }
                  return error;
                }}
              />
            ) : (
              <div
                className="gj-tree-row"
                role="treeitem"
                aria-expanded={node.kind === 'folder' ? open : undefined}
                aria-selected={selected === node.path}
                data-selected={selected === node.path || undefined}
                data-active={node.path === activeFile || undefined}
                data-drop={dropTarget === node.path || undefined}
                style={{ paddingLeft: 8 + depth * 14 }}
                title={node.path}
                draggable={node.path !== entry}
                onDragStart={(e) => {
                  e.dataTransfer.setData('application/x-glassjar-path', node.path);
                  e.dataTransfer.effectAllowed = 'move';
                }}
                onDragOver={(e) => {
                  if (node.kind !== 'folder' || !e.dataTransfer.types.includes('application/x-glassjar-path')) return;
                  e.preventDefault();
                  e.stopPropagation();
                  setDropTarget(node.path);
                }}
                onDragLeave={() => setDropTarget((t) => (t === node.path ? null : t))}
                onDrop={(e) => {
                  if (node.kind !== 'folder') return;
                  e.preventDefault();
                  e.stopPropagation();
                  setDropTarget(null);
                  const from = e.dataTransfer.getData('application/x-glassjar-path');
                  if (from) move(from, node.path);
                }}
                onClick={() => {
                  setSelected(node.path);
                  if (node.kind === 'folder') toggle(node.path);
                  else onOpen(node.path);
                  rootRef.current?.focus();
                }}
                onDoubleClick={() => setEditing({ mode: 'rename', path: node.path, folder: node.kind === 'folder' })}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setSelected(node.path);
                  setMenu({ x: e.clientX, y: e.clientY, path: node.path, folder: node.kind === 'folder' });
                }}
              >
                <IndentGuides depth={depth} />
                {node.kind === 'folder' ? (
                  <>
                    <ChevronRight className="gj-tree-chevron" data-open={open || undefined} size={13} aria-hidden />
                    <FolderIcon open={open} />
                  </>
                ) : (
                  <>
                    <span className="gj-tree-chevron-space" />
                    <FileIcon path={node.path} />
                  </>
                )}
                <span className="gj-tree-name">{node.name}</span>
                {node.path === entry && (
                  <span className="gj-tree-entry" title="Runs start here">
                    <Play size={9} fill="currentColor" aria-hidden />
                    entry
                  </span>
                )}
                {node.kind === 'file' && openFiles.has(node.path) && node.path !== activeFile && (
                  <span className="gj-tree-open-dot" aria-label="open" />
                )}
              </div>
            )}
            {node.kind === 'folder' && open && renderNodes(node.children, depth + 1, node.path)}
          </div>
        );
      })}
    </>
  );

  return (
    <aside className="gj-explorer" aria-label="Files">
      <header className="gj-explorer-head">
        <span className="gj-explorer-title">Files</span>
        <div className="gj-explorer-actions">
          <IconButton label="New file" onClick={() => startCreate('file')}>
            <FilePlus2 size={14} />
          </IconButton>
          <IconButton label="New folder" onClick={() => startCreate('folder')}>
            <FolderPlus size={14} />
          </IconButton>
          <IconButton label="Collapse folders" onClick={() => setCollapsed(new Set(folderPaths))}>
            <ListCollapse size={14} />
          </IconButton>
        </div>
      </header>
      <div
        ref={rootRef}
        className="gj-tree"
        role="tree"
        tabIndex={0}
        data-drop={dropTarget === '' || undefined}
        onKeyDown={onKeyDown}
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes('application/x-glassjar-path')) return;
          e.preventDefault();
          setDropTarget('');
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropTarget(null);
        }}
        onDrop={(e) => {
          e.preventDefault();
          setDropTarget(null);
          const from = e.dataTransfer.getData('application/x-glassjar-path');
          if (from) move(from, '');
        }}
        onContextMenu={(e) => {
          if (e.target !== e.currentTarget) return;
          e.preventDefault();
          setSelected(null);
          setMenu({ x: e.clientX, y: e.clientY, path: null, folder: true });
        }}
        onClick={(e) => {
          if (e.target === e.currentTarget) setSelected(null);
        }}
      >
        {renderNodes(tree, 0, '')}
        <p className="gj-tree-hint">
          {extname(entry) === 'cpp'
            ? 'Every .cpp file is compiled; headers are found by #include.'
            : extname(entry) === 'py'
              ? 'main.py runs; import your other modules by name.'
              : 'main.rs is the crate root; add modules with mod.'}
        </p>
      </div>
      {menu && (
        <ContextMenu menu={menu} onClose={() => setMenu(null)}>
          <MenuItem icon={<FilePlus2 size={13} />} onClick={() => startCreate('file', menu.path == null ? '' : menu.folder ? menu.path : dirname(menu.path))}>
            New file
          </MenuItem>
          <MenuItem icon={<FolderPlus size={13} />} onClick={() => startCreate('folder', menu.path == null ? '' : menu.folder ? menu.path : dirname(menu.path))}>
            New folder
          </MenuItem>
          {menu.path != null && menu.path !== entry && (
            <>
              <div className="gj-menu-sep" />
              <MenuItem
                icon={<Pencil size={13} />}
                hint="F2"
                onClick={() => {
                  setMenu(null);
                  setEditing({ mode: 'rename', path: menu.path!, folder: menu.folder });
                }}
              >
                Rename
              </MenuItem>
              <MenuItem
                icon={<Trash2 size={13} />}
                hint="Del"
                danger
                onClick={() => {
                  setMenu(null);
                  ops.remove(menu.path!);
                }}
              >
                Delete
              </MenuItem>
            </>
          )}
          {menu.path != null && (
            <>
              <div className="gj-menu-sep" />
              <MenuItem
                icon={<Copy size={13} />}
                onClick={() => {
                  setMenu(null);
                  void navigator.clipboard?.writeText(menu.path!);
                }}
              >
                Copy path
              </MenuItem>
            </>
          )}
        </ContextMenu>
      )}
    </aside>
  );
}

function IndentGuides({ depth }: { depth: number }) {
  return (
    <>
      {Array.from({ length: depth }, (_, i) => (
        <span key={i} className="gj-tree-guide" style={{ left: 14 + i * 14 }} aria-hidden />
      ))}
    </>
  );
}

/** Inline name field for creating or renaming. Enter commits, Escape or blur cancels. */
function NameInput({
  depth,
  kind,
  initial,
  onCommit,
  onCancel,
}: {
  depth: number;
  kind: 'file' | 'folder';
  initial: string;
  onCommit: (name: string) => string | null;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const input = ref.current;
    if (!input) return;
    input.focus();
    // Select the name without its extension, as editors do.
    const dot = initial.lastIndexOf('.');
    input.setSelectionRange(0, kind === 'file' && dot > 0 ? dot : initial.length);
  }, [initial, kind]);

  const commit = () => {
    const name = value.trim();
    if (!name || name === initial) return onCancel();
    setError(onCommit(name));
  };

  return (
    <div className="gj-tree-row gj-tree-edit" style={{ paddingLeft: 8 + depth * 14 }}>
      <IndentGuides depth={depth} />
      <span className="gj-tree-chevron-space" />
      {kind === 'folder' ? <FolderIcon open={false} /> : <FileIcon path={value || 'untitled'} />}
      <input
        ref={ref}
        className="gj-tree-input"
        data-error={error ? true : undefined}
        value={value}
        spellCheck={false}
        aria-label={kind === 'folder' ? 'Folder name' : 'File name'}
        aria-invalid={!!error}
        placeholder={kind === 'folder' ? 'folder' : 'name.ext'}
        onChange={(e) => {
          setValue(e.target.value);
          setError(null);
        }}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter') commit();
          else if (e.key === 'Escape') onCancel();
        }}
        onBlur={() => (error ? onCancel() : commit())}
      />
      {error && <div className="gj-tree-error" role="alert">{error}</div>}
    </div>
  );
}

function IconButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" className="gj-icon-btn" aria-label={label} title={label} onClick={onClick}>
      {children}
    </button>
  );
}

function ContextMenu({ menu, onClose, children }: { menu: Menu; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (e: Event) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const esc = (e: globalThis.KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('pointerdown', close, true);
    window.addEventListener('keydown', esc);
    window.addEventListener('blur', onClose);
    return () => {
      window.removeEventListener('pointerdown', close, true);
      window.removeEventListener('keydown', esc);
      window.removeEventListener('blur', onClose);
    };
  }, [onClose]);
  // Keep the menu on screen near the pointer.
  const style = {
    left: Math.min(menu.x, window.innerWidth - 200),
    top: Math.min(menu.y, window.innerHeight - 220),
  };
  return (
    <div ref={ref} className="gj-menu" role="menu" style={style}>
      {children}
    </div>
  );
}

function MenuItem({
  icon,
  hint,
  danger,
  onClick,
  children,
}: {
  icon: ReactNode;
  hint?: string;
  danger?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button type="button" role="menuitem" className="gj-menu-item" data-danger={danger || undefined} onClick={onClick}>
      <span className="gj-menu-icon">{icon}</span>
      <span>{children}</span>
      {hint && <kbd className="gj-menu-hint">{hint}</kbd>}
    </button>
  );
}
