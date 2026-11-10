/**
 * The look of every IntelliSense surface. Colors follow the editor's syntax
 * palette (components/CodeEditor.tsx) and the IDE tokens (components/theme.css),
 * so a function is the same blue in the code, the menu glyph and the hover.
 */

import { EditorView } from '@codemirror/view';

const mono = 'ui-monospace, SFMono-Regular, "JetBrains Mono", Menlo, Monaco, Consolas, "Liberation Mono", monospace';
const ui = 'Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", sans-serif';

const C = {
  fn: '#60a5fa',
  type: '#f472b6',
  keyword: '#c084fc',
  string: '#4ade80',
  number: '#fb923c',
  preproc: '#22d3ee',
  variable: '#7dd3fc',
  module: '#fbbf24',
  text: '#a6acb6',
  error: '#f87171',
  warning: '#fbbf24',
  info: '#7cc4ff',
  accent: '#7cc4ff',
};

const kinds: Record<string, string> = {
  function: C.fn, method: C.fn, constructor: C.fn,
  field: C.variable, property: C.variable, variable: C.variable,
  class: C.type, struct: C.type, interface: C.type, type: C.type,
  enum: C.number, member: C.number, constant: C.number,
  module: C.module, namespace: C.module,
  keyword: C.keyword, snippet: C.string, macro: C.preproc, text: C.text,
};

const alpha = (hex: string, a: number) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
};

const wave = (color: string) =>
  `url("data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns='http://www.w3.org/2000/svg' width='6' height='3'><path d='M0 2.5 Q1.5 0 3 1.5 T6 0.5' fill='none' stroke='${color}' stroke-width='1.1'/></svg>`,
  )}")`;

const card = {
  background: 'linear-gradient(180deg, #181a20, #14161b)',
  border: '1px solid #2c3038',
  borderRadius: '10px',
  boxShadow: '0 18px 40px -12px rgba(0, 0, 0, 0.7), 0 2px 6px rgba(0, 0, 0, 0.35), inset 0 1px 0 rgba(255, 255, 255, 0.04)',
  color: '#e8eaed',
  fontFamily: ui,
  fontSize: '12.5px',
};

const kindRules: Record<string, Record<string, string>> = {};
for (const [kind, color] of Object.entries(kinds)) {
  kindRules[`.gj-kind-${kind}`] = { color, backgroundColor: alpha(color, 0.13), boxShadow: `inset 0 0 0 1px ${alpha(color, 0.22)}` };
}

export const intellisenseTheme = EditorView.theme(
  {
    // ---- tooltip shells -------------------------------------------------
    '.cm-tooltip': { background: 'transparent', border: 'none' },
    '.cm-tooltip.cm-tooltip-hover, .cm-tooltip.cm-tooltip-autocomplete': card,
    '.cm-tooltip.cm-tooltip-hover': { maxWidth: '560px', padding: '0', overflow: 'hidden', animation: 'gj-pop 120ms ease-out' },
    '.cm-tooltip-hover .cm-tooltip-section:not(:first-child)': { borderTop: '1px solid #23262d' },
    '.gj-card': { ...card, maxWidth: '560px', animation: 'gj-pop 120ms ease-out' },
    '.cm-tooltip-hover .gj-card': { background: 'none', border: 'none', boxShadow: 'none', animation: 'none' },
    '@keyframes gj-pop': {
      from: { opacity: '0', transform: 'translateY(3px) scale(0.985)' },
      to: { opacity: '1', transform: 'none' },
    },

    // ---- shared content ---------------------------------------------------
    '.gj-code': { fontFamily: mono, whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
    '.gj-md': { color: '#b4bac4', lineHeight: '1.55' },
    '.gj-md p': { margin: '0 0 6px' },
    '.gj-md p:last-child': { marginBottom: '0' },
    '.gj-md ul': { margin: '2px 0 6px', paddingLeft: '18px' },
    '.gj-md li': { margin: '1px 0' },
    '.gj-md hr': { border: 'none', borderTop: '1px solid #23262d', margin: '8px 0' },
    '.gj-md-h': { color: '#e8eaed', fontWeight: '600', margin: '8px 0 4px' },
    '.gj-md-code': {
      fontFamily: mono, fontSize: '11.5px', padding: '1px 5px', borderRadius: '4px',
      background: 'rgba(255, 255, 255, 0.06)', color: '#e2e8f0',
    },
    '.gj-md-pre': {
      fontFamily: mono, fontSize: '12px', margin: '6px 0', padding: '8px 10px', borderRadius: '7px',
      background: 'rgba(0, 0, 0, 0.28)', border: '1px solid #1e2127', whiteSpace: 'pre-wrap', overflowX: 'auto',
    },
    '.gj-md-link': { color: C.accent, textDecoration: 'none' },
    '.gj-md-link:hover': { textDecoration: 'underline' },

    // ---- hover card -------------------------------------------------------
    '.gj-hover': { padding: '9px 12px 10px' },
    '.gj-card-kind': {
      fontSize: '10px', fontWeight: '600', letterSpacing: '0.08em', textTransform: 'uppercase',
      color: '#6b717c', marginBottom: '5px', fontFamily: ui,
    },
    '.gj-card-code': {
      margin: '0', fontFamily: mono, fontSize: '12.5px', lineHeight: '1.5', whiteSpace: 'pre-wrap',
      wordBreak: 'break-word', maxHeight: '180px', overflowY: 'auto',
    },
    '.gj-card-rule': { height: '1px', background: 'linear-gradient(90deg, #2c3038, transparent)', margin: '9px 0 8px' },
    '.gj-card-body': { maxHeight: '260px', overflowY: 'auto' },

    // ---- completion menu --------------------------------------------------
    '.cm-tooltip.cm-tooltip-autocomplete': { padding: '4px', animation: 'gj-pop 90ms ease-out' },
    '.cm-tooltip-autocomplete > ul': {
      fontFamily: mono, fontSize: '12.5px', maxHeight: '19.5em', minWidth: '280px !important', maxWidth: 'min(440px, 70vw) !important',
    },
    '.cm-tooltip-autocomplete > ul > li': {
      display: 'flex', alignItems: 'center', gap: '8px', padding: '2px 8px 2px 6px !important',
      lineHeight: '20px', borderRadius: '6px', color: '#c9ced6',
    },
    '.cm-tooltip-autocomplete > ul > li[aria-selected]': {
      background: 'rgba(124, 196, 255, 0.13) !important', color: '#f3f5f7 !important',
      boxShadow: 'inset 2px 0 0 #7cc4ff',
    },
    '.cm-completionLabel': { flex: '0 1 auto', minWidth: '0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
    '.cm-completionMatchedText': { textDecoration: 'none !important', color: '#7cc4ff', fontWeight: '600' },
    '.cm-completionDetail': {
      marginLeft: 'auto !important', paddingLeft: '18px', fontStyle: 'normal !important', color: '#6b717c',
      fontSize: '11.5px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '48%', flex: '0 1 auto',
    },
    'li[aria-selected] .cm-completionDetail': { color: '#a6acb6' },
    '.gj-deprecated .cm-completionLabel': { textDecoration: 'line-through', opacity: '0.6' },
    '.gj-kind': {
      flex: 'none', width: '17px', height: '17px', borderRadius: '5px', display: 'inline-flex',
      alignItems: 'center', justifyContent: 'center', fontFamily: ui, fontSize: '10.5px', fontWeight: '700',
      lineHeight: '1',
    },
    ...kindRules,
    '.cm-tooltip.cm-completionInfo': {
      ...card, padding: '0', maxWidth: '420px', minWidth: '260px', marginLeft: '6px', marginTop: '-4px',
    },
    '.cm-completionInfo.cm-completionInfo-left': { marginLeft: '0', marginRight: '6px' },
    '.gj-info': { padding: '10px 12px' },
    '.gj-info-head': { display: 'flex', alignItems: 'center', gap: '7px', marginBottom: '7px' },
    '.gj-info-kind': { fontSize: '10px', fontWeight: '600', letterSpacing: '0.08em', textTransform: 'uppercase', color: '#6b717c' },
    '.gj-info-sig': {
      margin: '0 0 8px', padding: '7px 9px', borderRadius: '7px', background: 'rgba(0, 0, 0, 0.28)',
      border: '1px solid #1e2127', fontFamily: mono, fontSize: '12px', lineHeight: '1.5', whiteSpace: 'pre-wrap',
      wordBreak: 'break-word', maxHeight: '140px', overflowY: 'auto',
    },
    '.gj-info .gj-md': { maxHeight: '240px', overflowY: 'auto' },

    // ---- signature help ---------------------------------------------------
    '.gj-sig': { padding: '6px 10px', maxWidth: '640px' },
    '.gj-sig-row': { display: 'flex', alignItems: 'baseline', gap: '8px' },
    '.gj-sig-count': {
      flex: 'none', fontSize: '10.5px', color: '#6b717c', fontVariantNumeric: 'tabular-nums',
      padding: '1px 6px', borderRadius: '999px', background: 'rgba(255,255,255,0.05)',
    },
    '.gj-sig-label': { margin: '0', fontFamily: mono, fontSize: '12.5px', whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
    '.gj-sig-active': {
      background: 'rgba(124, 196, 255, 0.16)', borderRadius: '4px', padding: '0 2px',
      boxShadow: 'inset 0 -2px 0 #7cc4ff', fontWeight: '600',
    },
    '.gj-sig .gj-card-body': { marginTop: '6px', paddingTop: '6px', borderTop: '1px solid #23262d', fontSize: '12px', maxHeight: '120px' },

    // ---- diagnostics ------------------------------------------------------
    '.cm-lintRange': { backgroundPosition: 'left bottom', backgroundRepeat: 'repeat-x', paddingBottom: '2px' },
    '.cm-lintRange-error': { backgroundImage: wave(C.error) },
    '.cm-lintRange-warning': { backgroundImage: wave(C.warning) },
    '.cm-lintRange-info': { backgroundImage: wave(C.info) },
    '.cm-lintRange-hint': { backgroundImage: 'none', borderBottom: `1px dotted ${alpha(C.text, 0.6)}` },
    '.cm-lintRange.gj-unnecessary': { backgroundImage: 'none', opacity: '0.5' },
    '.cm-lintRange-active': { backgroundColor: 'rgba(255, 255, 255, 0.04)' },
    '.cm-tooltip-lint': { padding: '0' },
    '.cm-diagnostic': { padding: '9px 12px !important', borderLeft: 'none !important', marginLeft: '0 !important' },
    '.cm-diagnostic + .cm-diagnostic': { borderTop: '1px solid #23262d' },
    '.gj-diag-head': { display: 'flex', gap: '8px', alignItems: 'flex-start' },
    '.gj-diag-icon': {
      flex: 'none', width: '16px', height: '16px', borderRadius: '50%', display: 'inline-flex', alignItems: 'center',
      justifyContent: 'center', fontSize: '10px', fontWeight: '800', marginTop: '1px',
    },
    '.gj-sev-error': { color: '#1a0b0b', background: C.error },
    '.gj-sev-warning': { color: '#1a1405', background: C.warning },
    '.gj-sev-info, .gj-sev-hint': { color: '#06121c', background: C.info },
    '.gj-diag-msg': { color: '#e8eaed', lineHeight: '1.5', whiteSpace: 'pre-wrap', fontFamily: ui },
    '.gj-diag-notes': { margin: '6px 0 0 24px', display: 'grid', gap: '3px' },
    '.gj-diag-note': { color: '#8b919c', fontFamily: mono, fontSize: '11.5px', whiteSpace: 'pre-wrap', lineHeight: '1.45' },
    '.gj-diag-meta': { display: 'flex', gap: '6px', margin: '7px 0 0 24px', alignItems: 'center' },
    '.gj-diag-source': { fontSize: '10.5px', color: '#6b717c' },
    '.gj-diag-code': {
      fontFamily: mono, fontSize: '10.5px', padding: '1px 6px', borderRadius: '999px', color: '#a6acb6',
      background: 'rgba(255, 255, 255, 0.06)', textDecoration: 'none',
    },
    'a.gj-diag-code:hover': { color: C.accent, background: 'rgba(124, 196, 255, 0.13)' },
    '.cm-diagnosticAction': {
      font: `600 11.5px ${ui}`, color: '#06121c !important', background: `${C.accent} !important`,
      border: 'none', borderRadius: '6px', padding: '3px 9px !important', margin: '8px 6px 0 24px !important',
      cursor: 'pointer',
    },
    '.cm-diagnosticAction + .cm-diagnosticAction': { marginLeft: '0 !important' },
    '.cm-diagnosticAction::before': { content: '"✦ "' },
    '.cm-diagnosticAction:hover': { filter: 'brightness(1.1)' },
    '.cm-diagnosticSource': { display: 'none' },

    // Error lens: the first message, quietly, at the end of the line.
    '.gj-lens': {
      marginLeft: '2.4em', padding: '0 8px 0 7px', borderRadius: '5px', fontFamily: ui, fontSize: '11.5px',
      fontStyle: 'normal', whiteSpace: 'nowrap', pointerEvents: 'none', userSelect: 'none',
    },
    '.gj-lens::before': { content: '"●"', fontSize: '7px', marginRight: '6px', verticalAlign: '2px' },
    '.gj-lens-error': { color: alpha(C.error, 0.85), background: `linear-gradient(90deg, ${alpha(C.error, 0.1)}, transparent 85%)` },
    '.gj-lens-warning': { color: alpha(C.warning, 0.8), background: `linear-gradient(90deg, ${alpha(C.warning, 0.08)}, transparent 85%)` },
    '.gj-lens-info': { color: alpha(C.info, 0.75), background: `linear-gradient(90deg, ${alpha(C.info, 0.07)}, transparent 85%)` },
    '.gj-lens-more': {
      marginLeft: '7px', padding: '0 5px', borderRadius: '999px', fontSize: '10px', background: 'rgba(255,255,255,0.06)',
      color: '#8b919c',
    },
    '.gj-gutter-error .cm-gj-num': { color: `${C.error} !important` },
    '.gj-gutter-warning .cm-gj-num': { color: `${C.warning} !important` },

    // ---- inlay hints ------------------------------------------------------
    '.gj-inlay': {
      fontFamily: ui, fontSize: '10.5px', color: '#7b818c', background: 'rgba(255, 255, 255, 0.045)',
      borderRadius: '4px', padding: '1px 5px', margin: '0 1px', verticalAlign: '1px', userSelect: 'none',
    },
    '.gj-inlay-parameter': { color: '#6b717c' },
    '.gj-inlay-pl': { marginLeft: '4px' },
    '.gj-inlay-pr': { marginRight: '4px' },

    // ---- go to definition -------------------------------------------------
    '.gj-link': { textDecoration: `underline ${C.accent}`, textUnderlineOffset: '3px', cursor: 'pointer', color: '#e8eaed' },
    '.gj-flash': { animation: 'gj-flash 900ms ease-out', borderRadius: '3px' },
    '@keyframes gj-flash': {
      from: { backgroundColor: 'rgba(124, 196, 255, 0.35)' },
      to: { backgroundColor: 'rgba(124, 196, 255, 0)' },
    },
    '.gj-peek': { width: 'min(640px, 80vw)', padding: '0', overflow: 'hidden' },
    '.gj-peek-head': {
      display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', padding: '8px 12px',
      borderBottom: '1px solid #23262d', background: 'rgba(255,255,255,0.02)',
    },
    '.gj-peek-path': { fontFamily: mono, fontSize: '12px', color: C.accent },
    '.gj-peek-line': { fontSize: '11px', color: '#6b717c' },
    '.gj-peek-code': { margin: '0', maxHeight: '200px', overflowY: 'auto', padding: '6px 0', fontFamily: mono, fontSize: '12px', lineHeight: '1.55' },
    '.gj-peek-row': { display: 'flex', padding: '0 12px 0 0' },
    '.gj-peek-target': { background: 'rgba(124, 196, 255, 0.1)', boxShadow: `inset 2px 0 0 ${C.accent}` },
    '.gj-peek-num': { flex: 'none', width: '44px', textAlign: 'right', paddingRight: '12px', color: '#4b515c', userSelect: 'none' },
    '.gj-peek-src': { whiteSpace: 'pre', fontFamily: mono },
    '.gj-peek-hint': { padding: '5px 12px', fontSize: '10.5px', color: '#4b515c', borderTop: '1px solid #1e2127', textAlign: 'right' },

    // ---- status pill ------------------------------------------------------
    '.gj-status': {
      position: 'absolute', right: '12px', bottom: '10px', zIndex: '5', display: 'flex', alignItems: 'center', gap: '6px',
      padding: '3px 9px 3px 7px', borderRadius: '999px', fontFamily: ui, fontSize: '11px', color: '#8b919c',
      background: 'rgba(20, 22, 27, 0.8)', border: '1px solid #23262d', backdropFilter: 'blur(8px)',
      transition: 'opacity 300ms ease, padding 300ms ease', pointerEvents: 'auto', userSelect: 'none',
    },
    '.gj-status-dot': { width: '6px', height: '6px', borderRadius: '50%', background: '#6b717c', flex: 'none' },
    '.gj-status[data-state="loading"] .gj-status-dot': { background: C.warning, animation: 'gj-pulse 1.1s ease-in-out infinite' },
    '.gj-status[data-state="ready"] .gj-status-dot': { background: '#4ade80', boxShadow: '0 0 6px rgba(74, 222, 128, 0.6)' },
    '.gj-status[data-state="error"] .gj-status-dot': { background: C.error },
    '.gj-status-text': { whiteSpace: 'nowrap', overflow: 'hidden', maxWidth: '220px', transition: 'max-width 300ms ease, opacity 300ms ease' },
    '.gj-status.gj-status-quiet': { opacity: '0.55', padding: '5px' },
    '.gj-status.gj-status-quiet .gj-status-text': { maxWidth: '0', opacity: '0' },
    '.gj-status.gj-status-quiet:hover': { opacity: '1', padding: '3px 9px 3px 7px' },
    '.gj-status.gj-status-quiet:hover .gj-status-text': { maxWidth: '220px', opacity: '1' },
    '@keyframes gj-pulse': { '0%, 100%': { opacity: '1' }, '50%': { opacity: '0.35' } },
  },
  { dark: true },
);
