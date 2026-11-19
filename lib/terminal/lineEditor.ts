/**
 * A readline-style line editor for the terminal: it turns xterm input into terminal
 * output (echo and redraws) and finished lines. The shell prompt and a running program's
 * input both use one, the way a real terminal's line discipline sits under both.
 *
 * Pure (no DOM), so it can be tested on its own.
 */

export type LineEditorOptions = {
  /** Writes to the terminal. */
  write: (data: string) => void;
  /** A finished line (without its newline). */
  submit: (line: string) => void;
  /** Ctrl+C. The line is abandoned. */
  interrupt?: () => void;
  /** Ctrl+D on an empty line. */
  endOfInput?: () => void;
  /** Ctrl+L. The editor redraws its line afterwards. */
  clearScreen?: () => void;
  /** Tab: completions for the text before the cursor. */
  complete?: (before: string) => Completion;
  /** Lines kept for Up/Down, oldest first. Shared with the caller so it can persist them. */
  history?: string[];
};

export type Completion = {
  /** Text to insert at the cursor. */
  insert: string;
  /** Candidates to list when the completion is ambiguous. */
  options: string[];
};

const MAX_HISTORY = 200;
const ESC = '\x1b';

/** Display width of one character: wide East Asian and emoji take two cells. */
function cellWidth(ch: string): number {
  const code = ch.codePointAt(0) ?? 0;
  if (code < 0x1100) return 1;
  return /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦\u{1f300}-\u{1faff}\u{20000}-\u{3fffd}]/u.test(ch)
    ? 2
    : 1;
}

/** What's on the cursor's line after `text`: after its last newline or carriage return. */
export function lastLine(text: string): string {
  return text.slice(Math.max(text.lastIndexOf('\n'), text.lastIndexOf('\r')) + 1);
}

function width(text: string): number {
  let total = 0;
  for (const ch of text) total += cellWidth(ch);
  return total;
}

export class LineEditor {
  private chars: string[] = [];
  private cursor = 0;
  private prompt = '';
  private historyIndex: number | null = null;
  private draft = '';
  private active = false;
  private readonly history: string[];
  private readonly options: LineEditorOptions;

  constructor(options: LineEditorOptions) {
    this.options = options;
    this.history = options.history ?? [];
  }

  get line(): string {
    return this.chars.join('');
  }

  /**
   * Start a fresh line after `prompt`. `shown` means the prompt is already on screen, like
   * a program's `Name: ` that its input continues.
   */
  begin(prompt = '', shown = false) {
    this.prompt = prompt;
    this.chars = [];
    this.cursor = 0;
    this.historyIndex = null;
    this.active = true;
    if (prompt && !shown) this.options.write(prompt);
  }

  /** Stop editing (e.g. a program took over the terminal). */
  end() {
    this.active = false;
  }

  get editing(): boolean {
    return this.active;
  }

  /**
   * Output that arrives while a program's input is being typed: it continues the line the
   * typing started on (a prompt like `Name: `), and the typed text moves to the end of it.
   */
  print(text: string) {
    if (!text) return;
    if (!this.active) return this.options.write(text);
    if (this.chars.length === 0) {
      this.options.write(text);
    } else {
      this.options.write(`\r${ESC}[2K${this.prompt}${text}${this.line}`);
      this.moveCursorFrom(this.chars.length);
    }
    this.prompt = lastLine(this.prompt + text);
  }

  /** Output that arrives at the shell prompt: it goes above, and the prompt redraws below. */
  printAbove(text: string) {
    if (!text) return;
    if (!this.active) return this.options.write(text);
    this.options.write(`\r${ESC}[2K${text}${/\n$/.test(text) ? '' : '\r\n'}`);
    this.redraw();
  }

  /** Redraw the prompt and line, e.g. after output landed in the middle of it. */
  redraw() {
    if (!this.active) return;
    this.options.write(`\r${ESC}[2K${this.prompt}${this.line}`);
    this.moveCursorFrom(this.chars.length);
  }

  /** Feed raw input from xterm's onData: keys, escape sequences or pasted text. */
  input(data: string) {
    if (!this.active) return;
    // Pasted text arrives as one chunk; split it into keys, keeping escape sequences whole.
    const keys = data.match(/\x1b\[[0-9;]*[~A-Za-z]|\x1bO[A-Za-z]|\x1b[bfd\x7f]|\r\n|[\s\S]/gu) ?? [];
    for (const key of keys) {
      if (!this.active) return;
      this.key(key);
    }
  }

  private key(key: string) {
    switch (key) {
      case '\r':
      case '\n':
      case '\r\n':
        return this.accept();
      case '\x7f':
      case '\b':
        return this.deleteBack(1);
      case `${ESC}[3~`:
        return this.deleteForward();
      case `${ESC}[D`:
      case '\x02':
        return this.moveTo(this.cursor - 1);
      case `${ESC}[C`:
      case '\x06':
        return this.moveTo(this.cursor + 1);
      case `${ESC}[H`:
      case `${ESC}OH`:
      case `${ESC}[1~`:
      case '\x01':
        return this.moveTo(0);
      case `${ESC}[F`:
      case `${ESC}OF`:
      case `${ESC}[4~`:
      case '\x05':
        return this.moveTo(this.chars.length);
      case `${ESC}[1;3D`:
      case `${ESC}[1;5D`:
      case `${ESC}b`:
        return this.moveTo(this.wordStart());
      case `${ESC}[1;3C`:
      case `${ESC}[1;5C`:
      case `${ESC}f`:
        return this.moveTo(this.wordEnd());
      case `${ESC}[A`:
      case '\x10':
        return this.recall(-1);
      case `${ESC}[B`:
      case '\x0e':
        return this.recall(1);
      case '\x15':
        return this.deleteBack(this.cursor);
      case '\x0b':
        return this.replace(this.chars.slice(0, this.cursor), this.cursor);
      case '\x17':
      case `${ESC}\x7f`:
        return this.deleteBack(this.cursor - this.wordStart());
      case '\x03':
        this.options.write('^C\r\n');
        this.chars = [];
        this.cursor = 0;
        return this.options.interrupt?.();
      case '\x04':
        if (this.chars.length === 0) return this.options.endOfInput?.();
        return this.deleteForward();
      case '\x0c':
        this.options.clearScreen?.();
        return this.redraw();
      case '\t':
        return this.tab();
    }
    if (key.startsWith(ESC)) return; // Unknown escape sequences (F-keys and the like).
    if (key < ' ' && key !== '\t') return;
    this.insert(key);
  }

  private accept() {
    const line = this.line;
    this.moveTo(this.chars.length);
    this.options.write('\r\n');
    if (line.trim() && this.history[this.history.length - 1] !== line) {
      this.history.push(line);
      if (this.history.length > MAX_HISTORY) this.history.splice(0, this.history.length - MAX_HISTORY);
    }
    this.chars = [];
    this.cursor = 0;
    this.historyIndex = null;
    this.options.submit(line);
  }

  private insert(text: string) {
    const added = [...text];
    this.replace(
      [...this.chars.slice(0, this.cursor), ...added, ...this.chars.slice(this.cursor)],
      this.cursor + added.length,
    );
  }

  private deleteBack(count: number) {
    if (count <= 0 || this.cursor === 0) return;
    const from = Math.max(0, this.cursor - count);
    this.replace([...this.chars.slice(0, from), ...this.chars.slice(this.cursor)], from);
  }

  private deleteForward() {
    if (this.cursor >= this.chars.length) return;
    this.replace([...this.chars.slice(0, this.cursor), ...this.chars.slice(this.cursor + 1)], this.cursor);
  }

  /** Replace the line and put the cursor at `cursor`, redrawing only from the first change. */
  private replace(next: string[], cursor: number) {
    let same = 0;
    while (same < this.chars.length && same < next.length && this.chars[same] === next[same]) same++;
    this.moveTo(Math.min(this.cursor, same));
    const tail = next.slice(this.cursor).join('');
    this.options.write(`${tail}${ESC}[K`);
    this.chars = next;
    this.cursor = next.length;
    this.moveTo(cursor);
  }

  private moveTo(target: number) {
    const to = Math.max(0, Math.min(this.chars.length, target));
    if (to === this.cursor) return;
    const cells = width(this.chars.slice(Math.min(to, this.cursor), Math.max(to, this.cursor)).join(''));
    if (cells) this.options.write(to < this.cursor ? `${ESC}[${cells}D` : `${ESC}[${cells}C`);
    this.cursor = to;
  }

  /** After writing the whole line, the cursor sits at `at`; move it back to `this.cursor`. */
  private moveCursorFrom(at: number) {
    const cells = width(this.chars.slice(this.cursor, at).join(''));
    if (cells) this.options.write(`${ESC}[${cells}D`);
  }

  private wordStart(): number {
    let i = this.cursor;
    while (i > 0 && /\s/.test(this.chars[i - 1]!)) i--;
    while (i > 0 && !/\s/.test(this.chars[i - 1]!)) i--;
    return i;
  }

  private wordEnd(): number {
    let i = this.cursor;
    while (i < this.chars.length && /\s/.test(this.chars[i]!)) i++;
    while (i < this.chars.length && !/\s/.test(this.chars[i]!)) i++;
    return i;
  }

  private recall(step: -1 | 1) {
    if (this.history.length === 0) return;
    if (this.historyIndex === null) {
      if (step === 1) return;
      this.draft = this.line;
      this.historyIndex = this.history.length;
    }
    const next = this.historyIndex + step;
    if (next < 0) return;
    const text = next >= this.history.length ? this.draft : this.history[next]!;
    this.historyIndex = next >= this.history.length ? null : next;
    const chars = [...text];
    this.moveTo(0);
    this.replace(chars, chars.length);
  }

  private tab() {
    const complete = this.options.complete;
    if (!complete) return this.insert('  ');
    const { insert, options } = complete(this.chars.slice(0, this.cursor).join(''));
    if (insert) return this.insert(insert);
    if (options.length > 1) {
      this.options.write(`\r\n${options.join('  ')}\r\n`);
      this.redraw();
    }
  }
}
