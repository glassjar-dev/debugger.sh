'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import CodeMirror, { type ReactCodeMirrorRef } from '@uiw/react-codemirror';
import { cpp, cppLanguage } from '@codemirror/lang-cpp';
import { python, pythonLanguage } from '@codemirror/lang-python';
import { rust, rustLanguage } from '@codemirror/lang-rust';
import { Decoration, EditorView, gutter, GutterMarker } from '@codemirror/view';
import { StateEffect, StateField, type Extension } from '@codemirror/state';
import { HighlightStyle, syntaxHighlighting, type LRLanguage } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';

import { LANGS, type Lang } from '@/components/constants';
import { telemetryEditor } from '@/lib/telemetry/editor';
import { intellisense } from '@/lib/intellisense/editor';
import { documentService } from '@/lib/intellisense/documents';
import { getLanguageService } from '@/lib/intellisense/services';
import { runnerReady } from '@/lib/intellisense/runnerReady';
import { extname } from '@/lib/workspace/paths';


// ---------------------------------------------------------------------------
// Language extensions
// ---------------------------------------------------------------------------

const LANG_EXTENSIONS: Record<Lang, () => Extension> = {
  c: cpp,
  python: python,
  rust: rust,
};

/** Parser + Markdown fence name used to highlight code inside hovers and docs. */
const LANG_INTELLISENSE: Record<Lang, { language: LRLanguage; fence: string }> = {
  c: { language: cppLanguage, fence: 'cpp' },
  python: { language: pythonLanguage, fence: 'python' },
  rust: { language: rustLanguage, fence: 'rust' },
};

const MODE_BY_EXTENSION: Record<string, Lang> = {
  c: 'c', cc: 'c', cp: 'c', cpp: 'c', cxx: 'c', 'c++': 'c', h: 'c', hh: 'c', hpp: 'c', hxx: 'c', inl: 'c',
  py: 'python', pyi: 'python',
  rs: 'rust',
};

/** Which language highlights `path`; null for plain text such as data files. */
export function modeFor(path: string): Lang | null {
  return MODE_BY_EXTENSION[extname(path)] ?? null;
}

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------
//
// Every color and dimension that affects the editor's look lives here so
// tweaking the palette is a one-stop edit. We deliberately use `theme="none"`
// on the CodeMirror component below so nothing else colors the editor — this
// object is the single source of truth.

const theme = {
  bg: '#0f1013', // --gj-panel, so the editor sits flush in its card
  fg: '#e5e7eb',
  caret: '#7cc4ff',
  selection: 'rgba(124, 196, 255, 0.22)',
  activeLine: 'rgba(255, 255, 255, 0.025)',
  stoppedLine: 'rgba(251, 191, 36, 0.14)',
  stoppedEdge: '#fbbf24',
  gutter: {
    bg: '#0f1013',
    fg: '#4b515c',
    activeFg: '#a6acb6',
    minWidth: 44, // px — breakpoint dot on the left, number on the right
  },
  breakpoint: {
    dotSize: 10, // px
    dotMargin: 8, // px (left)
    fill: '#f87171',
    glow: '0 0 8px rgba(248, 113, 113, 0.55)',
    hover: 'rgba(248, 113, 113, 0.55)',
    // Hollow ring on the cursor's line: shows where a click adds a breakpoint.
    ring: 'rgba(248, 113, 113, 0.4)',
  },
  font: {
    family:
      'ui-monospace, SFMono-Regular, "JetBrains Mono", Menlo, Monaco, Consolas, "Liberation Mono", monospace',
    size: '13px',
    lineHeight: '1.6',
  },
  // Tailwind 400-series — saturated enough to pop on a near-black background
  // while staying coherent with the rest of the IDE's palette.
  syntax: {
    keyword: '#c084fc', // violet-400  — int, void, return, if, for, ...
    type: '#f472b6', // pink-400    — typedef'd type names
    fn: '#60a5fa', // blue-400    — function names at call/declaration sites
    string: '#4ade80', // green-400   — "literal"
    number: '#fb923c', // orange-400  — 1, 2, true
    preproc: '#22d3ee', // cyan-400    — #include, #define
    comment: '#52525b', // zinc-600    — // ... (italic)
    variable: '#e2e8f0', // slate-200   — local identifiers
    operator: '#94a3b8', // slate-400   — +, -, ;, (), {}, ...
  },
} as const;

const editorChrome = EditorView.theme(
  {
    '&': {
      height: '100%',
      backgroundColor: theme.bg,
      color: theme.fg,
      fontSize: theme.font.size,
    },
    '.cm-scroller': {
      fontFamily: theme.font.family,
      lineHeight: theme.font.lineHeight,
    },
    // Strip CM defaults so vertical/horizontal rhythm matches the original
    // textarea (which had `padding: 0 12px`).
    '.cm-content': { caretColor: theme.caret, padding: '8px 0' },
    '.cm-line': { padding: '0 14px' },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: theme.caret, borderLeftWidth: '2px' },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': {
      backgroundColor: theme.selection,
    },
    '&.cm-focused': { outline: 'none' },
    '.cm-activeLine': { backgroundColor: theme.activeLine },
    '.cm-gutters': {
      backgroundColor: theme.gutter.bg,
      border: 'none',
      color: theme.gutter.fg,
      cursor: 'pointer',
      userSelect: 'none',
      // No paddingTop: CodeMirror already offsets the gutter by .cm-content's
      // padding, so adding it here pushed every line number 8px down.
    },
    '.cm-gutterElement.cm-activeLineGutter': { backgroundColor: 'transparent', color: theme.gutter.activeFg },
    '.cm-gj-gutter': {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      minWidth: `${theme.gutter.minWidth}px`,
      paddingRight: '10px',
      fontVariantNumeric: 'tabular-nums',
    },
    '.cm-gj-bp': {
      flex: 'none',
      marginLeft: `${theme.breakpoint.dotMargin}px`,
      width: `${theme.breakpoint.dotSize}px`,
      height: `${theme.breakpoint.dotSize}px`,
      borderRadius: '50%',
      background: 'transparent',
      position: 'relative',
      transition: 'background 0.12s ease, box-shadow 0.12s ease, transform 0.12s ease',
    },
    // The cursor's line shows an empty slot, so the gutter reads as clickable.
    '.cm-bp-enabled .cm-activeLineGutter .cm-gj-bp': { boxShadow: `inset 0 0 0 1.5px ${theme.breakpoint.ring}` },
    // Hovering a line number previews the breakpoint.
    '.cm-bp-enabled .cm-gutterElement:hover .cm-gj-bp': {
      background: theme.breakpoint.hover,
      boxShadow: `inset 0 0 0 1.5px ${theme.breakpoint.fill}`,
    },
    // Until someone sets their first breakpoint, the slot on the cursor's line
    // sends out a slow ping.
    '&.gj-bp-nudge .cm-activeLineGutter .cm-gj-bp:not([data-on])::after': {
      content: '""',
      position: 'absolute',
      inset: '0',
      borderRadius: '50%',
      boxShadow: `0 0 0 1.5px ${theme.breakpoint.fill}`,
      animation: 'gj-bp-ping 2.4s ease-out infinite',
      pointerEvents: 'none',
    },
    '@keyframes gj-bp-ping': {
      '0%': { transform: 'scale(1)', opacity: '0.9' },
      '45%, 100%': { transform: 'scale(2.4)', opacity: '0' },
    },
    '.cm-gj-bp[data-on]': {
      background: theme.breakpoint.fill,
      boxShadow: theme.breakpoint.glow,
    },
    '.cm-gutterElement:hover .cm-gj-bp[data-on]': {
      background: theme.breakpoint.fill,
      boxShadow: theme.breakpoint.glow,
      transform: 'scale(0.85)',
    },
    '.cm-gj-gutter[data-bp] .cm-gj-num': { color: '#fca5a5' },
    '.cm-stopped-line': {
      backgroundColor: theme.stoppedLine,
      boxShadow: `inset 3px 0 0 ${theme.stoppedEdge}`,
    },
  },
  { dark: true },
);

const codeSyntax = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.modifier, t.operatorKeyword], color: theme.syntax.keyword },
  { tag: [t.typeName, t.standard(t.typeName)], color: theme.syntax.type },
  { tag: t.function(t.variableName), color: theme.syntax.fn },
  { tag: [t.string, t.character, t.special(t.string)], color: theme.syntax.string },
  { tag: [t.number, t.bool], color: theme.syntax.number },
  { tag: [t.processingInstruction, t.meta], color: theme.syntax.preproc },
  { tag: [t.comment, t.lineComment, t.blockComment], color: theme.syntax.comment, fontStyle: 'italic' },
  { tag: t.variableName, color: theme.syntax.variable },
  { tag: [t.operator, t.punctuation, t.bracket, t.brace, t.paren, t.squareBracket], color: theme.syntax.operator },
]);

// ---------------------------------------------------------------------------
// Breakpoints
// ---------------------------------------------------------------------------
//
// React owns the canonical Set<number>. We mirror it into `breakpointsField`
// via a dispatched `setBreakpointsEffect`; gutter clicks call back through the
// `toggleRef` so React stays the single source of truth. Stored as Set<number>
// (not RangeSet) because we don't track breakpoints across edits — matches the
// prior textarea behavior.

const setBreakpointsEffect = StateEffect.define<number[]>();

const breakpointsField = StateField.define<ReadonlySet<number>>({
  create: () => new Set(),
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setBreakpointsEffect)) value = new Set(e.value);
    return value;
  },
});

// One combined gutter row: hole/dot on the left, line number on the right
// (matches the original textarea-era Gutter component layout).
class LineGutterMarker extends GutterMarker {
  constructor(
    readonly lineNumber: number,
    readonly hasBreakpoint: boolean,
    readonly breakpointsEnabled = false,
  ) {
    super();
  }

  eq(other: GutterMarker): boolean {
    return (
      other instanceof LineGutterMarker &&
      other.lineNumber === this.lineNumber &&
      other.hasBreakpoint === this.hasBreakpoint &&
      other.breakpointsEnabled === this.breakpointsEnabled
    );
  }

  toDOM(): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'cm-gj-gutter';
    if (this.hasBreakpoint) wrap.dataset.bp = '';
    if (this.breakpointsEnabled) {
      wrap.title = `${this.hasBreakpoint ? 'Remove' : 'Add'} breakpoint on line ${this.lineNumber}`;
    }

    const dot = document.createElement('span');
    dot.className = 'cm-gj-bp';
    if (this.hasBreakpoint) dot.dataset.on = '';

    const num = document.createElement('span');
    num.className = 'cm-gj-num';
    num.textContent = String(this.lineNumber);

    wrap.append(dot, num);
    return wrap;
  }
}

// `toggleRef` is a ref so the click handler always sees the freshest callback
// without having to rebuild the gutter extension on every parent render.
function makeLineGutter(
  toggleRef: { current: (line: number) => void },
  breakpointsEnabled: boolean,
) {
  return gutter({
    class: breakpointsEnabled ? 'cm-line-gutter cm-bp-enabled' : 'cm-line-gutter',
    lineMarker: (view, line) => {
      const lineNumber = view.state.doc.lineAt(line.from).number;
      const hasBreakpoint =
        breakpointsEnabled && view.state.field(breakpointsField).has(lineNumber);
      return new LineGutterMarker(lineNumber, hasBreakpoint, breakpointsEnabled);
    },
    lineMarkerChange: (update) =>
      update.docChanged ||
      update.startState.field(breakpointsField) !== update.state.field(breakpointsField),
    // Spacer sized for up to 4-digit line numbers; gutter grows past this if needed.
    initialSpacer: () => new LineGutterMarker(9999, false),
    domEventHandlers: breakpointsEnabled
      ? {
          mousedown(view, line) {
            toggleRef.current(view.state.doc.lineAt(line.from).number);
            return true;
          },
        }
      : {},
  });
}

// ---------------------------------------------------------------------------
// Stopped-line highlight
// ---------------------------------------------------------------------------

const setStoppedLineEffect = StateEffect.define<number | null>();

const stoppedLineField = StateField.define<number | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setStoppedLineEffect)) value = e.value;
    return value;
  },
});

const stoppedLineHighlight = EditorView.decorations.compute([stoppedLineField], (state) => {
  const ln = state.field(stoppedLineField);
  if (ln == null || ln < 1 || ln > state.doc.lines) return Decoration.none;
  return Decoration.set([
    Decoration.line({ attributes: { class: 'cm-stopped-line' } }).range(state.doc.line(ln).from),
  ]);
});

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export type CodeEditorProps = {
  /** The workspace's language. */
  lang: Lang;
  /** The file this editor shows, like `lib/list.cpp`. */
  path: string;
  value: string;
  onChange: (value: string) => void;
  breakpoints: ReadonlySet<number>;
  onToggleBreakpoint: (line: number) => void;
  stoppedLine: number | null;
  /** The editor gained focus: this is now the file you're working in. */
  onFocus?: () => void;
};

const BREAKPOINT_HINT_DONE = 'glassjar.breakpointHintDone';

// A state field (not a compartment) so it survives @uiw/react-codemirror
// reconfiguring the editor on re-render.
const setNudgeEffect = StateEffect.define<boolean>();
const nudgeField = StateField.define<boolean>({
  create: () => false,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setNudgeEffect)) value = e.value;
    return value;
  },
  provide: (f) => EditorView.editorAttributes.from(f, (on): Record<string, string> => (on ? { class: 'gj-bp-nudge' } : {})),
});

export default function CodeEditor(props: CodeEditorProps) {
  const cmRef = useRef<ReactCodeMirrorRef>(null);
  const mode = modeFor(props.path);
  // Only the workspace's own language gets breakpoints and IntelliSense (headers included).
  const native = mode === props.lang;
  const breakpointsEnabled = native && LANGS[props.lang].debug;

  // First-timers get a pulsing hint in the gutter until they set a breakpoint.
  const [nudge, setNudge] = useState(false);
  useEffect(() => {
    try {
      setNudge(!localStorage.getItem(BREAKPOINT_HINT_DONE));
    } catch {
      // Storage blocked: skip the hint.
    }
  }, []);
  useEffect(() => {
    if (!nudge || props.breakpoints.size === 0) return;
    setNudge(false);
    try {
      localStorage.setItem(BREAKPOINT_HINT_DONE, '1');
    } catch {
      // Storage blocked: the hint just comes back next visit.
    }
  }, [nudge, props.breakpoints]);
  const showNudge = nudge && breakpointsEnabled;

  const toggleRef = useRef(props.onToggleBreakpoint);
  toggleRef.current = props.onToggleBreakpoint;
  const focusRef = useRef(props.onFocus);
  focusRef.current = props.onFocus;

  const [intellisenseOn, setIntellisenseOn] = useState(false);
  useEffect(() => {
    let alive = true;
    void runnerReady.then(() => alive && setIntellisenseOn(true));
    return () => {
      alive = false;
    };
  }, []);

  const extensions = useMemo<Extension[]>(() => {
    // Attached once the run engine is warm, so loading it never slows Run down.
    const service =
      native && intellisenseOn ? documentService(getLanguageService(props.lang), props.path) : null;
    return [
      ...(mode ? [LANG_EXTENSIONS[mode]()] : []),
      breakpointsField,
      stoppedLineField,
      stoppedLineHighlight,
      makeLineGutter(toggleRef, breakpointsEnabled),
      nudgeField,
      telemetryEditor(props.path),
      syntaxHighlighting(codeSyntax),
      ...(service
        ? [
            intellisense({
              service,
              language: LANG_INTELLISENSE[props.lang].language,
              highlighter: codeSyntax,
              lang: LANG_INTELLISENSE[props.lang].fence,
            }),
          ]
        : []),
      EditorView.domEventHandlers({
        focus: () => {
          service?.claim();
          focusRef.current?.();
        },
      }),
      editorChrome,
    ];
  }, [props.lang, props.path, mode, native, breakpointsEnabled, intellisenseOn]);

  // React → CM sync. Include lang/value so we don't apply line state mid-switch.
  // Also runs from onCreateEditor: @uiw/react-codemirror creates the view a
  // render after mount, so the first effect can run before there is a view.
  const sync = (view: EditorView) => {
    const maxLine = view.state.doc.lines;
    const breakpoints = Array.from(props.breakpoints).filter(
      (ln) => ln >= 1 && ln <= maxLine,
    );
    const stoppedLine =
      props.stoppedLine != null &&
      props.stoppedLine >= 1 &&
      props.stoppedLine <= maxLine
        ? props.stoppedLine
        : null;
    view.dispatch({
      effects: [
        setBreakpointsEffect.of(breakpoints),
        setStoppedLineEffect.of(stoppedLine),
        setNudgeEffect.of(showNudge),
      ],
    });
  };
  const syncRef = useRef(sync);
  syncRef.current = sync;
  useEffect(() => {
    const view = cmRef.current?.view;
    if (view) syncRef.current(view);
  }, [props.path, props.value, props.breakpoints, props.stoppedLine, showNudge]);

  return (
    <CodeMirror
      key={`${props.lang}:${props.path}`}
      ref={cmRef}
      value={props.value}
      onChange={props.onChange}
      onCreateEditor={(view) => syncRef.current(view)}
      extensions={extensions}
      // We own every visual style above (chrome + syntax) — no @uiw defaults.
      theme="none"
      basicSetup={{
        // We render our own combined breakpoint + line-number gutter.
        lineNumbers: false,
        foldGutter: false,
        highlightActiveLine: true,
        highlightActiveLineGutter: true,
        // IntelliSense (lib/intellisense) brings its own semantic completion.
        autocompletion: false,
      }}
      style={{ height: '100%', flex: 1, minWidth: 0, overflow: 'hidden' }}
    />
  );
}
