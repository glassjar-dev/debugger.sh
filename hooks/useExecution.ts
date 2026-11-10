'use client';

import { Engine } from 'debugger-sh';
import { useCallback, useEffect, useRef, useState } from 'react';

import { LANGS, type Lang } from '@/components/constants';
import type {
  DapResponse,
  DapVariable,
  Scope,
  ScopeView,
  StackFrame,
} from '@/components/dap-types';
import type { TerminalHandle } from '@/components/Terminal';
import { toDebugFrame } from '@/lib/telemetry/map';
import { Telemetry } from '@/lib/telemetry/client';
import type { TestCase } from '@/lib/telemetry/types';
import { loadStanfordArtifacts } from '@/lib/stanford/loadArtifacts';
import { mergeDirNodes, pathsToDirNode } from '@/lib/stanford/fsTree';
import { prepareCppRun } from '@/lib/testing/prepare';
import {
  createTestReportDecoder,
  type TestResult,
  type TestRunState,
} from '@/lib/testing/protocol';

/** SimpleTest runner / registry frames — hide from the call stack while debugging tests. */
function isSimpleTestHarnessFrame(frame: StackFrame): boolean {
  const path = frame.source?.path ?? '';
  if (/SimpleTest(?:_runner)?\.(?:cpp|c|h)$/i.test(path)) return true;
  if (/simpletest::/i.test(frame.name)) return true;
  return false;
}

/** Normalize DAP / DWARF source paths for comparison with LANGS[*].sourcePath. */
function normalizeSourcePath(path: string | undefined | null): string {
  if (!path) return '';
  let p = path.startsWith('file://') ? path.slice('file://'.length) : path;
  p = p.replace(/\\/g, '/');
  if (!p.startsWith('/')) p = `/${p}`;
  return p;
}

/** True when the frame is the single editable main file (never library / harness). */
function isMainSource(
  path: string | undefined | null,
  mainPath: string
): boolean {
  return normalizeSourcePath(path) === normalizeSourcePath(mainPath);
}

type StopReason = 'breakpoint' | 'step' | 'exception' | 'pause';

function mapStopReason(msg: unknown): StopReason {
  const reason = (msg as { body?: { reason?: string } }).body?.reason ?? '';
  if (reason === 'step') return 'step';
  if (reason === 'exception') return 'exception';
  if (reason === 'pause') return 'pause';
  if (reason.includes('breakpoint')) return 'breakpoint';
  return 'pause';
}

function testsFrom(decoder: { state: TestRunState } | null): TestCase[] | undefined {
  if (!decoder) return undefined;
  const { tests, results } = decoder.state;
  if (tests.length === 0 && results.size === 0) return undefined;
  const cases: TestCase[] = [];
  const seen = new Set<string>();
  const push = (name: string, result: TestResult | undefined, fallbackLine?: number) => {
    const row: TestCase = { name, passed: result?.status === 'passed' };
    if (result?.expected) row.expected = result.expected;
    if (result?.actual) row.actual = result.actual;
    const line = result?.line ?? fallbackLine;
    if (line !== undefined) row.line = line;
    if (result?.message) row.message = result.message;
    cases.push(row);
  };
  for (const info of tests) {
    seen.add(info.key);
    push(info.name, results.get(info.key), info.line);
  }
  for (const result of results.values()) {
    if (!seen.has(result.key)) push(result.key, result);
  }
  return cases;
}

export type UseExecutionOptions = {
  terminalRef: React.RefObject<TerminalHandle | null>;
};

export type ExecutionApi = {
  isRunning: boolean;
  isPaused: boolean;
  stoppedLine: number | null;
  frames: StackFrame[];
  selectedFrameId: number | null;
  scopes: ScopeView[];
  debugLoading: boolean;
  testState: TestRunState | null;
  run: (
    code: string,
    breakpoints: ReadonlySet<number>,
    lang: Lang
  ) => Promise<void>;
  stop: () => void;
  resume: () => void;
  stepOver: () => void;
  stepIn: () => void;
  stepOut: () => void;
  selectFrame: (id: number) => void;
  /** Sync DAP `variables` request — returns child variables or [] on failure. */
  expandVariable: (ref: number) => DapVariable[];
  /** Push a new breakpoint set to the running runtime (no-op if not running). */
  applyBreakpoints: (breakpoints: ReadonlySet<number>) => void;
};

export function useExecution({
  terminalRef,
}: UseExecutionOptions): ExecutionApi {
  const [isRunning, setIsRunning] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [stoppedLine, setStoppedLine] = useState<number | null>(null);
  const [frames, setFrames] = useState<StackFrame[]>([]);
  const [selectedFrameId, setSelectedFrameId] = useState<number | null>(null);
  const [scopes, setScopes] = useState<ScopeView[]>([]);
  const [debugLoading, setDebugLoading] = useState(false);
  const [testState, setTestState] = useState<TestRunState | null>(null);

  const runtimeRef = useRef<Engine | null>(null);
  /** One Engine per language — recreating each Run re-fetches ~80MB of toolchain. */
  const enginesRef = useRef<Partial<Record<Lang, Engine>>>({});
  const engineInitRef = useRef<Partial<Record<Lang, Promise<Engine>>>>({});
  const priorRunRef = useRef<Promise<unknown> | null>(null);
  /** The C++ compiler warm-up started on mount; the first C++ Run waits for it. */
  const preparingRef = useRef<Promise<unknown> | null>(null);
  const isRunningRef = useRef(false);
  const dapSeqRef = useRef(1);
  const ioCleanupRef = useRef<(() => void) | null>(null);
  const stdinDisposeRef = useRef<(() => void) | null>(null);
  const breakpointsRef = useRef<ReadonlySet<number>>(new Set());
  const langRef = useRef<Lang>('c');
  const testDecoderRef = useRef<ReturnType<typeof createTestReportDecoder> | null>(null);
  const testStateRafRef = useRef<number | null>(null);
  const stdoutBufferRef = useRef('');
  /** Bumped on each `stopped` (and when auto-skipping library stops) so twin refreshes stay coherent. */
  const debugRefreshGenRef = useRef(0);
  const stopReasonRef = useRef<StopReason>('pause');
  const autoSkipStopRef = useRef(false);
  const emittedStopGenRef = useRef(-1);
  const getEngine = useCallback(async (lang: Lang): Promise<Engine> => {
    const existing = enginesRef.current[lang];
    if (existing) return existing;
    let pending = engineInitRef.current[lang];
    if (!pending) {
      // scripts/copy-engine-wasm.mjs puts the engine's own Wasm in public/.
      pending = Engine.create(lang as Parameters<typeof Engine.create>[0], {
        wasmUrl: '/engine_bg.wasm',
      }).then((engine) => {
        enginesRef.current[lang] = engine;
        return engine;
      });
      engineInitRef.current[lang] = pending;
    }
    return pending;
  }, []);

  // Start the C++ worker and compiler as soon as the IDE mounts, so the first Run only
  // builds, and fetch the common (non-debug) Stanford artifacts. Debug archives load on demand.
  useEffect(() => {
    preparingRef.current = getEngine('c').then((engine) => engine.prepareCompiler());
    void loadStanfordArtifacts('run');
  }, [getEngine]);

  const dapSend = useCallback(
    <T>(command: string, args: Record<string, unknown>) => {
      const rt = runtimeRef.current;
      if (!rt) return null;
      const res = rt.debugger.send({
        type: 'request',
        seq: dapSeqRef.current++,
        command,
        arguments: args,
      });
      return res as DapResponse<T> | null;
    },
    []
  );

  const sendBreakpoints = useCallback(() => {
    const lines = Array.from(breakpointsRef.current).sort((a, b) => a - b);
    dapSend('setBreakpoints', {
      source: { path: LANGS[langRef.current].sourcePath },
      breakpoints: lines.map((line) => ({ line })),
    });
  }, [dapSend]);

  /** Steps 5–8 in the engine DAP lifecycle; returns true once the worker is unblocked. */
  const completeDapHandshake = useCallback((): boolean => {
    sendBreakpoints();
    dapSend('setExceptionBreakpoints', { filters: [] });
    const res = dapSend('configurationDone', {}) as DapResponse<unknown> | null;
    return res?.success === true;
  }, [dapSend, sendBreakpoints]);

  const loadFrame = useCallback(
    (frameId: number): ScopeView[] => {
      const scopeRes = dapSend<{ scopes: Scope[] }>('scopes', { frameId });
      const list = scopeRes?.body?.scopes ?? [];
      const views: ScopeView[] = list.map((sc) => {
        const v = dapSend<{ variables: DapVariable[] }>('variables', {
          variablesReference: sc.variablesReference,
        });
        return { name: sc.name, variables: v?.body?.variables ?? [] };
      });
      setScopes(views);
      return views;
    },
    [dapSend]
  );

  const refreshDebugSession = useCallback(
    (expectedGen: number) => {
      // Twin timeouts from scheduleDebugRefresh share one gen; skip stale ones.
      if (expectedGen !== debugRefreshGenRef.current) return;
      setDebugLoading(true);
      try {
        const res = dapSend<{ stackFrames: StackFrame[] }>('stackTrace', {
          threadId: 1,
        });
        if (!res?.success) return;
        if (expectedGen !== debugRefreshGenRef.current) return;

        const raw = res.body?.stackFrames ?? [];
        // Stack can lag the stopped event — leave the twin refresh to retry.
        if (raw.length === 0) return;

        const mainPath = LANGS[langRef.current].sourcePath;

        // Just-my-code: never surface a pause whose PC is outside the main file
        // (Stanford headers, libc++, SimpleTest harness, etc.).
        if (!isMainSource(raw[0]?.source?.path, mainPath)) {
          // Invalidate sibling refresh so we don't double-resume.
          debugRefreshGenRef.current += 1;
          // Keep the original stop reason across the automatic step-out.
          autoSkipStopRef.current = true;
          // Return to the caller so step-through keeps going on the next main-file line.
          dapSend('stepOut', { threadId: 1 });
          setIsPaused(false);
          setStoppedLine(null);
          setFrames([]);
          setSelectedFrameId(null);
          setScopes([]);
          return;
        }

        // Hide SimpleTest runner / harness frames when stopped inside a test.
        const fs = raw.filter((frame) => !isSimpleTestHarnessFrame(frame));
        setFrames(fs);
        if (fs.length === 0) {
          setSelectedFrameId(null);
          setStoppedLine(null);
          setScopes([]);
          return;
        }
        setStoppedLine(fs[0].line);
        setSelectedFrameId(fs[0].id);
        const views = loadFrame(fs[0].id);
        if (emittedStopGenRef.current !== expectedGen) {
          emittedStopGenRef.current = expectedGen;
          const line = fs[0].line;
          Telemetry.log('debug_stop', {
            reason: stopReasonRef.current,
            ...(line > 0 ? { line } : {}),
            frame_count: fs.length,
            top_frame: toDebugFrame(0, fs[0].name, views),
          });
        }
      } finally {
        setDebugLoading(false);
      }
    },
    [dapSend, loadFrame]
  );

  const scheduleDebugRefresh = useCallback(() => {
    const gen = debugRefreshGenRef.current;
    const run = () => refreshDebugSession(gen);
    window.setTimeout(run, 0);
    window.setTimeout(run, 50);
  }, [refreshDebugSession]);

  const clearDebug = useCallback(() => {
    setIsPaused(false);
    setStoppedLine(null);
    setFrames([]);
    setSelectedFrameId(null);
    setScopes([]);
    setDebugLoading(false);
  }, []);

  const teardown = useCallback(() => {
    ioCleanupRef.current?.();
    ioCleanupRef.current = null;
    stdinDisposeRef.current?.();
    stdinDisposeRef.current = null;
    runtimeRef.current = null;
    isRunningRef.current = false;
    testDecoderRef.current = null;
  }, []);

  const wireStdout = useCallback(
    (rt: Engine) => {
      const stdoutDecoder = new TextDecoder();
      const stderrDecoder = new TextDecoder();
      // Buffer program output and flush via terminalRef on each chunk. Reading
      // the ref at write-time avoids a stale xterm handle if React remounts the
      // terminal while the run is in flight.
      const onData = (kind: 'stdout' | 'stderr', decoder: TextDecoder) => (chunk: Uint8Array) => {
        const text = decoder.decode(chunk);
        const filtered = testDecoderRef.current
          ? testDecoderRef.current.push(text)
          : text;
        if (filtered) {
          Telemetry.log('run_io', { kind, data: filtered });
          // Keep a durable copy — xterm can remount when the Tests panel
          // updates, which would otherwise drop live writes.
          stdoutBufferRef.current += filtered.replace(/\r?\n/g, '\r\n');
          terminalRef.current?.write(filtered.replace(/\r?\n/g, '\r\n'));
        }
        if (testDecoderRef.current) {
          if (testStateRafRef.current == null) {
            testStateRafRef.current = requestAnimationFrame(() => {
              testStateRafRef.current = null;
              const decoder = testDecoderRef.current;
              if (!decoder) return;
              setTestState({
                ...decoder.state,
                results: new Map(decoder.state.results),
              });
            });
          }
        }
      };
      const onStdout = onData('stdout', stdoutDecoder);
      const onStderr = onData('stderr', stderrDecoder);
      rt.stdout.on('data', onStdout);
      rt.stderr.on('data', onStderr);
      ioCleanupRef.current = () => {
        rt.stdout.off('data', onStdout);
        rt.stderr.off('data', onStderr);
      };
    },
    [terminalRef]
  );

  const wireStdin = useCallback(
    (rt: Engine) => {
      const term = terminalRef.current;
      if (!term) return;
      const encoder = new TextEncoder();
      let buffer = '';
      stdinDisposeRef.current = term.onData((data) => {
        if (!isRunningRef.current) return;
        Telemetry.log('run_io', { kind: 'stdin', data });
        if (data === '\x03') {
          term.write('^C\r\n');
          rt.stop();
          return;
        }
        if (data === '\x04') {
          term.write('^D\r\n');
          void rt.stdin.write(encoder.encode('\x04'));
          buffer = '';
          return;
        }
        if (data === '\x0c') {
          term.clear();
          buffer = '';
          return;
        }
        if (data === '\r') {
          term.write('\r\n');
          void rt.stdin.write(encoder.encode(`${buffer}\n`));
          buffer = '';
          return;
        }
        if (data === '\u007f') {
          if (buffer.length > 0) {
            buffer = buffer.slice(0, -1);
            term.write('\b \b');
          }
          return;
        }
        if (data.startsWith('\x1b')) return;
        buffer += data;
        term.write(data);
      });
    },
    [terminalRef]
  );

  const run = useCallback(
    async (code: string, breakpoints: ReadonlySet<number>, lang: Lang) => {
      if (isRunningRef.current) return;
      Telemetry.log('run_start');
      let finish: {
        reason: 'completed' | 'error' | 'stopped';
        exit_code?: number;
        build_ms?: number;
        run_ms?: number;
      } = { reason: 'error' };
      const started = performance.now();
      langRef.current = lang;
      const { fsKey } = LANGS[lang];
      breakpointsRef.current = breakpoints;
      // Prefer a fast non-debug build when nothing needs DWARF / instrumentation.
      const wantsDebug = LANGS[lang].debug && breakpoints.size > 0;
      teardown();
      clearDebug();
      setTestState(null);
      stdoutBufferRef.current = '';
      setIsRunning(true);
      isRunningRef.current = true;
      terminalRef.current?.clear();
      terminalRef.current?.focus();

      try {
        if (typeof window !== 'undefined' && !window.crossOriginIsolated) {
          terminalRef.current?.writeln(
            '\r\n[ide warning] SharedArrayBuffer is unavailable (crossOriginIsolated=false). ' +
              'Run via `npm run dev` — not a static export preview.'
          );
        }

        // A reused Engine returns the prior promise if run() is still settling.
        if (priorRunRef.current) {
          await priorRunRef.current.catch(() => undefined);
        }
        // An engine runs one job at a time, so let the C++ warm-up finish first.
        if (lang === 'c' && preparingRef.current) {
          await preparingRef.current.catch(() => undefined);
          preparingRef.current = null;
        }

        const rt = await getEngine(lang);
        runtimeRef.current = rt;
        if (lang === 'python') rt.debugger.filterInternals = true;
        dapSeqRef.current = 1;

        wireStdout(rt);
        wireStdin(rt);
        rt.debugger.enabled = wantsDebug;

        if (lang === 'c') {
          const prepared = prepareCppRun(code, fsKey);
          const stanford = await loadStanfordArtifacts(wantsDebug ? 'debug' : 'run');
          rt.fs = mergeDirNodes(
            pathsToDirNode(stanford.fsFiles),
            pathsToDirNode(prepared.files),
          );
          rt.binaryFiles = { ...stanford.binaryFiles };
          const studentSourcePath = `/${fsKey}`;
          rt.cppArtifacts = {
            ...stanford.cppArtifacts,
            sources: prepared.hasTests
              ? [studentSourcePath, ...prepared.extraSources]
              : [studentSourcePath],
          };
          if (prepared.hasTests) {
            testDecoderRef.current = createTestReportDecoder(prepared.nonce);
            // Defer React state updates until after the engine is wired so a
            // re-render cannot remount the terminal mid-setup.
          }
        } else {
          rt.fs = { [fsKey]: code };
        }

        const handshakeDoneRef = { current: !wantsDebug };
        const tryDapHandshake = () => {
          if (handshakeDoneRef.current) return true;
          if (completeDapHandshake()) {
            handshakeDoneRef.current = true;
            return true;
          }
          return false;
        };

        const onDebuggerEvent = (msg: unknown) => {
          const m = msg as { type?: string; event?: string };
          if (m?.type !== 'event') return;
          if (m.event === 'initialized') {
            tryDapHandshake();
          } else if (m.event === 'stopped') {
            if (!autoSkipStopRef.current) stopReasonRef.current = mapStopReason(msg);
            autoSkipStopRef.current = false;
            debugRefreshGenRef.current += 1;
            setIsPaused(true);
            scheduleDebugRefresh();
          } else if (m.event === 'terminated') {
            clearDebug();
          }
        };
        if (wantsDebug) {
          rt.debugger.on('event', onDebuggerEvent);
        }

        const runPromise = rt.run();
        priorRunRef.current = runPromise;
        let runSettled = false;
        void runPromise.finally(() => {
          runSettled = true;
          if (wantsDebug) rt.debugger.off('event', onDebuggerEvent);
        });

        if (wantsDebug) {
          dapSend('initialize', {});
          const handshakeDeadline = Date.now() + 120_000;
          while (!handshakeDoneRef.current && !runSettled) {
            if (tryDapHandshake()) break;
            if (Date.now() >= handshakeDeadline) {
              throw new Error(
                'DAP handshake timed out after 120s — worker may be blocked or still ' +
                  'fetching toolchain WASM. Rebuild the engine with `npm run build` (not tools/dev).'
              );
            }
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
        }

        const result = await runPromise;
        if (result.type === 'completed') {
          finish = {
            reason: 'completed',
            exit_code: result.exitCode,
            build_ms: Math.round(result.timing.buildMs),
            run_ms: Math.round(result.timing.runMs),
          };
        } else if (result.type === 'stopped') {
          finish = { reason: 'stopped' };
        } else {
          finish = { reason: 'error' };
        }
        if (testDecoderRef.current) {
          const rest = testDecoderRef.current.finish();
          if (rest) {
            Telemetry.log('run_io', { kind: 'stdout', data: rest });
            stdoutBufferRef.current += rest.replace(/\r?\n/g, '\r\n');
          }
          const nextState = {
            ...testDecoderRef.current.state,
            results: new Map(testDecoderRef.current.state.results),
          };
          const failuresExplainExit = [...nextState.results.values()].some(
            (r) => r.status === 'failed' || r.status === 'errored',
          );
          const couldntRun =
            result.type === 'error' ||
            (result.type === 'completed' &&
              result.exitCode !== 0 &&
              !failuresExplainExit);
          if (couldntRun) {
            nextState.finished = true;
            nextState.error =
              "Couldn't run tests. Please see the Terminal for more info";
          }
          setTestState(nextState);
        }
        if (result.type === 'error') {
          stdoutBufferRef.current += `\r\n[ide error] ${result.error.type}: ${result.error.message}\r\n`;
        }
        if (typeof window !== 'undefined') {
          const timing =
            result.type === 'completed'
              ? result.timing
              : { totalMs: null, buildMs: null, runMs: null };
          (
            window as Window & {
              __ideRunTiming?: Record<string, unknown>;
            }
          ).__ideRunTiming = {
            wallMs: Math.round(performance.now() - started),
            wantsDebug,
            ...timing,
            resultType: result.type,
            at: Date.now(),
          };
        }
      } catch (err) {
        stdoutBufferRef.current += `\r\n[ide error] ${err instanceof Error ? err.message : String(err)}\r\n`;
        if (testDecoderRef.current) {
          setTestState({
            ...testDecoderRef.current.state,
            results: new Map(testDecoderRef.current.state.results),
            finished: true,
            error: "Couldn't run tests. Please see the Terminal for more info",
          });
        }
        if (typeof window !== 'undefined') {
          (
            window as Window & {
              __ideRunTiming?: Record<string, unknown>;
            }
          ).__ideRunTiming = {
            wallMs: Math.round(performance.now() - started),
            error: err instanceof Error ? err.message : String(err),
            at: Date.now(),
          };
        }
      } finally {
        const tests = testsFrom(testDecoderRef.current);
        Telemetry.log('run_stop', {
          ...finish,
          ...(tests && tests.length ? { tests } : {}),
        });
        const ms = Math.round(performance.now() - started);
        const term = terminalRef.current;
        if (term) {
          term.clear();
          if (stdoutBufferRef.current) term.write(stdoutBufferRef.current);
          term.writeln(`\r\n\x1b[3;90mRan in ${ms}ms\x1b[0m`);
        }
        teardown();
        clearDebug();
        setIsRunning(false);
      }
    },
    [
      clearDebug,
      completeDapHandshake,
      dapSend,
      getEngine,
      scheduleDebugRefresh,
      teardown,
      terminalRef,
      wireStdin,
      wireStdout,
    ]
  );

  const stop = useCallback(() => {
    runtimeRef.current?.stop();
    teardown();
    clearDebug();
    setIsRunning(false);
  }, [clearDebug, teardown]);

  const resume = useCallback(() => {
    if (!isRunningRef.current) return;
    Telemetry.log('debug_step', { kind: 'continue' });
    dapSend('continue', { threadId: 1 });
    setIsPaused(false);
    setStoppedLine(null);
    setFrames([]);
    setSelectedFrameId(null);
    setScopes([]);
  }, [dapSend]);

  const step = useCallback(
    (command: 'next' | 'stepIn' | 'stepOut') => {
      if (!isRunningRef.current) return;
      Telemetry.log('debug_step', {
        kind: command === 'next' ? 'over' : command === 'stepIn' ? 'in' : 'out',
      });
      setDebugLoading(true);
      setScopes([]);
      setFrames([]);
      dapSend(command, { threadId: 1 });
    },
    [dapSend]
  );

  const selectFrame = useCallback(
    (id: number) => {
      setSelectedFrameId(id);
      const views = loadFrame(id);
      const index = frames.findIndex((frame) => frame.id === id);
      const frame = index >= 0 ? frames[index] : undefined;
      if (frame) Telemetry.log('debug_frame', { frame: toDebugFrame(index, frame.name, views) });
    },
    [frames, loadFrame]
  );

  const expandVariable = useCallback(
    (ref: number): DapVariable[] => {
      if (ref <= 0) return [];
      const res = dapSend<{ variables: DapVariable[] }>('variables', {
        variablesReference: ref,
      });
      return res?.body?.variables ?? [];
    },
    [dapSend]
  );

  const applyBreakpoints = useCallback(
    (breakpoints: ReadonlySet<number>) => {
      breakpointsRef.current = breakpoints;
      if (runtimeRef.current) sendBreakpoints();
    },
    [sendBreakpoints]
  );

  return {
    isRunning,
    isPaused,
    stoppedLine,
    frames,
    selectedFrameId,
    scopes,
    debugLoading,
    testState,
    run,
    stop,
    resume,
    stepOver: () => step('next'),
    stepIn: () => step('stepIn'),
    stepOut: () => step('stepOut'),
    selectFrame,
    expandVariable,
    applyBreakpoints,
  };
}
