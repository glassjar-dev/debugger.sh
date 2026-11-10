'use client';

import { useEffect, useMemo, useRef } from 'react';
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
import { getLanguageService } from '@/lib/intellisense/services';


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
    hover: 'rgba(248, 113, 113, 0.35)',
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
      paddingTop: '8px',
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
      transition: 'background 0.12s ease, box-shadow 0.12s ease, transform 0.12s ease',
    },
    // Hovering a line number previews where the breakpoint would go.
    '.cm-gutterElement:hover .cm-gj-bp': { background: theme.breakpoint.hover },
    '.cm-gj-bp[data-on]': {
      background: theme.breakpoint.fill,
      boxShadow: theme.breakpoint.glow,
    },
    '.cm-gutterElement:hover .cm-gj-bp[data-on]': {
      background: theme.breakpoint.fill,
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
  constructor(readonly lineNumber: number, readonly hasBreakpoint: boolean) {
    super();
  }

  eq(other: GutterMarker): boolean {
    return (
      other instanceof LineGutterMarker &&
      other.lineNumber === this.lineNumber &&
      other.hasBreakpoint === this.hasBreakpoint
    );
  }

  toDOM(): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'cm-gj-gutter';
    if (this.hasBreakpoint) wrap.dataset.bp = '';

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
    class: 'cm-line-gutter',
    lineMarker: (view, line) => {
      const lineNumber = view.state.doc.lineAt(line.from).number;
      const hasBreakpoint =
        breakpointsEnabled && view.state.field(breakpointsField).has(lineNumber);
      return new LineGutterMarker(lineNumber, hasBreakpoint);
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
  lang: Lang;
  value: string;
  onChange: (value: string) => void;
  breakpoints: Set<number>;
  onToggleBreakpoint: (line: number) => void;
  stoppedLine: number | null;
};

export default function CodeEditor(props: CodeEditorProps) {
  const cmRef = useRef<ReactCodeMirrorRef>(null);
  const breakpointsEnabled = LANGS[props.lang].debug;

  const toggleRef = useRef(props.onToggleBreakpoint);
  toggleRef.current = props.onToggleBreakpoint;

  const extensions = useMemo<Extension[]>(
    () => [
      LANG_EXTENSIONS[props.lang](),
      breakpointsField,
      stoppedLineField,
      stoppedLineHighlight,
      makeLineGutter(toggleRef, breakpointsEnabled),
      telemetryEditor(),
      syntaxHighlighting(codeSyntax),
      intellisense({
        service: getLanguageService(props.lang),
        language: LANG_INTELLISENSE[props.lang].language,
        highlighter: codeSyntax,
        lang: LANG_INTELLISENSE[props.lang].fence,
      }),
      editorChrome,
    ],
    [props.lang, breakpointsEnabled],
  );

  // React → CM sync. Include lang/value so we don't apply line state mid-switch.
  useEffect(() => {
    const view = cmRef.current?.view;
    if (!view) return;
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
      ],
    });
  }, [props.lang, props.value, props.breakpoints, props.stoppedLine]);

  return (
    <CodeMirror
      key={props.lang}
      ref={cmRef}
      value={props.value}
      onChange={props.onChange}
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
