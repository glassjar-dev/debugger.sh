/** A small pill in the editor's corner showing the language service's state. */

import { ViewPlugin, type EditorView } from '@codemirror/view';
import type { ServiceStatus } from '../types';
import type { Ctx } from './context';
import { el } from './render';

const ENGINE: Record<string, string> = { cpp: 'clang', rust: 'rust-analyzer', python: 'basedpyright' };

export function statusPill(c: Ctx) {
  return ViewPlugin.fromClass(
    class {
      dom: HTMLElement;
      private off: () => void;
      private hideTimer: ReturnType<typeof setTimeout> | null = null;
      constructor(readonly view: EditorView) {
        this.dom = el('div', 'gj-status');
        this.dom.setAttribute('role', 'status');
        view.dom.append(this.dom);
        this.off = c.service.onStatus((s) => this.show(s));
      }
      show(s: ServiceStatus) {
        const name = ENGINE[c.lang] ?? 'IntelliSense';
        this.dom.dataset.state = s.state;
        this.dom.replaceChildren(
          el('span', 'gj-status-dot'),
          el('span', 'gj-status-text', s.state === 'loading' ? `${name} · loading` : s.state === 'error' ? `${name} · unavailable` : name),
        );
        this.dom.title = 'detail' in s && s.detail ? s.detail : name;
        // Once ready, fade to a quiet dot; hovering the editor corner shows it again.
        if (this.hideTimer) clearTimeout(this.hideTimer);
        this.dom.classList.remove('gj-status-quiet');
        if (s.state === 'ready') this.hideTimer = setTimeout(() => this.dom.classList.add('gj-status-quiet'), 2500);
      }
      destroy() {
        this.off();
        if (this.hideTimer) clearTimeout(this.hideTimer);
        this.dom.remove();
      }
    },
  );
}
