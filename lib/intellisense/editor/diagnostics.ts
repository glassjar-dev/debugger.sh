/**
 * Live diagnostics: squiggles, an "error lens" summary at the end of each
 * affected line, tinted line numbers, and quick fixes from clang fix-its /
 * rustc suggestions in the hover card.
 */

import { forEachDiagnostic, setDiagnostics, type Diagnostic as CmDiagnostic } from '@codemirror/lint';
import { RangeSet, StateEffect, StateField, type EditorState, type Extension } from '@codemirror/state';
import {
  Decoration,
  EditorView,
  gutterLineClass,
  GutterMarker,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view';
import { lintKeymap } from '@codemirror/lint';
import { keymap } from '@codemirror/view';
import type { Diagnostic } from '../types';
import { toOffset, type Ctx } from './context';
import { el } from './render';

const RANK = { error: 3, warning: 2, info: 1, hint: 0 } as const;

/** Docs for well-known codes, so the badge in the card is a link. */
function codeUrl(d: Diagnostic): string | undefined {
  if (!d.code) return undefined;
  if (d.source === 'rustc' && /^E\d{4}$/.test(d.code)) return `https://doc.rust-lang.org/error_codes/${d.code}.html`;
  if (d.source === 'basedpyright' && /^report\w+$/.test(d.code))
    return `https://docs.basedpyright.com/latest/configuration/config-files/#${d.code}`;
  if (d.source === 'clang' && d.code.startsWith('-W'))
    return `https://clang.llvm.org/docs/DiagnosticsReference.html#${d.code.slice(1).toLowerCase()}`;
  return undefined;
}

function toCm(d: Diagnostic, state: EditorState): CmDiagnostic {
  let from = toOffset(state.doc, d.range.start);
  let to = toOffset(state.doc, d.range.end);
  if (to < from) [from, to] = [to, from];
  if (from === to) {
    // Point diagnostics: underline the next character, or the last one at a line end ("expected ';'").
    const line = state.doc.lineAt(from);
    if (line.to > from) to = from + 1;
    else if (from > line.from) from = from - 1;
  }
  return {
    from,
    to,
    severity: d.severity,
    message: d.message,
    source: d.source,
    markClass: d.unnecessary ? 'gj-unnecessary' : undefined,
    renderMessage: () => {
      const box = el('div', 'gj-diag');
      const head = el('div', 'gj-diag-head');
      head.append(el('span', `gj-diag-icon gj-sev-${d.severity}`, d.severity === 'error' ? '✕' : d.severity === 'warning' ? '!' : 'i'));
      head.append(el('span', 'gj-diag-msg', d.message));
      box.append(head);
      if (d.notes?.length) {
        const notes = el('div', 'gj-diag-notes');
        for (const n of d.notes) notes.append(el('div', 'gj-diag-note', n));
        box.append(notes);
      }
      const meta = el('div', 'gj-diag-meta');
      if (d.source) meta.append(el('span', 'gj-diag-source', d.source));
      if (d.code) {
        const url = codeUrl(d);
        const badge = el(url ? 'a' : 'span', 'gj-diag-code', d.code) as HTMLAnchorElement;
        if (url) {
          badge.href = url;
          badge.target = '_blank';
          badge.rel = 'noopener noreferrer';
        }
        meta.append(badge);
      }
      box.append(meta);
      return box;
    },
    actions: d.fixes?.map((fix) => ({
      name: fix.title.length > 48 ? fix.title.slice(0, 46) + '…' : fix.title,
      apply(view: EditorView) {
        view.dispatch({
          changes: fix.edits.map((e) => ({
            from: toOffset(view.state.doc, e.range.start),
            to: toOffset(view.state.doc, e.range.end),
            insert: e.text,
          })),
          userEvent: 'input.quickfix',
        });
      },
    })),
  };
}

// ---------------------------------------------------------------------------
// Error lens + gutter tint, derived from the lint state
// ---------------------------------------------------------------------------

class LensWidget extends WidgetType {
  constructor(readonly severity: string, readonly text: string, readonly more: number) {
    super();
  }
  eq(other: LensWidget) {
    return other.severity === this.severity && other.text === this.text && other.more === this.more;
  }
  toDOM() {
    const span = el('span', `gj-lens gj-lens-${this.severity}`);
    span.append(el('span', 'gj-lens-text', this.text));
    if (this.more) span.append(el('span', 'gj-lens-more', `+${this.more}`));
    // CodeMirror draws an end-of-line cursor at the widget's outer edge. The
    // lens's left margin sits inside this wrapper, so that edge stays where
    // the text ends instead of jumping to the message.
    const wrap = el('span', 'gj-lens-wrap');
    wrap.append(span);
    return wrap;
  }
  ignoreEvent() {
    return true;
  }
}

class SeverityClass extends GutterMarker {
  constructor(readonly elementClass: string) {
    super();
  }
}

const lensUpdate = StateEffect.define<null>();

function lensFor(state: EditorState) {
  const perLine = new Map<number, { severity: keyof typeof RANK; message: string; count: number }>();
  forEachDiagnostic(state, (d) => {
    if (d.severity === 'hint' || d.markClass === 'gj-unnecessary') return;
    const line = state.doc.lineAt(Math.min(d.from, state.doc.length)).number;
    const cur = perLine.get(line);
    const sev = d.severity as keyof typeof RANK;
    if (!cur) perLine.set(line, { severity: sev, message: d.message, count: 1 });
    else {
      cur.count++;
      if (RANK[sev] > RANK[cur.severity]) {
        cur.severity = sev;
        cur.message = d.message;
      }
    }
  });
  const lenses = [];
  const gutters = [];
  for (const [line, info] of [...perLine].sort((a, b) => a[0] - b[0])) {
    const l = state.doc.line(line);
    const first = info.message.split('\n')[0];
    lenses.push(
      Decoration.widget({ widget: new LensWidget(info.severity, first.length > 90 ? first.slice(0, 88) + '…' : first, info.count - 1), side: 1 }).range(l.to),
    );
    gutters.push(new SeverityClass(`gj-gutter-${info.severity}`).range(l.from));
  }
  return { lenses: Decoration.set(lenses), gutters: RangeSet.of(gutters) };
}

const lensField = StateField.define<{ lenses: DecorationSet; gutters: RangeSet<GutterMarker> }>({
  create: (state) => lensFor(state),
  update(value, tr) {
    if (tr.effects.some((e) => e.is(lensUpdate))) return lensFor(tr.state);
    if (tr.docChanged) return { lenses: value.lenses.map(tr.changes), gutters: value.gutters.map(tr.changes) };
    return value;
  },
  provide: (f) => [EditorView.decorations.from(f, (v) => v.lenses), gutterLineClass.from(f, (v) => v.gutters)],
});

// ---------------------------------------------------------------------------

export function diagnostics(c: Ctx): Extension {
  const plugin = ViewPlugin.fromClass(
    class {
      private version = 0;
      private unsubscribe: () => void;
      constructor(readonly view: EditorView) {
        this.unsubscribe = c.service.onDiagnostics((version, list) => {
          // Stale results (the user typed since) are dropped; the newer check is on its way.
          if (version !== this.version && version !== -1) return;
          // Defer: diagnostics may arrive while the view is mid-update.
          queueMicrotask(() => {
            const state = this.view.state;
            this.view.dispatch(setDiagnostics(state, list.map((d) => toCm(d, state))));
            this.view.dispatch({ effects: lensUpdate.of(null) });
          });
        });
        c.service.update(view.state.doc.toString(), this.version);
      }
      update(u: ViewUpdate) {
        if (!u.docChanged) return;
        this.version++;
        c.service.update(u.state.doc.toString(), this.version);
      }
      destroy() {
        this.unsubscribe();
      }
    },
  );
  return [lensField, plugin, keymap.of(lintKeymap)];
}
