'use client';

import { useEffect, useRef, useState } from 'react';
import { useDraggable, useDroppable } from '@dnd-kit/core';

import { FileIcon } from '@/components/files/FileIcon';

import { PANE_LABELS, paneFile, paneLabel, type BuiltinPane, type PaneId, type TabGroup } from './types';

export type TabBarProps = {
  group: TabGroup;
  closed: BuiltinPane[];
  onSelect: (pane: PaneId) => void;
  onClose: (pane: PaneId) => void;
  onOpen: (pane: PaneId) => void;
  canClose: boolean;
  /** Insert slot while dragging over this bar (visual + drop target). */
  insertIndex?: number | null;
  registerBar?: (groupId: string, el: HTMLElement | null) => void;
};

export function TabBar({
  group,
  closed,
  onSelect,
  onClose,
  onOpen,
  canClose,
  insertIndex = null,
  registerBar,
}: TabBarProps) {
  const { setNodeRef: setDropRef, isOver } = useDroppable({
    id: `tabbar-${group.id}`,
    data: { kind: 'tabbar', groupId: group.id },
  });

  const setRef = (el: HTMLDivElement | null) => {
    setDropRef(el);
    registerBar?.(group.id, el);
  };

  return (
    <div
      ref={setRef}
      className="ide-tabbar"
      data-drop-over={isOver ? 'true' : undefined}
      role="tablist"
      aria-label="Pane tabs"
    >
      {group.tabs.map((pane, i) => (
        <div key={pane} className="ide-tab-slot">
          {insertIndex === i && <div className="ide-tab-insert" aria-hidden />}
          <DockTab
            pane={pane}
            groupId={group.id}
            active={group.active === pane}
            canClose={canClose}
            onSelect={() => onSelect(pane)}
            onClose={() => onClose(pane)}
          />
        </div>
      ))}
      {insertIndex === group.tabs.length && (
        <div className="ide-tab-insert" aria-hidden />
      )}
      <div className="ide-tabbar-spacer" aria-hidden />
      {closed.length > 0 && <AddMenu closed={closed} onOpen={onOpen} />}
    </div>
  );
}

/** Visual insert index among all tabs (including the one being dragged). */
export function insertIndexAtPointer(bar: HTMLElement, clientX: number): number {
  const tabs = [...bar.querySelectorAll<HTMLElement>('.ide-tab')];
  for (let i = 0; i < tabs.length; i++) {
    const r = tabs[i]!.getBoundingClientRect();
    if (clientX < r.left + r.width / 2) return i;
  }
  return tabs.length;
}

/** Convert visual index → index in the list with `pane` already removed. */
export function toMoveIndex(tabs: PaneId[], pane: PaneId, visualIndex: number): number {
  const from = tabs.indexOf(pane);
  if (from === -1) return visualIndex;
  return from < visualIndex ? visualIndex - 1 : visualIndex;
}

function DockTab({
  pane,
  groupId,
  active,
  canClose,
  onSelect,
  onClose,
}: {
  pane: PaneId;
  groupId: string;
  active: boolean;
  canClose: boolean;
  onSelect: () => void;
  onClose: () => void;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `tab-${groupId}-${pane}`,
    data: { kind: 'tab', pane, groupId },
  });
  const file = paneFile(pane);
  const label = paneLabel(pane);

  return (
    <div
      ref={setNodeRef}
      className="ide-tab"
      data-pane={pane}
      data-active={active ? 'true' : undefined}
      data-dragging={isDragging ? 'true' : undefined}
      aria-selected={active}
      {...listeners}
      {...attributes}
      role="tab"
      title={file ?? undefined}
      onClick={onSelect}
      // Middle-click closes, as in every editor.
      onAuxClick={(e) => {
        if (e.button !== 1 || !canClose) return;
        e.preventDefault();
        onClose();
      }}
    >
      {file && <FileIcon path={file} size={13} />}
      <span className="ide-tab-label">{label}</span>
      {canClose && (
        <button
          type="button"
          className="ide-tab-close"
          aria-label={`Close ${label}`}
          title="Close"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
        >
          ×
        </button>
      )}
    </div>
  );
}

function AddMenu({ closed, onOpen }: { closed: BuiltinPane[]; onOpen: (pane: PaneId) => void }) {
  const [open, setOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<{ top: number; right: number } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const btn = btnRef.current;
    if (btn) {
      const r = btn.getBoundingClientRect();
      setMenuPos({ top: r.bottom + 4, right: window.innerWidth - r.right });
    }
    const onPointer = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="ide-tab-add" ref={rootRef}>
      <button
        ref={btnRef}
        type="button"
        className="ide-tab-add-btn"
        aria-label="Open pane"
        title="Open pane"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        +
      </button>
      {open && menuPos && (
        <ul
          className="ide-tab-add-menu"
          role="menu"
          style={{ top: menuPos.top, right: menuPos.right }}
        >
          {closed.map((pane) => (
            <li key={pane} role="none">
              <button
                type="button"
                role="menuitem"
                className="ide-tab-add-item"
                onClick={() => {
                  onOpen(pane);
                  setOpen(false);
                }}
              >
                {PANE_LABELS[pane]}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
