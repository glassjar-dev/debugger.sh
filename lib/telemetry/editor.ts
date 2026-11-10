'use client';

import { Transaction } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { ExternalChange } from '@uiw/react-codemirror';

import type { EditReason } from './coalesce';
import { Telemetry } from './client';

function reasonFor(userEvent: string | undefined): EditReason | undefined {
  if (userEvent === 'input.paste') return 'paste';
  if (userEvent === 'undo') return 'undo';
  if (userEvent === 'redo') return 'redo';
  return undefined;
}

/** Records document transactions for `file`. Merging and upload live in the telemetry client. */
export function telemetryEditor(file: string) {
  return EditorView.updateListener.of((update) => {
    if (!update.docChanged) return;
    try {
      for (const tr of update.transactions) {
        if (!tr.docChanged || tr.annotation(ExternalChange)) continue;
        const reason = reasonFor(tr.annotation(Transaction.userEvent));
        let delta = 0;
        tr.changes.iterChanges((from, to, _fromB, _toB, inserted) => {
          const text = inserted.toString();
          const deleted = to - from;
          Telemetry.log('edit', {
            file,
            offset: from + delta,
            deleted: deleted > 0 ? deleted : undefined,
            inserted: text.length > 0 ? text : undefined,
            reason,
          });
          delta += text.length - deleted;
        });
      }
    } catch {
      // An edit log failure must not break typing.
    }
  });
}
