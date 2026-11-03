'use client';

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { SquareTerminal } from 'lucide-react';
import '@xterm/xterm/css/xterm.css';

import { EmptyState } from './EmptyState';

export type TerminalHandle = {
  write: (data: string | Uint8Array) => void;
  writeln: (data: string) => void;
  clear: () => void;
  focus: () => void;
  /** Register a stdin handler. Returns a dispose fn. Replaces any prior handler. */
  onData: (handler: (data: string) => void) => () => void;
};

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

const Terminal = forwardRef<TerminalHandle>((_props, ref) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<import('@xterm/xterm').Terminal | null>(null);
  const fitRef = useRef<import('@xterm/addon-fit').FitAddon | null>(null);
  const dataDisposerRef = useRef<{ dispose: () => void } | null>(null);
  // Show a hint until the program prints something.
  const [hasOutput, setHasOutput] = useState(false);

  useImperativeHandle(
    ref,
    () => ({
      write: (d) => {
        if (d.length) setHasOutput(true);
        termRef.current?.write(d);
      },
      writeln: (d) => {
        setHasOutput(true);
        termRef.current?.writeln(d);
      },
      // xterm queues write() but runs clear() at once, so output still waiting in the
      // queue would survive the clear and show up again in the redraw that follows.
      // Clearing through the same queue (home, erase screen, erase scrollback) keeps order.
      clear: () => termRef.current?.write('\x1b[H\x1b[2J\x1b[3J'),
      focus: () => termRef.current?.focus(),
      onData: (handler) => {
        dataDisposerRef.current?.dispose();
        const d = termRef.current?.onData(handler) ?? null;
        dataDisposerRef.current = d;
        return () => {
          d?.dispose();
          if (dataDisposerRef.current === d) dataDisposerRef.current = null;
        };
      },
    }),
    [],
  );

  // Dynamic import — xterm touches `self`, which breaks SSR.
  useEffect(() => {
    let disposed = false;
    let resizeObserver: ResizeObserver | null = null;

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

      termRef.current = term;
      fitRef.current = fit;

      resizeObserver = new ResizeObserver(() => {
        requestAnimationFrame(() => fitRef.current?.fit());
      });
      resizeObserver.observe(containerRef.current);
    })();

    return () => {
      disposed = true;
      resizeObserver?.disconnect();
      dataDisposerRef.current?.dispose();
      dataDisposerRef.current = null;
      termRef.current?.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, []);

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
      {!hasOutput && (
        <div className="ide-terminal-hint">
          <EmptyState icon={<SquareTerminal size={18} />} title="Program output">
            What your program prints shows up here. When it asks for input, click here and type.
          </EmptyState>
        </div>
      )}
    </div>
  );
});

Terminal.displayName = 'Terminal';
export default Terminal;
