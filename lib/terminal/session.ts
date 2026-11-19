/**
 * One terminal session for the page: the shell at its prompt, a running program's
 * input, and what's on screen, which outlives the xterm view (panels can remount it).
 *
 * Input goes to the shell's line editor at the prompt and to a second one while a
 * program runs, so typing to a program edits like a real terminal's line discipline.
 */

import type { Lang } from '@/components/constants';
import { entryFile } from '@/lib/workspace/model';

import { lastLine, LineEditor } from './lineEditor';
import { Shell, type ShellHost } from './shell';

/** What a running program does with its terminal. */
export type ProgramIO = {
  write: (text: string) => void;
  /** Ctrl+D: end of input. */
  end: () => void;
  /** Ctrl+C. */
  stop: () => void;
};

/** How runs talk to the terminal. */
export interface ExecConsole {
  /** Program output and IDE notes. */
  output(text: string): void;
  /** The running program's input, or null once it's done. */
  attach(io: ProgramIO | null): void;
  size(): { cols: number; rows: number };
}

type View = { write: (data: string) => void; focus: () => void };

const MAX_TRANSCRIPT = 400_000;
const CLEAR = '\x1b[H\x1b[2J\x1b[3J';

/** The screen's contents, replayed into each new xterm view. */
export class TerminalLink {
  size = { cols: 80, rows: 24 };
  onInput: (data: string) => void = () => {};
  private transcript = '';
  private view: View | null = null;

  /** Attach an xterm view; returns the detach function. */
  bind(view: View): () => void {
    this.view = view;
    if (this.transcript) view.write(this.transcript);
    return () => {
      if (this.view === view) this.view = null;
    };
  }

  write(data: string) {
    this.transcript += data;
    if (this.transcript.length > MAX_TRANSCRIPT) {
      const cut = this.transcript.indexOf('\n', this.transcript.length - MAX_TRANSCRIPT / 2);
      this.transcript = cut < 0 ? '' : this.transcript.slice(cut + 1);
    }
    this.view?.write(data);
  }

  clear() {
    this.transcript = '';
    // Through xterm's write queue, so output still waiting can't land after the clear.
    this.view?.write(CLEAR);
  }

  focus() {
    this.view?.focus();
  }
}

export type SessionHost = Omit<ShellHost, 'write' | 'clear' | 'columns'>;

export class TerminalSession implements ExecConsole {
  readonly link = new TerminalLink();
  readonly shell: Shell;
  private host: SessionHost | null = null;
  private lang: Lang | null = null;
  private readonly prompt: LineEditor;
  private readonly input: LineEditor;
  private program: ProgramIO | null = null;
  private busy = false;
  /** The screen's current line so far. */
  private partial = '';

  constructor() {
    const write = (data: string) => this.emit(data);
    this.shell = new Shell({
      lang: () => this.need().lang(),
      workspace: () => this.need().workspace(),
      setWorkspace: (ws) => this.need().setWorkspace(ws),
      write: (text) => this.output(text),
      clear: () => this.clear(),
      columns: () => this.link.size.cols,
      run: (job) => this.need().run(job),
      open: (path) => this.host?.open?.(path) ?? false,
    });
    this.prompt = new LineEditor({
      write,
      submit: (line) => void this.execute(line),
      interrupt: () => {
        this.shell.interrupted();
        this.showPrompt();
      },
      clearScreen: () => this.clear(),
      complete: (before) => this.shell.complete(before),
      history: this.shell.history,
    });
    this.input = new LineEditor({
      write,
      submit: (line) => {
        this.program?.write(`${line}\n`);
        this.input.begin('', true);
      },
      interrupt: () => this.program?.stop(),
      endOfInput: () => this.program?.end(),
      clearScreen: () => this.clear(),
    });
    this.link.onInput = (data) => {
      if (this.program) this.input.input(data);
      else if (!this.busy) this.prompt.input(data);
    };
  }

  /** Connect the page (called on every render, so it always has the current language). */
  bind(host: SessionHost) {
    this.host = host;
    const lang = host.lang();
    if (this.lang === lang) return;
    const first = this.lang === null;
    this.lang = lang;
    if (first) {
      this.emit(`\x1b[2mglassjar shell · Run runs ${entryFile(lang)} · type help for more\x1b[0m\r\n`);
      this.showPrompt();
    } else if (!this.busy) {
      // A new language is a new workspace: start a fresh prompt for it.
      this.emit('\r\x1b[2K');
      this.prompt.begin(this.shell.prompt());
    }
  }

  get running(): boolean {
    return this.busy;
  }

  /** The Run button: type `run` at the prompt. False if a command is already running. */
  runProject(): boolean {
    if (this.busy || !this.host) return false;
    this.prompt.input('\x05\x15run\r');
    return true;
  }

  focus() {
    this.link.focus();
  }

  // ExecConsole -------------------------------------------------------------

  output(raw: string) {
    const text = raw.replace(/\r?\n/g, '\r\n');
    if (this.input.editing) this.input.print(text);
    else if (this.prompt.editing) this.prompt.printAbove(text);
    else this.emit(text);
  }

  attach(io: ProgramIO | null) {
    this.program = io;
    if (io) this.input.begin(this.partial, true);
    else this.input.end();
  }

  size() {
    return this.link.size;
  }

  // -------------------------------------------------------------------------

  private need(): SessionHost {
    if (!this.host) throw new Error('The terminal isn’t connected yet');
    return this.host;
  }

  private emit(data: string) {
    this.link.write(data);
    const line = lastLine(data);
    this.partial = line.length === data.length ? this.partial + data : line;
  }

  private clear() {
    this.link.clear();
    this.partial = '';
  }

  private async execute(line: string) {
    this.busy = true;
    this.prompt.end();
    try {
      await this.shell.execute(line);
    } finally {
      this.program = null;
      this.input.end();
      this.busy = false;
      this.showPrompt();
    }
  }

  private showPrompt() {
    // Output that didn't end its line keeps it; the prompt starts on the next one.
    if (this.partial.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')) this.emit('\r\n');
    this.prompt.begin(this.shell.prompt());
  }
}
