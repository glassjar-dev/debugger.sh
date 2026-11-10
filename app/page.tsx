'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { PanelLeft } from 'lucide-react';
import { toast } from 'sonner';

import CodeEditor from '@/components/CodeEditor';
import { LANGS, type Lang } from '@/components/constants';
import { LanguageSelect } from '@/components/LanguageSelect';
import ResizableWorkspace from '@/components/ResizableWorkspace';
import { ShareButton } from '@/components/ShareButton';
import { RunStopButton } from '@/components/SourceActions';
import Terminal, { type TerminalHandle } from '@/components/Terminal';
import { TestsPanel } from '@/components/TestsPanel';
import { VariablesPanel } from '@/components/VariablesPanel';
import { Explorer, type FileOps } from '@/components/files/Explorer';
import { QuickOpen } from '@/components/files/QuickOpen';
import { activatePane, closeFiles, openFile, renameFiles } from '@/components/dock/ops';
import {
  adoptDockIds,
  defaultDockState,
  filePane,
  openFiles as openFilesIn,
  paneFile,
  parseDockState,
  stackedDockState,
  type DockState,
  type PaneId,
} from '@/components/dock/types';
import { useExecution, type Breakpoints } from '@/hooks/useExecution';
import { getLanguageService } from '@/lib/intellisense/services';
import { runnerReady } from '@/lib/intellisense/runnerReady';
import { getShare } from '@/lib/share/api';
import type { WorkspaceState } from '@/lib/share/types';
import { installTelemetry, Telemetry } from '@/lib/telemetry/client';
import {
  createFile,
  createFolder,
  deletePath,
  entryFile,
  movedPath,
  renamePath,
  starterText,
  writeFile,
  type Workspace,
} from '@/lib/workspace/model';
import { basename, isWithin, normalizePath } from '@/lib/workspace/paths';
import { useWorkspace, useWorkspaceShape, workspaceStore } from '@/lib/workspace/store';

const LANG_IDS = Object.keys(LANGS) as Lang[];
const EXPLORER_PREF = 'glassjar.explorerOpen';
/** Open tabs and splits per language, saved next to the workspaces. */
const LAYOUTS_KEY = 'glassjar.layouts.v1';

function loadLayouts(): Partial<Record<Lang, DockState>> {
  try {
    const saved = JSON.parse(localStorage.getItem(LAYOUTS_KEY) ?? '{}') as Record<string, unknown>;
    const out: Partial<Record<Lang, DockState>> = {};
    for (const l of LANG_IDS) {
      const parsed = parseDockState(saved[l], entryFile(l));
      if (parsed) out[l] = parsed;
    }
    return out;
  } catch {
    return {};
  }
}

function perLang<T>(make: (lang: Lang) => T): Record<Lang, T> {
  return Object.fromEntries(LANG_IDS.map((l) => [l, make(l)])) as Record<Lang, T>;
}

export default function Page() {
  const [lang, setLang] = useState<Lang>('python');
  const entry = entryFile(lang);
  const ws = useWorkspace(lang);
  const shape = useWorkspaceShape(lang);

  // Each language keeps its own arrangement of tabs and splits.
  const [layouts, setLayouts] = useState<Record<Lang, DockState>>(() => perLang((l) => defaultDockState(entryFile(l))));
  const layout = layouts[lang];
  const setLayout = useCallback(
    (update: DockState | ((prev: DockState) => DockState)) =>
      setLayouts((prev) => {
        const next = typeof update === 'function' ? update(prev[lang]) : update;
        return next === prev[lang] ? prev : { ...prev, [lang]: next };
      }),
    [lang],
  );
  const [dockKey, setDockKey] = useState(0);

  const [breakpointsByLang, setBreakpointsByLang] = useState<Record<Lang, Breakpoints>>(() => perLang(() => new Map()));
  const breakpoints = breakpointsByLang[lang];
  const breakpointsRef = useRef(breakpoints);
  breakpointsRef.current = breakpoints;

  // The file you're in: follows editor focus and tab clicks.
  const [activeByLang, setActiveByLang] = useState<Record<Lang, string>>(() => perLang(entryFile));
  const activeFile = shape.paths.includes(activeByLang[lang]) ? activeByLang[lang] : entry;
  const lastGroupRef = useRef<string | null>(null);

  const [shareReady, setShareReady] = useState(false);
  // Off while a share is open, like the workspace store.
  const persistLayoutsRef = useRef(false);
  const [explorerOpen, setExplorerOpen] = useState(true);
  const [quickOpen, setQuickOpen] = useState(false);
  const terminalRef = useRef<TerminalHandle | null>(null);
  // Stable element identity so the xterm instance is not remounted on each IDE render.
  const terminal = useMemo(() => <Terminal ref={terminalRef} />, []);
  const exec = useExecution({ terminalRef });

  // Warm the engine for whichever language is on screen, starting with the default.
  const { warm } = exec;
  useEffect(() => warm(lang), [warm, lang]);

  const setActive = useCallback((path: string) => setActiveByLang((prev) => (prev[lang] === path ? prev : { ...prev, [lang]: path })), [lang]);

  // IntelliSense backends see the whole workspace, so includes, imports and mods resolve.
  // Like the editors, this waits for the run engine to warm up before starting a language worker.
  useEffect(() => {
    let alive = true;
    void runnerReady(lang).then(() => alive && getLanguageService(lang).setFiles?.(ws.files));
    return () => {
      alive = false;
    };
  }, [lang, ws.files]);

  const open = useCallback(
    (path: string) => {
      setLayout((prev) => openFile(prev, path, lastGroupRef.current));
      setActive(path);
    },
    [setLayout, setActive],
  );

  const changeLanguage = useCallback(
    (next: Lang) => {
      if (next === lang) return;
      const from = workspaceStore.get(lang).files[entryFile(lang)] ?? '';
      Telemetry.log('edit', {
        file: entryFile(next),
        offset: 0,
        deleted: from.length,
        inserted: workspaceStore.get(next).files[entryFile(next)] ?? '',
        reason: 'language',
        language: next,
      });
      lastGroupRef.current = null;
      setLang(next);
    },
    [lang],
  );

  const setCode = useCallback(
    (path: string, text: string) => workspaceStore.set(lang, writeFile(workspaceStore.get(lang), path, text)),
    [lang],
  );

  const toggleBreakpoint = useCallback(
    (path: string, line: number) => {
      if (!LANGS[lang].debug) return;
      const current = breakpointsRef.current;
      const lines = new Set(current.get(path));
      const added = !lines.has(line);
      if (added) lines.add(line);
      else lines.delete(line);
      const next = new Map(current);
      if (lines.size) next.set(path, lines);
      else next.delete(path);
      breakpointsRef.current = next;
      Telemetry.log('debug_breakpoint', { file: path, line, added });
      setBreakpointsByLang((prev) => ({ ...prev, [lang]: next }));
      exec.applyBreakpoints(next);
    },
    [exec, lang],
  );

  // ---------------------------------------------------------------------------
  // File operations: the workspace, tabs and breakpoints move together.
  // ---------------------------------------------------------------------------

  const commit = useCallback(
    (next: Workspace, after?: () => void) => {
      workspaceStore.set(lang, next);
      after?.();
    },
    [lang],
  );

  const ops = useMemo<FileOps>(
    () => ({
      create(path, kind) {
        const current = workspaceStore.get(lang);
        const result = kind === 'file' ? createFile(current, path, starterText(path)) : createFolder(current, path);
        if (!result.ok) return result.error;
        commit(result.ws, () => {
          if (kind === 'file') open(normalizePath(path)!);
        });
        return null;
      },
      rename(from, to) {
        const current = workspaceStore.get(lang);
        const result = renamePath(current, from, to, entryFile(lang));
        if (!result.ok) {
          toast.error(result.error);
          return result.error;
        }
        const dest = normalizePath(to)!;
        commit(result.ws, () => {
          const move = (p: string) => movedPath(p, from, dest);
          setLayout((prev) => renameFiles(prev, move));
          setBreakpointsByLang((prev) => {
            const next = new Map<string, ReadonlySet<number>>();
            for (const [p, lines] of prev[lang]) next.set(move(p), lines);
            return { ...prev, [lang]: next };
          });
          setActiveByLang((prev) => ({ ...prev, [lang]: move(prev[lang]) }));
        });
        return null;
      },
      remove(path) {
        const before = workspaceStore.get(lang);
        const result = deletePath(before, path, entryFile(lang));
        if (!result.ok) {
          toast.error(result.error);
          return result.error;
        }
        const layoutBefore = layouts[lang];
        const breakpointsBefore = breakpointsRef.current;
        commit(result.ws, () => {
          setLayout((prev) => closeFiles(prev, (p) => isWithin(p, path), entryFile(lang)));
          setBreakpointsByLang((prev) => {
            const next = new Map([...prev[lang]].filter(([p]) => !isWithin(p, path)));
            return { ...prev, [lang]: next };
          });
        });
        toast(`Deleted ${basename(path)}`, {
          action: {
            label: 'Undo',
            onClick: () => {
              workspaceStore.set(lang, before);
              setLayouts((prev) => ({ ...prev, [lang]: layoutBefore }));
              setBreakpointsByLang((prev) => ({ ...prev, [lang]: breakpointsBefore }));
            },
          },
        });
        return null;
      },
    }),
    [lang, commit, open, setLayout, layouts],
  );

  const onLayoutChange = useCallback(
    (next: DockState) => {
      setLayout(next);
      Telemetry.log('layout_changed', { layout: next });
    },
    [setLayout],
  );

  const onActivate = useCallback(
    (pane: PaneId, groupId: string) => {
      const file = paneFile(pane);
      if (!file) return;
      lastGroupRef.current = groupId;
      setActive(file);
    },
    [setActive],
  );

  /** Bring a pane forward for the user, e.g. Terminal when a run starts. */
  const reveal = useCallback(
    (pane: PaneId) =>
      setLayout((prev) => {
        const next = activatePane(prev, pane);
        if (next !== prev) Telemetry.log('layout_changed', { layout: next });
        return next;
      }),
    [setLayout],
  );

  const debugging = LANGS[lang].debug && [...breakpoints.values()].some((lines) => lines.size > 0);
  const runCode = useCallback(() => {
    reveal('output');
    void exec.run(workspaceStore.get(lang).files, breakpointsRef.current, lang);
  }, [reveal, exec, lang]);

  // Show the pane that has news: tests once a run reports some, variables when paused.
  const hasTests = (exec.testState?.tests.length ?? 0) > 0;
  useEffect(() => {
    if (hasTests) reveal('tests');
  }, [hasTests, reveal]);
  useEffect(() => {
    if (exec.isPaused) reveal('variables');
  }, [exec.isPaused, reveal]);
  // Pausing in another file brings it forward.
  const stoppedPath = exec.stopped?.path;
  useEffect(() => {
    if (stoppedPath) open(stoppedPath);
  }, [stoppedPath, open]);

  // Keyboard: Cmd/Ctrl+Enter runs or continues, +P opens files, +B toggles the explorer.
  // Capture phase so the editor doesn't also handle them.
  const shortcutRef = useRef<(e: KeyboardEvent) => boolean>(() => false);
  shortcutRef.current = (event) => {
    const mod = event.metaKey || event.ctrlKey;
    if (!mod || event.altKey || event.repeat) return false;
    if (event.key === 'Enter') {
      if (exec.isPaused) exec.resume();
      else if (!exec.isRunning && shareReady) runCode();
      return true;
    }
    if (event.key.toLowerCase() === 'p' && !event.shiftKey) {
      setQuickOpen(true);
      return true;
    }
    if (event.key.toLowerCase() === 'b' && !event.shiftKey) {
      setExplorerOpen((v) => !v);
      return true;
    }
    return false;
  };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!shortcutRef.current(event)) return;
      event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  // Remember whether the explorer is open; phones start with it closed.
  useEffect(() => {
    try {
      const saved = localStorage.getItem(EXPLORER_PREF);
      if (saved != null) setExplorerOpen(saved === '1');
      else if (window.matchMedia('(max-width: 760px)').matches) setExplorerOpen(false);
    } catch {
      // Storage blocked: keep the default.
    }
  }, []);
  const toggleExplorer = useCallback(() => {
    setExplorerOpen((v) => {
      try {
        localStorage.setItem(EXPLORER_PREF, v ? '0' : '1');
      } catch {
        // Storage blocked: the choice lasts for this visit.
      }
      return !v;
    });
  }, []);

  const getShareState = useCallback(
    (): WorkspaceState => ({ lang, files: { ...ws.files }, ...(ws.dirs.length ? { dirs: [...ws.dirs] } : {}), layout }),
    [lang, ws, layout],
  );

  useLayoutEffect(() => installTelemetry(), []);

  useLayoutEffect(() => {
    if (!shareReady) return;
    const shareId = window.location.pathname.replace(/^\/+|\/+$/g, '');
    const current = workspaceStore.get(lang);
    Telemetry.startSession({
      language: lang,
      code: current.files[entryFile(lang)] ?? '',
      files: { ...current.files },
      layout,
      shareId: shareId || undefined,
    });
    // Session start reads the workspace as it became usable. Later edits are logged separately.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shareReady]);

  useEffect(() => {
    // Side-by-side panes don't fit a phone; stack them unless a share brings its own layout.
    const narrow = window.matchMedia('(max-width: 760px)').matches;
    const shareId = window.location.pathname.replace(/^\/+|\/+$/g, '');
    const saved = shareId ? {} : loadLayouts();
    setLayouts(perLang((l) => saved[l] ?? (narrow ? stackedDockState(entryFile(l)) : defaultDockState(entryFile(l)))));
    for (const layout of Object.values(saved)) adoptDockIds(layout);
    setDockKey((k) => k + 1);

    if (!shareId) {
      persistLayoutsRef.current = true;
      setShareReady(true);
      return;
    }

    // A share opens as its own workspace and never overwrites the one saved on this device.
    workspaceStore.setPersistence(false);
    let cancelled = false;
    void (async () => {
      try {
        const state = await getShare(shareId);
        if (cancelled || !state) return;
        workspaceStore.set(state.lang, { files: state.files, dirs: state.dirs ?? [] });
        setLang(state.lang);
        if (state.layout) {
          adoptDockIds(state.layout);
          setLayouts((prev) => ({ ...prev, [state.lang]: state.layout! }));
          setDockKey((k) => k + 1);
        }
      } catch (err) {
        console.error('failed to load share', err);
      } finally {
        if (!cancelled) setShareReady(true);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!persistLayoutsRef.current) return;
    const timer = setTimeout(() => {
      try {
        localStorage.setItem(LAYOUTS_KEY, JSON.stringify(layouts));
      } catch {
        // Storage blocked: layouts last for this visit.
      }
    }, 400);
    return () => clearTimeout(timer);
  }, [layouts]);

  // A layout from storage or a share may name files that no longer exist. Ask the store
  // itself: during hydration the hook still returns the default workspace.
  useEffect(() => {
    const files = workspaceStore.get(lang).files;
    setLayout((prev) => closeFiles(prev, (p) => !Object.hasOwn(files, p), entry));
  }, [shape, entry, lang, setLayout]);

  const open_ = useMemo(() => openFilesIn(layout), [layout]);
  const openSet = useMemo(() => new Set(open_), [open_]);

  const panes: Partial<Record<PaneId, React.ReactNode>> = {
    variables: (
      <VariablesPanel
        canDebug={LANGS[lang].debug}
        isRunning={exec.isRunning}
        hasBreakpoints={debugging}
        frames={exec.frames}
        selectedFrameId={exec.selectedFrameId}
        onSelectFrame={exec.selectFrame}
        scopes={exec.scopes}
        expandVariable={exec.expandVariable}
        isPaused={exec.isPaused}
        debugControls={{
          onContinue: exec.resume,
          onStepOver: exec.stepOver,
          onStepIn: exec.stepIn,
          onStepOut: exec.stepOut,
        }}
      />
    ),
    output: terminal,
    tests: <TestsPanel lang={lang} state={exec.testState} isRunning={exec.isRunning} />,
  };
  for (const path of open_) {
    if (!Object.hasOwn(ws.files, path)) continue;
    panes[filePane(path)] = shareReady ? (
      <CodeEditor
        lang={lang}
        path={path}
        value={ws.files[path]!}
        onChange={(text) => setCode(path, text)}
        breakpoints={breakpoints.get(path) ?? EMPTY}
        onToggleBreakpoint={(line) => toggleBreakpoint(path, line)}
        stoppedLine={exec.stopped?.path === path ? exec.stopped.line : null}
        onFocus={() => setActive(path)}
      />
    ) : (
      <div />
    );
  }

  const recent = useMemo(() => [activeFile, ...open_.filter((p) => p !== activeFile)], [activeFile, open_]);

  return (
    <main className="ide-page" data-loading={shareReady ? undefined : 'true'}>
      <header className="ide-topbar">
        <button
          type="button"
          className="gj-icon-btn gj-sidebar-toggle"
          aria-label="Toggle files"
          aria-pressed={explorerOpen}
          title="Files (⌘B / Ctrl+B)"
          onClick={toggleExplorer}
        >
          <PanelLeft size={16} />
        </button>
        <Logo />
        <LanguageSelect value={lang} onChange={changeLanguage} disabled={exec.isRunning} />
        <div className="ide-topbar-spacer" />
        <RunStatus
          isRunning={exec.isRunning}
          isPaused={exec.isPaused}
          stopped={exec.stopped}
          multiFile={shape.paths.length > 1}
        />
        <div className="ide-main-dock">
          <ShareButton getState={getShareState} />
          <RunStopButton isRunning={exec.isRunning} debug={debugging} onRun={runCode} onStop={exec.stop} />
        </div>
      </header>
      <div className="ide-body" data-explorer={explorerOpen ? 'open' : 'closed'}>
        <Explorer lang={lang} entry={entry} activeFile={activeFile} openFiles={openSet} onOpen={open} ops={ops} />
        <ResizableWorkspace
          key={`${lang}-${dockKey}`}
          layout={layout}
          onLayoutChange={onLayoutChange}
          onActivate={onActivate}
          panes={panes}
        />
      </div>
      {quickOpen && (
        <QuickOpen
          paths={shape.paths}
          recent={recent}
          onOpen={open}
          onCreate={(path) => ops.create(path, 'file')}
          onClose={() => setQuickOpen(false)}
        />
      )}
      {!shareReady && (
        <div className="ide-boot-overlay" aria-busy="true" aria-label="Loading share">
          <div className="ide-boot-spinner" />
        </div>
      )}
    </main>
  );
}

const EMPTY: ReadonlySet<number> = new Set();

function RunStatus({
  isRunning,
  isPaused,
  stopped,
  multiFile,
}: {
  isRunning: boolean;
  isPaused: boolean;
  stopped: { path: string; line: number } | null;
  multiFile: boolean;
}) {
  const state = isPaused ? 'paused' : isRunning ? 'running' : 'idle';
  const where = stopped ? (multiFile ? `${basename(stopped.path)}:${stopped.line}` : `line ${stopped.line}`) : null;
  const text = isPaused ? (where ? `Paused on ${where}` : 'Paused') : isRunning ? 'Running' : 'Ready';
  return (
    <span className="ide-status" data-state={state} role="status" aria-live="polite">
      <span className="ide-status-dot" aria-hidden />
      {text}
    </span>
  );
}

const Logo = () => (
  <a
    className="ide-brand"
    href="https://github.com/glassjar-dev"
    target="_blank"
    rel="noreferrer"
    title="glassjar on GitHub"
  >
    <JarMark />
    <span className="ide-brand-name">glassjar</span>
  </a>
);

/** A jar you can see into: outline, lid, and a liquid level. */
function JarMark() {
  return (
    <svg className="ide-brand-mark" width="20" height="22" viewBox="0 0 20 22" fill="none" aria-hidden>
      <defs>
        <linearGradient id="gj-liquid" x1="0" y1="11" x2="0" y2="20" gradientUnits="userSpaceOnUse">
          <stop stopColor="#7cc4ff" />
          <stop offset="1" stopColor="#3b9eff" />
        </linearGradient>
      </defs>
      <rect x="5" y="1" width="10" height="3" rx="1.2" fill="#a6acb6" />
      <path
        d="M6 4h8v1.6c0 .5.3 1 .7 1.3C16.8 8.3 18 10 18 12.6V18a3 3 0 0 1-3 3H5a3 3 0 0 1-3-3v-5.4C2 10 3.2 8.3 5.3 6.9c.4-.3.7-.8.7-1.3V4Z"
        stroke="#e8eaed"
        strokeOpacity="0.75"
        strokeWidth="1.3"
      />
      <path
        d="M3.4 12.2c2.2-1 4.4 1 6.6 0s4.4-1 6.6 0V18a1.7 1.7 0 0 1-1.7 1.7H5.1A1.7 1.7 0 0 1 3.4 18v-5.8Z"
        fill="url(#gj-liquid)"
        fillOpacity="0.85"
      />
      <path d="M5.2 9.5c-.6.6-1 1.2-1.1 1.9" stroke="#fff" strokeOpacity="0.55" strokeWidth="1.1" strokeLinecap="round" />
    </svg>
  );
}
