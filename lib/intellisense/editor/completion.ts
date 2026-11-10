/**
 * Completion menu: semantic results from the language backend, rendered with
 * kind glyphs, types on the right and a docs panel with the highlighted
 * signature and Markdown documentation.
 */

import {
  autocompletion,
  snippet,
  startCompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult as CmResult,
} from '@codemirror/autocomplete';
import { syntaxTree } from '@codemirror/language';
import type { EditorView } from '@codemirror/view';
import type { CompletionItem } from '../types';
import { docText, toOffset, toPosition, type Ctx } from './context';
import { el, kindIcon, kindLabel, renderMarkdown } from './render';

type GjCompletion = Completion & { item: CompletionItem };

/** Inside strings or comments the backend has nothing to offer. */
function inStringOrComment(ctx: CompletionContext): boolean {
  const node = syntaxTree(ctx.state).resolveInner(ctx.pos, -1);
  return /String|Comment|Char/.test(node.type.name) && !/Interpolation|FormatReplacement/.test(node.type.name);
}

function info(c: Ctx, item: CompletionItem) {
  return async (): Promise<Node | null> => {
    let doc = item;
    if (item.resolve) {
      const resolved = await item.resolve().catch(() => null);
      if (resolved) doc = { ...item, ...Object.fromEntries(Object.entries(resolved).filter(([, v]) => v != null)) };
    }
    if (!doc.signature && !doc.documentation) return null;
    const box = el('div', 'gj-info');
    const head = el('div', 'gj-info-head');
    head.append(kindIcon(doc.kind), el('span', 'gj-info-kind', kindLabel(doc.kind)));
    box.append(head);
    if (doc.signature) {
      const sig = el('pre', 'gj-info-sig');
      c.code(doc.signature, sig);
      box.append(sig);
    }
    if (doc.documentation) box.append(renderMarkdown(doc.documentation, c.code, c.lang));
    return box;
  };
}

function apply(item: CompletionItem): Completion['apply'] {
  const insert = item.insert ?? item.label;
  if (!item.additionalEdits?.length && !item.snippet && insert === item.label) return undefined;
  return (view: EditorView, completion: Completion, from: number, to: number) => {
    if (item.additionalEdits?.length) {
      // e.g. rust-analyzer's auto-import rewrites the `use` line above.
      const changes = view.state.changes(
        item.additionalEdits.map((e) => ({
          from: toOffset(view.state.doc, e.range.start),
          to: toOffset(view.state.doc, e.range.end),
          insert: e.text,
        })),
      );
      view.dispatch({ changes, userEvent: 'input.complete' });
      from = changes.mapPos(from, -1);
      to = changes.mapPos(to, 1);
    }
    if (item.snippet) snippet(insert)(view, completion, from, to);
    else
      view.dispatch({
        changes: { from, to, insert },
        selection: { anchor: from + insert.length },
        userEvent: 'input.complete',
      });
    // `std::` keeps going: reopen the menu for the next part.
    if (/::$/.test(insert)) startCompletion(view);
  };
}

function source(c: Ctx) {
  const triggers = c.service.triggerCharacters;
  return async (ctx: CompletionContext): Promise<CmResult | null> => {
    const word = ctx.matchBefore(/[A-Za-z_][\w]*/);
    const before = ctx.state.sliceDoc(Math.max(0, (word?.from ?? ctx.pos) - 2), word?.from ?? ctx.pos);
    const last = before.slice(-1);
    const triggered =
      triggers.includes(last) &&
      (last !== ':' || before === '::') &&
      (last !== '>' || before === '->');
    if (!ctx.explicit && !word && !triggered) return null;
    if (!ctx.explicit && inStringOrComment(ctx)) return null;
    // Don't pop up after a number (`3.`) or on a lone `_`.
    if (!ctx.explicit && last === '.' && /\d\.$/.test(before)) return null;

    const result = await c.service.complete(docText(ctx.state), toPosition(ctx.state.doc, ctx.pos), ctx.explicit);
    if (!result || ctx.aborted) return null;
    const from = toOffset(ctx.state.doc, result.from);
    // Names already used elsewhere in the file are the likeliest picks.
    const used = new Set(
      (ctx.state.sliceDoc(0, from) + ' ' + ctx.state.sliceDoc(ctx.pos)).match(/[A-Za-z_]\w*/g) ?? [],
    );
    const options: GjCompletion[] = result.items.map((item) => ({
      label: item.label,
      displayLabel: item.display,
      detail: item.detail,
      type: item.kind,
      boost: Math.max(-99, Math.min(99, (item.boost ?? 0) + (used.has(item.label) ? 2 : 0))),
      apply: apply(item),
      info: info(c, item),
      item,
    }));
    return { from, options, validFor: /^[A-Za-z_]\w*$/ };
  };
}

export function completion(c: Ctx) {
  return autocompletion({
    override: [source(c)],
    icons: false,
    maxRenderedOptions: 80,
    activateOnTypingDelay: 40,
    tooltipClass: () => 'gj-ac',
    optionClass: (option) => ((option as GjCompletion).item?.deprecated ? 'gj-deprecated' : ''),
    addToOptions: [
      {
        render: (option) => kindIcon((option as GjCompletion).item?.kind ?? 'text'),
        position: 20,
      },
    ],
  });
}
