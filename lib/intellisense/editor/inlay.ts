/** Inlay hints (types and parameter names) for backends that provide them. */

import { StateEffect, StateField, type Extension } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import type { InlayHint } from '../types';
import { toOffset, type Ctx } from './context';

class HintWidget extends WidgetType {
  constructor(readonly hint: InlayHint) {
    super();
  }
  eq(other: HintWidget) {
    return other.hint.label === this.hint.label && other.hint.kind === this.hint.kind;
  }
  toDOM() {
    const span = document.createElement('span');
    span.className = `gj-inlay gj-inlay-${this.hint.kind}`;
    if (this.hint.paddingLeft) span.classList.add('gj-inlay-pl');
    if (this.hint.paddingRight) span.classList.add('gj-inlay-pr');
    span.textContent = this.hint.label;
    return span;
  }
}

const setHints = StateEffect.define<DecorationSet>();

const hintsField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    value = value.map(tr.changes);
    for (const e of tr.effects) if (e.is(setHints)) value = e.value;
    return value;
  },
  provide: (f) => EditorView.decorations.from(f),
});

export function inlayHints(c: Ctx): Extension {
  if (!c.service.inlayHints) return [];
  const plugin = ViewPlugin.fromClass(
    class {
      private timer: ReturnType<typeof setTimeout> | null = null;
      constructor(readonly view: EditorView) {
        this.schedule(50);
      }
      update(u: ViewUpdate) {
        if (u.docChanged) this.schedule(500);
      }
      schedule(delay: number) {
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => void this.refresh(), delay);
      }
      async refresh() {
        const doc = this.view.state.doc;
        const hints = await c.service.inlayHints!(doc.toString());
        if (this.view.state.doc !== doc) return;
        const decos = hints
          .map((h) => Decoration.widget({ widget: new HintWidget(h), side: h.kind === 'parameter' ? -1 : 1 }).range(toOffset(doc, h.position)))
          .sort((a, b) => a.from - b.from);
        this.view.dispatch({ effects: setHints.of(Decoration.set(decos, true)) });
      }
      destroy() {
        if (this.timer) clearTimeout(this.timer);
      }
    },
  );
  return [hintsField, plugin];
}
