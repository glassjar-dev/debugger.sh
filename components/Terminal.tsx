'use client';

import { useEffect, useRef } from 'react';
import '@xterm/xterm/css/xterm.css';

import type { TerminalLink } from '@/lib/terminal/session';

// Matches --gj-panel so the terminal sits flush in its card.
const xtermTheme = {
  background: '#0f1013',
  foreground: '#d7dae0',
  cursor: '#7cc4ff',
  selectionBackground: 'rgba(124, 196, 255, 0.28)',
  black: '#0f1013',
  brightBlack: '#666',
  red: '#cd3131',
  brightRed: '#f14c4c',
  green: '#0dbc79',
  brightGreen: '#23d18b',
  yellow: '#e5e510',
  brightYellow: '#f5f543',
  blue: '#2472c8',
  brightBlue: '#3b8eea',
  magenta: '#bc3fbc',
  brightMagenta: '#d670d6',
  cyan: '#11a8cd',
  brightCyan: '#29b8db',
  white: '#e5e5e5',
  brightWhite: '#fff',
};

/** The xterm view of a terminal session. The session keeps the screen, so remounts are harmless. */
function Terminal({ link }: { link: TerminalLink }) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Dynamic import — xterm touches `self`, which breaks SSR.
  useEffect(() => {
    let disposed = false;
    let resizeObserver: ResizeObserver | null = null;
    let unbind = () => {};
    let xterm: import('@xterm/xterm').Terminal | null = null;

    void (async () => {
      const [{ Terminal: XTerm }, { FitAddon }] = await Promise.all([
        import('@xterm/xterm'),
        import('@xterm/addon-fit'),
      ]);
      if (disposed || !containerRef.current) return;

      const term = new XTerm({
        fontFamily:
          'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
        fontSize: 13,
        lineHeight: 1.3,
        cursorBlink: true,
        cursorStyle: 'bar',
        theme: xtermTheme,
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(containerRef.current);
      fit.fit();
      link.size = { cols: term.cols, rows: term.rows };
      term.onResize(({ cols, rows }) => (link.size = { cols, rows }));
      term.onData((data) => link.onInput(data));
      unbind = link.bind({ write: (data) => term.write(data), focus: () => term.focus() });
      xterm = term;

      resizeObserver = new ResizeObserver(() => {
        requestAnimationFrame(() => !disposed && fit.fit());
      });
      resizeObserver.observe(containerRef.current);
    })();

    return () => {
      disposed = true;
      resizeObserver?.disconnect();
      unbind();
      xterm?.dispose();
    };
  }, [link]);

  return (
    <div className="ide-terminal-wrap">
      <div
        ref={containerRef}
        style={{
          height: '100%',
          width: '100%',
          padding: '10px 14px',
          boxSizing: 'border-box',
          background: xtermTheme.background,
          flex: 1,
          minHeight: 0,
          overflow: 'hidden',
        }}
      />
    </div>
  );
}

export default Terminal;
