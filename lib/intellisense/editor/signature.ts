/**
 * Signature help: a card above the cursor while typing call arguments, with
 * the active parameter lit up. Opens on `(` and `,`, follows the cursor, and
 * closes when the call ends. ⌥↑/⌥↓ cycle overloads; Esc closes.
 */

import { StateEffect, StateField, type Extension } from '@codemirror/state';
import { EditorView, keymap, showTooltip, ViewPlugin, type Tooltip, type ViewUpdate } from '@codemirror/view';
import type { SignatureResult } from '../types';
import { docText, toPosition, type Ctx } from './context';
import { el, renderMarkdown } from './render';

type SigState = { pos: number; result: SignatureResult; index: number } | null;

const setSig = StateEffect.define<SigState>();
const cycle = StateEffect.define<number>();

function render(c: Ctx, s: NonNullable<SigState>): HTMLElement {
  const sig = s.result.signatures[s.index];
  const dom = el('div', 'gj-card gj-sig');
  const row = el('div', 'gj-sig-row');
  if (s.result.signatures.length > 1) {
    row.append(el('span', 'gj-sig-count', `${s.index + 1}/${s.result.signatures.length}`));
  }
  const label = el('pre', 'gj-sig-label');
  const active = s.index === s.result.active ? s.result.activeParameter : s.result.activeParameter;
  const range = active != null ? sig.parameters[active] : undefined;
  if (range) {
    c.code(sig.label.slice(0, range[0]), label);
    const mark = el('span', 'gj-sig-active');
    c.code(sig.label.slice(range[0], range[1]), mark);
    label.append(mark);
    const rest = el('span');
    c.code(sig.label.slice(range[1]), rest);
    label.append(rest);
  } else {
    c.code(sig.label, label);
  }
  label.querySelectorAll('.gj-code').forEach((n) => n.classList.remove('gj-code'));
  row.append(label);
  dom.append(row);
  if (sig.documentation) {
    const body = renderMarkdown(sig.documentation, c.code, c.lang);
    body.classList.add('gj-card-body');
    dom.append(body);
  }
  return dom;
}

/** Anchors the card at the call's `(` so it doesn't slide along while typing. */
function openParen(text: string, head: number): number {
  let depth = 0;
  for (let i = head - 1; i >= 0 && head - i < 2000; i--) {
    const ch = text[i];
    if (ch === ')' || ch === ']' || ch === '}') depth++;
    else if (ch === '(' || ch === '[' || ch === '{') {
      if (depth === 0) return ch === '(' ? i : head;
      depth--;
    } else if (ch === ';') break;
  }
  return head;
}

export function signatureHelp(c: Ctx): Extension {
  const field = StateField.define<SigState>({
    create: () => null,
    update(value, tr) {
      for (const e of tr.effects) {
        if (e.is(setSig)) value = e.value;
        else if (e.is(cycle) && value) {
          const n = value.result.signatures.length;
          value = { ...value, index: (value.index + e.value + n) % n };
        }
      }
      if (value && tr.docChanged) value = { ...value, pos: tr.changes.mapPos(value.pos) };
      return value;
    },
    provide: (f) =>
      showTooltip.compute([f], (state): Tooltip | null => {
        const s = state.field(f);
        if (!s) return null;
        return { pos: s.pos, above: true, strictSide: false, arrow: false, create: () => ({ dom: render(c, s) }) };
      }),
  });

  const triggers = c.service.signatureTriggers;

  const plugin = ViewPlugin.fromClass(
    class {
      private timer: ReturnType<typeof setTimeout> | null = null;
      private seq = 0;
      constructor(readonly view: EditorView) {}
      update(u: ViewUpdate) {
        const open = u.state.field(field) != null;
        let typedTrigger = false;
        let typedClose = false;
        for (const tr of u.transactions) {
          if (!tr.isUserEvent('input.type') && !tr.isUserEvent('input.complete')) continue;
          tr.changes.iterChanges((_a, _b, _c, _d, inserted) => {
            const t = inserted.toString();
            if (triggers.some((ch) => t.endsWith(ch)) || (tr.isUserEvent('input.complete') && t.includes('('))) typedTrigger = true;
            if (t.endsWith(')')) typedClose = true;
          });
        }
        if (typedTrigger || typedClose || (open && (u.docChanged || u.selectionSet))) this.schedule(typedTrigger ? 30 : 120);
      }
      schedule(delay: number) {
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => void this.query(), delay);
      }
      async query() {
        const seq = ++this.seq;
        const state = this.view.state;
        const head = state.selection.main.head;
        const result = await c.service.signature(docText(state), toPosition(state.doc, head));
        if (seq !== this.seq) return;
        // The user kept typing while clang worked: ask again for the new text.
        if (this.view.state.doc !== state.doc || !this.view.state.selection.main.eq(state.selection.main)) {
          this.schedule(60);
          return;
        }
        const prev = this.view.state.field(field);
        if (!result?.signatures.length) {
          if (prev) this.view.dispatch({ effects: setSig.of(null) });
          return;
        }
        // Keep the overload the user picked if the list didn't change.
        const keep = prev && prev.result.signatures.length === result.signatures.length ? prev.index : result.active;
        this.view.dispatch({ effects: setSig.of({ pos: openParen(state.doc.toString(), head), result, index: keep }) });
      }
      destroy() {
        if (this.timer) clearTimeout(this.timer);
      }
    },
  );

  const when = (f: (view: EditorView) => boolean) => (view: EditorView) => (view.state.field(field) ? f(view) : false);
  return [
    field,
    plugin,
    keymap.of([
      { key: 'Escape', run: when((view) => (view.dispatch({ effects: setSig.of(null) }), true)) },
      { key: 'Alt-ArrowUp', run: when((view) => (view.dispatch({ effects: cycle.of(-1) }), true)) },
      { key: 'Alt-ArrowDown', run: when((view) => (view.dispatch({ effects: cycle.of(1) }), true)) },
      {
        key: 'Mod-Shift-Space',
        run: (view) => {
          view.plugin(plugin)?.schedule(0);
          return true;
        },
      },
    ]),
    EditorView.updateListener.of((u) => {
      // Leaving the editor closes the card.
      if (u.focusChanged && !u.view.hasFocus && u.state.field(field)) u.view.dispatch({ effects: setSig.of(null) });
    }),
  ];
}
