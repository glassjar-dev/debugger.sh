'use client';

import { Engine, type PackageStatus } from 'debugger-sh';
import { useCallback, useEffect, useRef, useState } from 'react';

import { LANGS, type Lang } from '@/components/constants';
import type {
  DapResponse,
  DapVariable,
  Scope,
  ScopeView,
  StackFrame,
} from '@/components/dap-types';
import type { ExecConsole } from '@/lib/terminal/session';
import type { ShellJobResult } from '@/lib/terminal/shell';
import { toDebugFrame } from '@/lib/telemetry/map';
import { Telemetry } from '@/lib/telemetry/client';
import type { TestCase } from '@/lib/telemetry/types';
import { loadStanfordArtifacts } from '@/lib/stanford/loadArtifacts';
import { mergeDirNodes, pathsToDirNode } from '@/lib/stanford/fsTree';
import { prepareCppRun } from '@/lib/testing/prepare';
import { markRunnerReady } from '@/lib/intellisense/runnerReady';
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

/** Normalize DAP / DWARF source paths to absolute virtual paths like `/lib/list.cpp`. */
function normalizeSourcePath(path: string | undefined | null): string {
  if (!path) return '';
  let p = path.startsWith('file://') ? path.slice('file://'.length) : path;
  p = p.replace(/\\/g, '/');
  if (!p.startsWith('/')) p = `/${p}`;
  return p;
}

/** The workspace file a DAP / DWARF path points at, or null for library and harness code. */
function userFile(path: string | undefined | null, files: ReadonlySet<string>): string | null {
  const file = normalizeSourcePath(path).slice(1);
  return files.has(file) ? file : null;
}

/** Breakpoint lines per workspace file path. */
export type Breakpoints = ReadonlyMap<string, ReadonlySet<number>>;
/** Where the program is paused: a workspace file and a 1-based line. */
export type StopLocation = { path: string; line: number };

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
  /** The terminal: program output goes to it, and it sends the program's input. */
  console: ExecConsole;
};

/** How a run starts, beyond the files: what a shell command line sets. */
export type RunOptions = {
  /** Arguments after the program's name. */
  args?: string[];
  /** Absolute folder to start in. */
  cwd?: string;
  /** Python script or Rust crate root, absolute. */
  entry?: string;
  /** Compile without running (C/C++ and Rust). */
  build?: boolean;
  /** Input from `< file`; the program sees end-of-file after it. */
  stdin?: string;
  /** Collect stdout into the result instead of showing it (`> file`). */
  capture?: boolean;
  /** Show how long the run took afterwards. */
  timing?: boolean;
};

export type RunOutcome = ShellJobResult;

export type ExecutionApi = {
  isRunning: boolean;
  isPaused: boolean;
  /** The selected frame's place in your code while paused. */
  stopped: StopLocation | null;
  frames: StackFrame[];
  selectedFrameId: number | null;
  scopes: ScopeView[];
  debugLoading: boolean;
  testState: TestRunState | null;
  /** Run the workspace: every file by path, starting from the language's entry file. */
  run: (
    files: Readonly<Record<string, string>>,
    breakpoints: Breakpoints,
    lang: Lang,
    options?: RunOptions
  ) => Promise<RunOutcome>;
  stop: () => void;
  resume: () => void;
  stepOver: () => void;
  stepIn: () => void;
  stepOut: () => void;
  selectFrame: (id: number) => void;
  /** Sync DAP `variables` request — returns child variables or [] on failure. */
  expandVariable: (ref: number) => DapVariable[];
  /** Push a new breakpoint set to the running runtime (no-op if not running). */
  applyBreakpoints: (breakpoints: Breakpoints) => void;
  /** Starts the engine for `lang` ahead of its first Run. Safe to call repeatedly. */
  warm: (lang: Lang) => void;
};

export function useExecution({ console: term }: UseExecutionOptions): ExecutionApi {
  const [isRunning, setIsRunning] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [stopped, setStopped] = useState<StopLocation | null>(null);
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
  const breakpointsRef = useRef<Breakpoints>(new Map());
  /** Files the engine last heard breakpoints for, so removing a file's last one clears it. */
  const sentBreakpointFilesRef = useRef<Set<string>>(new Set());
  /** The running workspace's paths: stepping only ever stops in these. */
  const userFilesRef = useRef<ReadonlySet<string>>(new Set());
  const langRef = useRef<Lang>('c');
  const testDecoderRef = useRef<ReturnType<typeof createTestReportDecoder> | null>(null);
  const testStateRafRef = useRef<number | null>(null);
  /** Stdout collected for `> file`, or null when it shows in the terminal. */
  const capturedRef = useRef<string | null>(null);
  /** Bumped on each `stopped` (and when auto-skipping library stops) so twin refreshes stay coherent. */
  const debugRefreshGenRef = useRef(0);
  const stopReasonRef = useRef<StopReason>('pause');
  const autoSkipStopRef = useRef(false);
  const emittedStopGenRef = useRef(-1);
  /** Shows package installs (and packages that can't run here) in the terminal, durably. */
  const notePackage = useCallback(
    (status: PackageStatus) => {
      const line =
        status.kind === 'skipped'
          ? `\x1b[33m${status.message}\x1b[0m\r\n`
          : status.kind === 'installing'
            ? `\x1b[3;90m${status.message}…\x1b[0m\r\n`
            : '';
      if (line) term.output(line);
    },
    [term]
  );
  const notePackageRef = useRef(notePackage);
  notePackageRef.current = notePackage;

  const getEngine = useCallback(async (lang: Lang): Promise<Engine> => {
    const existing = enginesRef.current[lang];
    if (existing) return existing;
    let pending = engineInitRef.current[lang];
    if (!pending) {
      // scripts/copy-engine-wasm.mjs puts the engine's own Wasm in public/.
      pending = Engine.create(lang as Parameters<typeof Engine.create>[0], {
        wasmUrl: '/engine_bg.wasm',
        // Python installs what a program imports from PyPI (pure-Python packages only).
        ...(lang === 'python'
          ? { python: { packages: true, onPackageStatus: (status: PackageStatus) => notePackageRef.current(status) } }
          : {}),
      }).then((engine) => {
        enginesRef.current[lang] = engine;
        return engine;
      });
      engineInitRef.current[lang] = pending;
    }
    return pending;
  }, []);

  const warmedRef = useRef<Set<Lang>>(new Set());
  /**
   * Starts the engine for the language on screen, so the first Run doesn't wait for it.
   * For C++ that also loads the compiler and the common (non-debug) Stanford artifacts;
   * debug archives load on demand.
   */
  const warm = useCallback(
    (lang: Lang) => {
      if (warmedRef.current.has(lang)) return;
      warmedRef.current.add(lang);
      let ready: Promise<unknown> = getEngine(lang);
      if (lang === 'c') {
        ready = preparingRef.current = getEngine('c').then((engine) => engine.prepareCompiler());
        void loadStanfordArtifacts('run');
      }
      // A Run started during the warm-up releases IntelliSense when it finishes instead.
      void ready.catch(() => undefined).finally(() => !isRunningRef.current && markRunnerReady(lang));
    },
    [getEngine],
  );

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
    const current = breakpointsRef.current;
    const files = new Set([...sentBreakpointFilesRef.current, ...current.keys()]);
    for (const file of files) {
      const lines = Array.from(current.get(file) ?? []).sort((a, b) => a - b);
      dapSend('setBreakpoints', {
        source: { path: `/${file}` },
        breakpoints: lines.map((line) => ({ line })),
      });
    }
    sentBreakpointFilesRef.current = new Set([...current].filter(([, lines]) => lines.size > 0).map(([f]) => f));
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

        // Just-my-code: never surface a pause whose PC is outside your files
        // (Stanford headers, libc++, SimpleTest harness, etc.).
        if (!userFile(raw[0]?.source?.path, userFilesRef.current)) {
          // Invalidate sibling refresh so we don't double-resume.
          debugRefreshGenRef.current += 1;
          // Keep the original stop reason across the automatic step-out.
          autoSkipStopRef.current = true;
          // Return to the caller so step-through keeps going on the next main-file line.
          dapSend('stepOut', { threadId: 1 });
          setIsPaused(false);
          setStopped(null);
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
          setStopped(null);
          setScopes([]);
          return;
        }
        const top = userFile(fs[0].source?.path, userFilesRef.current);
        setStopped(top ? { path: top, line: fs[0].line } : null);
        setSelectedFrameId(fs[0].id);
        const views = loadFrame(fs[0].id);
        if (emittedStopGenRef.current !== expectedGen) {
          emittedStopGenRef.current = expectedGen;
          const line = fs[0].line;
          Telemetry.log('debug_stop', {
            reason: stopReasonRef.current,
            ...(top ? { file: top } : {}),
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
    setStopped(null);
    setFrames([]);
    setSelectedFrameId(null);
    setScopes([]);
    setDebugLoading(false);
  }, []);

  const teardown = useCallback(() => {
    ioCleanupRef.current?.();
    ioCleanupRef.current = null;
    term.attach(null);
    runtimeRef.current = null;
    isRunningRef.current = false;
    testDecoderRef.current = null;
  }, [term]);

  const wireStdout = useCallback(
    (rt: Engine) => {
      const stdoutDecoder = new TextDecoder();
      const stderrDecoder = new TextDecoder();
      const onData = (kind: 'stdout' | 'stderr', decoder: TextDecoder) => (chunk: Uint8Array) => {
        const text = decoder.decode(chunk);
        const filtered = testDecoderRef.current
          ? testDecoderRef.current.push(text)
          : text;
        if (filtered) {
          Telemetry.log('run_io', { kind, data: filtered });
          if (kind === 'stdout' && capturedRef.current !== null) capturedRef.current += filtered;
          else term.output(filtered);
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
    [term]
  );

  const stopRef = useRef<() => void>(() => undefined);

  /** The terminal's typing goes to the program (unless its input is a file). */
  const wireStdin = useCallback(
    (rt: Engine, fromFile: boolean) => {
      term.attach({
        write: (text) => {
          Telemetry.log('run_io', { kind: 'stdin', data: text });
          if (!fromFile) void rt.stdin.write(text);
        },
        end: () => void (!fromFile && rt.stdin.end()),
        stop: () => stopRef.current(),
      });
    },
    [term]
  );

  const run = useCallback(
    async (
      files: Readonly<Record<string, string>>,
      breakpoints: Breakpoints,
      lang: Lang,
      options: RunOptions = {}
    ): Promise<RunOutcome> => {
      if (isRunningRef.current) {
        term.output('glassjar: a program is already running\n');
        return { exitCode: 1 };
      }
      Telemetry.log('run_start');
      let finish: {
        reason: 'completed' | 'error' | 'stopped';
        exit_code?: number;
        build_ms?: number;
        run_ms?: number;
      } = { reason: 'error' };
      let outcome: RunOutcome = { exitCode: 1 };
      const started = performance.now();
      langRef.current = lang;
      breakpointsRef.current = breakpoints;
      sentBreakpointFilesRef.current = new Set();
      userFilesRef.current = new Set(Object.keys(files));
      // Prefer a fast non-debug build when nothing needs DWARF / instrumentation.
      const wantsDebug =
        !options.build && LANGS[lang].debug && [...breakpoints.values()].some((lines) => lines.size > 0);
      teardown();
      clearDebug();
      setTestState(null);
      capturedRef.current = options.capture ? '' : null;
      setIsRunning(true);
      isRunningRef.current = true;

      try {
        if (typeof window !== 'undefined' && !window.crossOriginIsolated) {
          term.output(
            '[ide warning] SharedArrayBuffer is unavailable (crossOriginIsolated=false). ' +
              'Run via `npm run dev` — not a static export preview.\n'
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
        wireStdin(rt, options.stdin !== undefined);
        rt.debugger.enabled = wantsDebug;
        const { cols, rows } = term.size();
        rt.program = {
          args: options.args ?? [],
          ...(options.cwd ? { cwd: options.cwd } : {}),
          ...(options.entry ? { entry: options.entry } : {}),
          env: {
            TERM: 'xterm-256color',
            COLUMNS: String(cols),
            LINES: String(rows),
            // Python buffers stdout unless it's a terminal; this one is, as far as you can tell.
            ...(lang === 'python' ? { PYTHONUNBUFFERED: '1' } : {}),
          },
          collectFiles: !options.build,
        };

        if (lang === 'c') {
          const prepared = prepareCppRun(files, LANGS[lang].fsKey);
          const stanford = await loadStanfordArtifacts(wantsDebug ? 'debug' : 'run');
          rt.fs = mergeDirNodes(
            pathsToDirNode(stanford.fsFiles),
            pathsToDirNode(prepared.files),
          );
          rt.binaryFiles = { ...stanford.binaryFiles };
          rt.cppArtifacts = { ...stanford.cppArtifacts, sources: prepared.sources };
          if (prepared.hasTests && !options.build) {
            testDecoderRef.current = createTestReportDecoder(prepared.nonce);
          }
        } else {
          rt.fs = pathsToDirNode({ ...files });
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

        const runPromise = options.build ? rt.compile() : rt.run();
        priorRunRef.current = runPromise;
        if (options.stdin !== undefined) {
          void rt.stdin.write(options.stdin);
          void rt.stdin.end();
        }
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
          outcome = { exitCode: result.exitCode, ...(result.files ? { files: result.files } : {}) };
        } else if (result.type === 'stopped') {
          finish = { reason: 'stopped' };
          outcome = { exitCode: 130, stopped: true };
        } else {
          finish = { reason: 'error' };
          term.output(`\x1b[31m${result.error.type}: ${result.error.message}\x1b[0m\n`);
        }
        if (testDecoderRef.current) {
          const rest = testDecoderRef.current.finish();
          if (rest) {
            Telemetry.log('run_io', { kind: 'stdout', data: rest });
            if (capturedRef.current !== null) capturedRef.current += rest;
            else term.output(rest);
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
        term.output(`\x1b[31m${err instanceof Error ? err.message : String(err)}\x1b[0m\n`);
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
        if (capturedRef.current !== null) outcome = { ...outcome, stdout: capturedRef.current };
        capturedRef.current = null;
        teardown();
        clearDebug();
        setIsRunning(false);
        markRunnerReady(lang);
        if (options.timing) {
          const ms = Math.round(performance.now() - started);
          term.output(`\x1b[3;90mRan in ${ms}ms\x1b[0m\n`);
        }
      }
      return outcome;
    },
    [
      clearDebug,
      completeDapHandshake,
      dapSend,
      getEngine,
      scheduleDebugRefresh,
      teardown,
      term,
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
  stopRef.current = stop;

  const resume = useCallback(() => {
    if (!isRunningRef.current) return;
    Telemetry.log('debug_step', { kind: 'continue' });
    dapSend('continue', { threadId: 1 });
    setIsPaused(false);
    setStopped(null);
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
      // Selecting a caller shows where it is waiting, in whichever file that is.
      const file = frame ? userFile(frame.source?.path, userFilesRef.current) : null;
      if (frame && file) setStopped({ path: file, line: frame.line });
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
    (breakpoints: Breakpoints) => {
      breakpointsRef.current = breakpoints;
      if (runtimeRef.current) sendBreakpoints();
    },
    [sendBreakpoints]
  );

  return {
    isRunning,
    isPaused,
    stopped,
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
    warm,
  };
}
