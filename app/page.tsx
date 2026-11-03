'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import CodeEditor from '@/components/CodeEditor';
import { LANGS, type Lang } from '@/components/constants';
import { LanguageSelect } from '@/components/LanguageSelect';
import ResizableWorkspace from '@/components/ResizableWorkspace';
import { ShareButton } from '@/components/ShareButton';
import { RunStopButton } from '@/components/SourceActions';
import Terminal, { type TerminalHandle } from '@/components/Terminal';
import { TestsPanel } from '@/components/TestsPanel';
import { VariablesPanel } from '@/components/VariablesPanel';
import { activatePane } from '@/components/dock/ops';
import {
  adoptDockIds,
  defaultDockState,
  stackedDockState,
  type DockState,
  type PaneId,
} from '@/components/dock/types';
import { useExecution } from '@/hooks/useExecution';
import { getShare } from '@/lib/share/api';
import type { WorkspaceState } from '@/lib/share/types';
import { installTelemetry, Telemetry } from '@/lib/telemetry/client';

function initialSources(): Record<Lang, string> {
  return Object.fromEntries(
    Object.entries(LANGS).map(([lang, cfg]) => [lang, cfg.defaultCode]),
  ) as Record<Lang, string>;
}

function initialBreakpoints(): Record<Lang, Set<number>> {
  return Object.fromEntries(
    Object.keys(LANGS).map((lang) => [lang, new Set<number>()]),
  ) as Record<Lang, Set<number>>;
}

export default function Page() {
  const [lang, setLang] = useState<Lang>('c');
  const [sources, setSources] = useState<Record<Lang, string>>(initialSources);
  const [breakpointsByLang, setBreakpointsByLang] =
    useState<Record<Lang, Set<number>>>(initialBreakpoints);
  const [layout, setLayout] = useState<DockState>(defaultDockState);
  const [dockKey, setDockKey] = useState(0);
  const [shareReady, setShareReady] = useState(false);
  const terminalRef = useRef<TerminalHandle | null>(null);
  // Stable element identity so the xterm instance is not remounted on each IDE render.
  const terminal = useMemo(() => <Terminal ref={terminalRef} />, []);
  const exec = useExecution({ terminalRef });

  const code = sources[lang];
  const breakpoints = breakpointsByLang[lang];
  const breakpointsRef = useRef(breakpoints);
  breakpointsRef.current = breakpoints;

  const setCode = useCallback(
    (next: string) => setSources((prev) => ({ ...prev, [lang]: next })),
    [lang],
  );

  const changeLanguage = useCallback(
    (next: Lang) => {
      if (next === lang) return;
      Telemetry.log('edit', {
        offset: 0,
        deleted: sources[lang].length,
        inserted: sources[next],
        reason: 'language',
        language: next,
      });
      setLang(next);
    },
    [lang, sources],
  );

  const toggleBreakpoint = useCallback(
    (line: number) => {
      if (!LANGS[lang].debug) return;
      const current = breakpointsRef.current;
      const added = !current.has(line);
      const next = new Set(current);
      if (added) next.add(line);
      else next.delete(line);
      breakpointsRef.current = next;
      Telemetry.log('debug_breakpoint', { line, added });
      setBreakpointsByLang((prev) => ({ ...prev, [lang]: next }));
      exec.applyBreakpoints(next);
    },
    [exec, lang],
  );

  const onLayoutChange = useCallback((next: DockState) => {
    setLayout(next);
    Telemetry.log('layout_changed', { layout: next });
  }, []);

  /** Bring a pane forward for the user, e.g. Terminal when a run starts. */
  const reveal = useCallback(
    (pane: PaneId) =>
      setLayout((prev) => {
        const next = activatePane(prev, pane);
        if (next !== prev) Telemetry.log('layout_changed', { layout: next });
        return next;
      }),
    [],
  );

  const debugging = LANGS[lang].debug && breakpoints.size > 0;
  const runCode = useCallback(() => {
    reveal('output');
    void exec.run(code, breakpoints, lang);
  }, [reveal, exec, code, breakpoints, lang]);

  // Show the pane that has news: tests once a run reports some, variables when paused.
  const hasTests = (exec.testState?.tests.length ?? 0) > 0;
  useEffect(() => {
    if (hasTests) reveal('tests');
  }, [hasTests, reveal]);
  useEffect(() => {
    if (exec.isPaused) reveal('variables');
  }, [exec.isPaused, reveal]);

  // Cmd/Ctrl+Enter: run, or continue while paused. Capture phase so the editor
  // doesn't also insert a blank line.
  const shortcutRef = useRef<() => void>(() => {});
  shortcutRef.current = () => {
    if (exec.isPaused) exec.resume();
    else if (!exec.isRunning && shareReady) runCode();
  };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Enter' || !(event.metaKey || event.ctrlKey) || event.repeat) return;
      event.preventDefault();
      event.stopPropagation();
      shortcutRef.current();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  const getShareState = useCallback(
    (): WorkspaceState => ({ lang, code, layout }),
    [lang, code, layout],
  );

  useLayoutEffect(() => installTelemetry(), []);

  useLayoutEffect(() => {
    if (!shareReady) return;
    const shareId = window.location.pathname.replace(/^\/+|\/+$/g, '');
    Telemetry.startSession({
      language: lang,
      code,
      layout,
      shareId: shareId || undefined,
    });
    // Session start reads the workspace as it became usable. Later edits are logged separately.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shareReady]);

  useEffect(() => {
    // Side-by-side panes don't fit a phone; stack them unless a share brings its own layout.
    const narrow = window.matchMedia('(max-width: 760px)').matches;
    if (narrow) {
      setLayout(stackedDockState());
      setDockKey((k) => k + 1);
    }

    const shareId = window.location.pathname.replace(/^\/+|\/+$/g, '');
    if (!shareId) {
      setShareReady(true);
      return;
    }

    let cancelled = false;
    void (async () => {
      try {
        const state = await getShare(shareId);
        if (cancelled || !state) return;
        setLang(state.lang);
        setSources((prev) => ({ ...prev, [state.lang]: state.code }));
        if (state.layout) {
          adoptDockIds(state.layout);
          setLayout(state.layout);
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

  return (
    <main className="ide-page" data-loading={shareReady ? undefined : 'true'}>
      <header className="ide-topbar">
        <Logo />
        <LanguageSelect value={lang} onChange={changeLanguage} disabled={exec.isRunning} />
        <div className="ide-topbar-spacer" />
        <RunStatus isRunning={exec.isRunning} isPaused={exec.isPaused} line={exec.stoppedLine} />
        <div className="ide-main-dock">
          <ShareButton getState={getShareState} />
          <RunStopButton
            isRunning={exec.isRunning}
            debug={debugging}
            onRun={runCode}
            onStop={exec.stop}
          />
        </div>
      </header>
      <ResizableWorkspace
        key={dockKey}
        layout={layout}
        onLayoutChange={onLayoutChange}
        panes={{
          editor: shareReady ? (
            <CodeEditor
              lang={lang}
              value={code}
              onChange={setCode}
              breakpoints={breakpoints}
              onToggleBreakpoint={toggleBreakpoint}
              stoppedLine={exec.stoppedLine}
            />
          ) : (
            <div />
          ),
          variables: (
            <VariablesPanel
              canDebug={LANGS[lang].debug}
              isRunning={exec.isRunning}
              hasBreakpoints={breakpoints.size > 0}
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
        }}
      />
      {!shareReady && (
        <div className="ide-boot-overlay" aria-busy="true" aria-label="Loading share">
          <div className="ide-boot-spinner" />
        </div>
      )}
    </main>
  );
}

function RunStatus({
  isRunning,
  isPaused,
  line,
}: {
  isRunning: boolean;
  isPaused: boolean;
  line: number | null;
}) {
  const state = isPaused ? 'paused' : isRunning ? 'running' : 'idle';
  const text = isPaused ? (line != null ? `Paused on line ${line}` : 'Paused') : isRunning ? 'Running' : 'Ready';
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
