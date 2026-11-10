/**
 * Hover cards and go-to-definition (F12 / ⌘-click / Ctrl-click), with an
 * inline "peek" card for definitions that live in a library header.
 */

import { StateEffect, StateField, type Extension } from '@codemirror/state';
import {
  Decoration,
  EditorView,
  hoverTooltip,
  keymap,
  showTooltip,
  ViewPlugin,
  type DecorationSet,
  type Tooltip,
  type ViewUpdate,
} from '@codemirror/view';
import type { DefinitionTarget } from '../types';
import { docText, toOffset, toPosition, type Ctx } from './context';
import { el, renderMarkdown } from './render';

export function hover(c: Ctx): Extension {
  return hoverTooltip(
    async (view, pos, side) => {
      const word = view.state.wordAt(pos);
      if (!word || (side < 0 && word.from === pos) || (side > 0 && word.to === pos)) return null;
      const h = await c.service.hover(docText(view.state), toPosition(view.state.doc, pos));
      if (!h || (!h.code && !h.markdown)) return null;
      const from = h.range ? toOffset(view.state.doc, h.range.start) : word.from;
      const to = h.range ? toOffset(view.state.doc, h.range.end) : word.to;
      return {
        pos: from,
        end: to,
        above: true,
        create: () => {
          const dom = el('div', 'gj-card gj-hover');
          if (h.kind) dom.append(el('div', 'gj-card-kind', h.kind));
          if (h.code) {
            const pre = el('pre', 'gj-card-code');
            c.code(h.code, pre);
            dom.append(pre);
          }
          if (h.markdown) {
            if (h.code) dom.append(el('div', 'gj-card-rule'));
            const body = renderMarkdown(h.markdown, c.code, c.lang);
            body.classList.add('gj-card-body');
            dom.append(body);
          }
          return { dom };
        },
      };
    },
    { hoverTime: 350 },
  );
}

// ---------------------------------------------------------------------------
// Go to definition
// ---------------------------------------------------------------------------

const flashEffect = StateEffect.define<{ from: number; to: number } | null>();
const flashField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    value = value.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(flashEffect)) {
        value = e.value ? Decoration.set([Decoration.mark({ class: 'gj-flash' }).range(e.value.from, e.value.to)]) : Decoration.none;
      }
    }
    return value;
  },
  provide: (f) => EditorView.decorations.from(f),
});

type Peek = { pos: number; targets: Extract<DefinitionTarget, { kind: 'external' }>[] };
const peekEffect = StateEffect.define<Peek | null>();

function peekField(c: Ctx) {
  return StateField.define<Peek | null>({
    create: () => null,
    update(value, tr) {
      for (const e of tr.effects) if (e.is(peekEffect)) return e.value;
      if (value && (tr.docChanged || tr.selection)) return null;
      return value;
    },
    provide: (f) =>
      showTooltip.compute([f], (state): Tooltip | null => {
        const peek = state.field(f);
        if (!peek) return null;
        return {
          pos: peek.pos,
          above: false,
          create: () => {
            const dom = el('div', 'gj-card gj-peek');
            // One definition at a time keeps the card short; others are listed in the header.
            const [t, ...others] = peek.targets;
            const head = el('div', 'gj-peek-head');
            const where = el('span', 'gj-peek-line', `line ${t.firstLine + t.line}`);
            if (others.length) where.textContent += ` · also ${others.map((o) => `${o.path === t.path ? '' : o.path + ':'}${o.firstLine + o.line}`).join(', ')}`;
            head.append(el('span', 'gj-peek-path', t.path), where);
            dom.append(head);
            if (t.snippet) {
              const pre = el('pre', 'gj-peek-code');
              c.lines(t.snippet).forEach((code, i) => {
                const row = el('div', i === t.line ? 'gj-peek-row gj-peek-target' : 'gj-peek-row');
                row.append(el('span', 'gj-peek-num', String(t.firstLine + i)));
                code.className = 'gj-peek-src';
                if (!code.textContent) code.textContent = ' ';
                row.append(code);
                pre.append(row);
              });
              dom.append(pre);
              requestAnimationFrame(() => {
                const target = pre.querySelector('.gj-peek-target') as HTMLElement | null;
                if (target) pre.scrollTop = target.offsetTop - pre.clientHeight / 3;
              });
            }
            dom.append(el('div', 'gj-peek-hint', 'esc to close'));
            return { dom };
          },
        };
      }),
  });
}

async function gotoDefinition(c: Ctx, view: EditorView, pos: number): Promise<boolean> {
  const targets = await c.service.definition(docText(view.state), toPosition(view.state.doc, pos));
  if (!targets?.length) return false;
  const local = targets.find((t) => t.kind === 'local');
  if (local && local.kind === 'local') {
    const from = toOffset(view.state.doc, local.range.start);
    const to = toOffset(view.state.doc, local.range.end);
    view.dispatch({
      selection: { anchor: from, head: to },
      effects: [EditorView.scrollIntoView(from, { y: 'center' }), flashEffect.of({ from, to })],
    });
    setTimeout(() => view.dispatch({ effects: flashEffect.of(null) }), 900);
    view.focus();
    return true;
  }
  const external = targets.filter((t): t is Extract<DefinitionTarget, { kind: 'external' }> => t.kind === 'external');
  view.dispatch({ effects: peekEffect.of({ pos, targets: external.slice(0, 4) }) });
  return true;
}

/** Underlines the word under the pointer while ⌘/Ctrl is held. */
const linkHint = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet = Decoration.none;
    mod = false;
    last: { x: number; y: number } | null = null;
    constructor(readonly view: EditorView) {}
    update(u: ViewUpdate) {
      if (u.docChanged) this.decorations = Decoration.none;
    }
    refresh() {
      let next = Decoration.none;
      if (this.mod && this.last) {
        const pos = this.view.posAtCoords(this.last);
        const word = pos != null ? this.view.state.wordAt(pos) : null;
        if (word) next = Decoration.set([Decoration.mark({ class: 'gj-link' }).range(word.from, word.to)]);
      }
      if (next.size !== this.decorations.size || (next.size && this.decorations.size && next.iter().from !== this.decorations.iter().from)) {
        this.decorations = next;
        this.view.dispatch({});
      }
    }
  },
  {
    decorations: (v) => v.decorations,
    eventObservers: {
      mousemove(event) {
        this.mod = event.metaKey || event.ctrlKey;
        this.last = { x: event.clientX, y: event.clientY };
        this.refresh();
      },
      keydown(event) {
        if (event.key === 'Meta' || event.key === 'Control') {
          this.mod = true;
          this.refresh();
        }
      },
      keyup(event) {
        if (event.key === 'Meta' || event.key === 'Control') {
          this.mod = false;
          this.refresh();
        }
      },
      mouseleave() {
        this.mod = false;
        this.refresh();
      },
    },
  },
);

export function definition(c: Ctx): Extension {
  const peek = peekField(c);
  return [
    flashField,
    peek,
    linkHint,
    EditorView.domEventHandlers({
      mousedown(event, view) {
        if (!(event.metaKey || event.ctrlKey) || event.button !== 0) return false;
        const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
        if (pos == null) return false;
        event.preventDefault();
        void gotoDefinition(c, view, pos);
        return true;
      },
    }),
    keymap.of([
      { key: 'F12', run: (view) => (void gotoDefinition(c, view, view.state.selection.main.head), true) },
      {
        key: 'Escape',
        run: (view) => {
          if (!view.state.field(peek)) return false;
          view.dispatch({ effects: peekEffect.of(null) });
          return true;
        },
      },
    ]),
  ];
}
