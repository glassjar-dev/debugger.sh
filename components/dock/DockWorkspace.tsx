"use client";

import {
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  pointerWithin,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragMoveEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { Group, Panel, Separator } from "react-resizable-panels";

import "../dock.css";
import {
  closeTab,
  hitEdge,
  moveToGroup,
  openInGroup,
  setActive,
  setSplitSizes,
  splitLeaf,
} from "./ops";
import { TabBar, insertIndexAtPointer, toMoveIndex } from "./TabBar";
import {
  PANE_IDS,
  PANE_LABELS,
  type DockNode,
  type DockState,
  type DropEdge,
  type PaneId,
  type SplitNode,
  type TabGroup,
  closedPanes,
  collectGroups,
  isTabGroup,
  visiblePanes,
} from "./types";

export type DockWorkspaceProps = {
  panes: Record<PaneId, ReactNode>;
  layout: DockState;
  onLayoutChange: (layout: DockState) => void;
};

type DragPane = { pane: PaneId; groupId: string };

type HoverTarget = {
  groupId: string;
  edge: DropEdge;
  zone: "tabbar" | "body";
  /** Present when hovering a tab bar — visual insert slot. */
  insertIndex?: number;
};

type HighlightBox = {
  top: number;
  left: number;
  width: number;
  height: number;
};

function regionForEdge(leaf: DOMRect, edge: DropEdge): HighlightBox {
  const { top, left, width, height } = leaf;
  switch (edge) {
    case "left":
      return { top, left, width: width / 2, height };
    case "right":
      return { top, left: left + width / 2, width: width / 2, height };
    case "top":
      return { top, left, width, height: height / 2 };
    case "bottom":
      return { top: top + height / 2, left, width, height: height / 2 };
    default:
      return { top, left, width, height };
  }
}

export default function DockWorkspace({
  panes,
  layout,
  onLayoutChange,
}: DockWorkspaceProps) {
  const [drag, setDrag] = useState<DragPane | null>(null);
  const [hover, setHover] = useState<HoverTarget | null>(null);
  const [hostsVersion, setHostsVersion] = useState(0);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const bodyEls = useRef(new Map<string, HTMLElement>());
  const leafEls = useRef(new Map<string, HTMLElement>());
  const tabBarEls = useRef(new Map<string, HTMLElement>());
  const activeHosts = useRef(new Map<PaneId, HTMLElement>());
  const [holdEl, setHoldEl] = useState<HTMLDivElement | null>(null);
  const pointerRef = useRef({ x: 0, y: 0 });
  const stateRef = useRef(layout);
  stateRef.current = layout;
  const onLayoutChangeRef = useRef(onLayoutChange);
  onLayoutChangeRef.current = onLayoutChange;

  useEffect(() => {
    if (!drag) return;
    const move = (ev: PointerEvent) => {
      pointerRef.current = { x: ev.clientX, y: ev.clientY };
    };
    window.addEventListener("pointermove", move);
    return () => window.removeEventListener("pointermove", move);
  }, [drag]);

  // react-resizable-panels focuses the separator while dragging and, while
  // focused, reports data-separator="focus" instead of "hover". Blur on
  // pointerup so a later hover can show the highlight again.
  useEffect(() => {
    const onUp = () => {
      const root = rootRef.current;
      const el = document.activeElement;
      if (
        root &&
        el instanceof HTMLElement &&
        el.hasAttribute("data-separator") &&
        root.contains(el)
      ) {
        el.blur();
      }
    };
    document.addEventListener("pointerup", onUp, true);
    return () => document.removeEventListener("pointerup", onUp, true);
  }, []);

  const commit = useCallback((next: DockState) => {
    onLayoutChangeRef.current(next);
  }, []);

  const closed = useMemo(() => closedPanes(layout), [layout]);
  const visibleCount = visiblePanes(layout).size;

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } })
  );

  const registerBody = useCallback(
    (groupId: string, el: HTMLElement | null) => {
      if (el) bodyEls.current.set(groupId, el);
      else bodyEls.current.delete(groupId);
    },
    []
  );

  const registerLeaf = useCallback(
    (groupId: string, el: HTMLElement | null) => {
      if (el) leafEls.current.set(groupId, el);
      else leafEls.current.delete(groupId);
    },
    []
  );

  const registerBar = useCallback((groupId: string, el: HTMLElement | null) => {
    if (el) tabBarEls.current.set(groupId, el);
    else tabBarEls.current.delete(groupId);
  }, []);

  const registerHost = useCallback((pane: PaneId, el: HTMLElement | null) => {
    if (el) activeHosts.current.set(pane, el);
    else activeHosts.current.delete(pane);
    setHostsVersion((n) => n + 1);
  }, []);

  const onDragStart = useCallback((e: DragStartEvent) => {
    const d = e.active.data.current;
    if (d?.kind !== "tab") return;
    setDrag({ pane: d.pane as PaneId, groupId: d.groupId as string });
  }, []);

  const onDragMove = useCallback(
    (e: DragMoveEvent) => {
      const over = e.over;
      if (!over || !drag) {
        setHover(null);
        return;
      }
      const data = over.data.current;
      if (data?.kind === "tabbar") {
        const groupId = data.groupId as string;
        const bar = tabBarEls.current.get(groupId);
        const insertIndex = bar
          ? insertIndexAtPointer(bar, pointerRef.current.x)
          : undefined;
        setHover({ groupId, edge: "center", zone: "tabbar", insertIndex });
        return;
      }
      if (data?.kind === "body") {
        const groupId = data.groupId as string;
        const el = bodyEls.current.get(groupId);
        const rect = el?.getBoundingClientRect();
        let edge: DropEdge = rect
          ? hitEdge(pointerRef.current.x, pointerRef.current.y, rect)
          : "center";
        // Singleton dragged over its own pane: edges are meaningless — always center.
        if (groupId === drag.groupId) {
          const src = collectGroups(stateRef.current.root).find(
            (g) => g.id === groupId
          );
          if (src && src.tabs.length === 1) edge = "center";
        }
        setHover({ groupId, edge, zone: "body" });
        return;
      }
      setHover(null);
    },
    [drag]
  );

  const onDragEnd = useCallback(
    (e: DragEndEvent) => {
      const active = drag;
      const currentHover = hover;
      setDrag(null);
      setHover(null);
      if (!active || !e.over) return;

      const data = e.over.data.current;
      let groupId: string | null = null;
      let edge: DropEdge = "center";
      let insertIndex = currentHover?.insertIndex;

      if (data?.kind === "tabbar") {
        groupId = data.groupId as string;
        edge = "center";
        const bar = tabBarEls.current.get(groupId);
        if (bar) insertIndex = insertIndexAtPointer(bar, pointerRef.current.x);
      } else if (data?.kind === "body") {
        groupId = data.groupId as string;
        const el = bodyEls.current.get(groupId);
        const rect = el?.getBoundingClientRect();
        edge = rect
          ? hitEdge(pointerRef.current.x, pointerRef.current.y, rect)
          : currentHover?.groupId === groupId
          ? currentHover.edge
          : "center";
        if (groupId === active.groupId) {
          const src = collectGroups(stateRef.current.root).find(
            (g) => g.id === groupId
          );
          if (src && src.tabs.length === 1) edge = "center";
        }
      }
      if (!groupId) return;

      const s = stateRef.current;
      if (edge !== "center") {
        commit(splitLeaf(s, groupId, active.pane, edge));
        return;
      }

      const group = collectGroups(s.root).find((g) => g.id === groupId);
      const index =
        insertIndex != null && group
          ? toMoveIndex(group.tabs, active.pane, insertIndex)
          : undefined;
      commit(moveToGroup(s, active.pane, groupId, index));
    },
    [drag, hover, commit]
  );

  const onDragCancel = useCallback(() => {
    setDrag(null);
    setHover(null);
  }, []);

  // Keep every pane mounted; portal into the active host or a hidden hold.
  void hostsVersion;

  return (
    <DndContext
      id="ide-dock-workspace"
      sensors={sensors}
      collisionDetection={pointerWithin}
      onDragStart={onDragStart}
      onDragMove={onDragMove}
      onDragEnd={onDragEnd}
      onDragCancel={onDragCancel}
    >
      <div ref={rootRef} className="ide-dock-root">
        <DockNodeView
          node={layout.root}
          closed={closed}
          visibleCount={visibleCount}
          hover={hover}
          registerBody={registerBody}
          registerLeaf={registerLeaf}
          registerBar={registerBar}
          registerHost={registerHost}
          onSelect={(groupId, pane) =>
            commit(setActive(stateRef.current, groupId, pane))
          }
          onClose={(groupId, pane) =>
            commit(closeTab(stateRef.current, groupId, pane))
          }
          onOpen={(groupId, pane) =>
            commit(openInGroup(stateRef.current, groupId, pane))
          }
          onSplitSizes={(splitId, sizes) =>
            commit(setSplitSizes(stateRef.current, splitId, sizes))
          }
        />
        <DropHighlight
          rootRef={rootRef}
          leafEls={leafEls}
          hover={hover}
          dragging={Boolean(drag)}
        />
        <div ref={setHoldEl} className="ide-pane-hold" aria-hidden />
        {PANE_IDS.map((pane) => {
          const host = activeHosts.current.get(pane) ?? holdEl;
          return host ? createPortal(panes[pane], host, pane) : null;
        })}
      </div>

      <DragOverlay
        style={{ cursor: "grabbing" }}
        dropAnimation={{
          duration: 180,
          easing: "cubic-bezier(0.16, 1, 0.3, 1)",
        }}
      >
        {drag ? (
          <div className="ide-tab ide-tab-overlay" data-active="true">
            <span className="ide-tab-label">{PANE_LABELS[drag.pane]}</span>
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}

function DropHighlight({
  rootRef,
  leafEls,
  hover,
  dragging,
}: {
  rootRef: RefObject<HTMLDivElement | null>;
  leafEls: RefObject<Map<string, HTMLElement>>;
  hover: HoverTarget | null;
  dragging: boolean;
}) {
  const [box, setBox] = useState<HighlightBox | null>(null);
  const visible = Boolean(dragging && hover?.zone === "body");

  useLayoutEffect(() => {
    if (!dragging) {
      setBox(null);
      return;
    }
    if (!hover || hover.zone !== "body") return;
    const root = rootRef.current;
    const leaf = leafEls.current.get(hover.groupId);
    if (!root || !leaf) return;
    const rootRect = root.getBoundingClientRect();
    const region = regionForEdge(leaf.getBoundingClientRect(), hover.edge);
    setBox({
      top: region.top - rootRect.top,
      left: region.left - rootRect.left,
      width: region.width,
      height: region.height,
    });
  }, [dragging, hover, rootRef, leafEls]);

  // Keep mounted after first body hit so box can morph across groups / edges.
  if (!dragging || !box) return null;

  return (
    <div
      className="ide-drop-overlay"
      data-visible={visible ? "true" : "false"}
      style={{
        top: box.top,
        left: box.left,
        width: box.width,
        height: box.height,
      }}
      aria-hidden
    />
  );
}

function DockNodeView({
  node,
  closed,
  visibleCount,
  hover,
  registerBody,
  registerLeaf,
  registerBar,
  registerHost,
  onSelect,
  onClose,
  onOpen,
  onSplitSizes,
}: {
  node: DockNode;
  closed: PaneId[];
  visibleCount: number;
  hover: HoverTarget | null;
  registerBody: (groupId: string, el: HTMLElement | null) => void;
  registerLeaf: (groupId: string, el: HTMLElement | null) => void;
  registerBar: (groupId: string, el: HTMLElement | null) => void;
  registerHost: (pane: PaneId, el: HTMLElement | null) => void;
  onSelect: (groupId: string, pane: PaneId) => void;
  onClose: (groupId: string, pane: PaneId) => void;
  onOpen: (groupId: string, pane: PaneId) => void;
  onSplitSizes: (splitId: string, sizes: [number, number]) => void;
}) {
  if (isTabGroup(node)) {
    const overThis = hover?.groupId === node.id;
    return (
      <LeafGroup
        group={node}
        closed={closed}
        canClose={visibleCount > 1}
        insertIndex={
          overThis && hover.zone === "tabbar" ? hover.insertIndex ?? null : null
        }
        registerBody={registerBody}
        registerLeaf={registerLeaf}
        registerBar={registerBar}
        registerHost={registerHost}
        onSelect={(pane) => onSelect(node.id, pane)}
        onClose={(pane) => onClose(node.id, pane)}
        onOpen={(pane) => onOpen(node.id, pane)}
      />
    );
  }
  return (
    <SplitView
      split={node}
      closed={closed}
      visibleCount={visibleCount}
      hover={hover}
      registerBody={registerBody}
      registerLeaf={registerLeaf}
      registerBar={registerBar}
      registerHost={registerHost}
      onSelect={onSelect}
      onClose={onClose}
      onOpen={onOpen}
      onSplitSizes={onSplitSizes}
    />
  );
}

function SplitView({
  split,
  closed,
  visibleCount,
  hover,
  registerBody,
  registerLeaf,
  registerBar,
  registerHost,
  onSelect,
  onClose,
  onOpen,
  onSplitSizes,
}: {
  split: SplitNode;
  closed: PaneId[];
  visibleCount: number;
  hover: HoverTarget | null;
  registerBody: (groupId: string, el: HTMLElement | null) => void;
  registerLeaf: (groupId: string, el: HTMLElement | null) => void;
  registerBar: (groupId: string, el: HTMLElement | null) => void;
  registerHost: (pane: PaneId, el: HTMLElement | null) => void;
  onSelect: (groupId: string, pane: PaneId) => void;
  onClose: (groupId: string, pane: PaneId) => void;
  onOpen: (groupId: string, pane: PaneId) => void;
  onSplitSizes: (splitId: string, sizes: [number, number]) => void;
}) {
  const orientation = split.dir === "h" ? "horizontal" : "vertical";
  /* 8px gap between panel cards; hover draws an accent line via CSS. */
  const sepStyle = split.dir === "h" ? { width: 8 } : { height: 8 };
  const childProps = {
    closed,
    visibleCount,
    hover,
    registerBody,
    registerLeaf,
    registerBar,
    registerHost,
    onSelect,
    onClose,
    onOpen,
    onSplitSizes,
  };
  const defaultLayout = {
    [split.children[0].id]: split.sizes[0],
    [split.children[1].id]: split.sizes[1],
  };

  return (
    <Group
      id={split.id}
      orientation={orientation}
      defaultLayout={defaultLayout}
      resizeTargetMinimumSize={{ fine: 10, coarse: 24 }}
      onLayoutChanged={(next) => {
        const a = next[split.children[0].id];
        const b = next[split.children[1].id];
        if (a == null || b == null) return;
        onSplitSizes(split.id, [a, b]);
      }}
      style={{ height: "100%", width: "100%", minHeight: 0, minWidth: 0 }}
    >
      <Panel id={split.children[0].id} minSize="12%">
        <DockNodeView node={split.children[0]} {...childProps} />
      </Panel>
      <Separator id={`${split.id}-sep`} style={sepStyle} />
      <Panel id={split.children[1].id} minSize="12%">
        <DockNodeView node={split.children[1]} {...childProps} />
      </Panel>
    </Group>
  );
}

function LeafGroup({
  group,
  closed,
  canClose,
  insertIndex,
  registerBody,
  registerLeaf,
  registerBar,
  registerHost,
  onSelect,
  onClose,
  onOpen,
}: {
  group: TabGroup;
  closed: PaneId[];
  canClose: boolean;
  insertIndex: number | null;
  registerBody: (groupId: string, el: HTMLElement | null) => void;
  registerLeaf: (groupId: string, el: HTMLElement | null) => void;
  registerBar: (groupId: string, el: HTMLElement | null) => void;
  registerHost: (pane: PaneId, el: HTMLElement | null) => void;
  onSelect: (pane: PaneId) => void;
  onClose: (pane: PaneId) => void;
  onOpen: (pane: PaneId) => void;
}) {
  const { setNodeRef: setDropRef } = useDroppable({
    id: `body-${group.id}`,
    data: { kind: "body", groupId: group.id },
  });

  const setBodyRefs = useCallback(
    (el: HTMLDivElement | null) => {
      setDropRef(el);
      registerBody(group.id, el);
    },
    [setDropRef, registerBody, group.id]
  );

  const setLeafRef = useCallback(
    (el: HTMLDivElement | null) => {
      registerLeaf(group.id, el);
    },
    [registerLeaf, group.id]
  );

  return (
    <div ref={setLeafRef} className="ide-dock-leaf">
      <TabBar
        group={group}
        closed={closed}
        canClose={canClose}
        insertIndex={insertIndex}
        registerBar={registerBar}
        onSelect={onSelect}
        onClose={onClose}
        onOpen={onOpen}
      />
      <div ref={setBodyRefs} className="ide-dock-body">
        {/* One stable host per tab so inactive panes (e.g. Terminal) stay
            mounted when switching — swapping portal containers remounts. */}
        {group.tabs.map((pane) => (
          <PaneHost
            key={pane}
            pane={pane}
            active={pane === group.active}
            registerHost={registerHost}
          />
        ))}
      </div>
    </div>
  );
}

function PaneHost({
  pane,
  active,
  registerHost,
}: {
  pane: PaneId;
  active: boolean;
  registerHost: (pane: PaneId, el: HTMLElement | null) => void;
}) {
  const setRef = useCallback(
    (el: HTMLDivElement | null) => {
      registerHost(pane, el);
    },
    [pane, registerHost]
  );

  return (
    <div
      ref={setRef}
      className="ide-dock-pane"
      data-active={active ? "true" : "false"}
      hidden={!active}
    />
  );
}
