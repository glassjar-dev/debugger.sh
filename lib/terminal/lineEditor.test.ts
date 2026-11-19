import assert from 'node:assert/strict';
import { test } from 'node:test';

import { LineEditor, type LineEditorOptions } from './lineEditor';

/** A one-line screen that understands what the editor writes: text, CR, CUB/CUF, EL, 2K. */
function screen() {
  let cells: string[] = [];
  let col = 0;
  const lines: string[] = [];
  const write = (data: string) => {
    const tokens = data.match(/\x1b\[\d*[A-Za-z]|\r\n|[\s\S]/gu) ?? [];
    for (const t of tokens) {
      if (t === '\r\n') {
        lines.push(cells.join('').trimEnd());
        cells = [];
        col = 0;
      } else if (t === '\r') col = 0;
      else if (t.startsWith('\x1b[')) {
        const n = Number(t.slice(2, -1) || 1);
        const op = t.at(-1);
        if (op === 'D') col = Math.max(0, col - n);
        else if (op === 'C') col += n;
        else if (op === 'K' && t.slice(2, -1) === '2') cells = [];
        else if (op === 'K') cells = cells.slice(0, col);
      } else {
        cells[col++] = t;
        // The CJK test character takes two cells, as in xterm.
        if (t === '你') cells[col++] = '';
      }
    }
  };
  return { write, text: () => cells.join(''), col: () => col, lines };
}

function editor(extra: Partial<LineEditorOptions> = {}) {
  const s = screen();
  const submitted: string[] = [];
  const ed = new LineEditor({ write: s.write, submit: (l) => submitted.push(l), ...extra });
  ed.begin('$ ');
  return { ed, s, submitted };
}

test('arrow keys edit in the middle of the line', () => {
  const { ed, s, submitted } = editor();
  ed.input('abc');
  ed.input('\x1b[D\x1b[D');
  ed.input('X');
  assert.equal(s.text(), '$ aXbc');
  assert.equal(s.col(), 4);
  ed.input('\r');
  assert.deepEqual(submitted, ['aXbc']);
});

test('backspace, delete, home/end and kill keys', () => {
  const { ed, s } = editor();
  ed.input('hello world');
  ed.input('\x7f\x7f');
  assert.equal(ed.line, 'hello wor');
  ed.input('\x01');
  ed.input('\x1b[3~');
  assert.equal(ed.line, 'ello wor');
  ed.input('\x05\x17');
  assert.equal(ed.line, 'ello ');
  ed.input('\x15');
  assert.equal(ed.line, '');
  assert.equal(s.text(), '$ ');
});

test('pasting several lines submits each one', () => {
  const { ed, submitted } = editor();
  ed.input('one\rtwo\r\nthree');
  assert.deepEqual(submitted, ['one', 'two']);
  assert.equal(ed.line, 'three');
});

test('history walks back and returns to the draft', () => {
  const history: string[] = [];
  const { ed, s } = editor({ history });
  ed.input('first\r');
  ed.begin('$ ');
  ed.input('second\r');
  ed.begin('$ ');
  ed.input('draft');
  ed.input('\x1b[A');
  assert.equal(ed.line, 'second');
  ed.input('\x1b[A');
  assert.equal(ed.line, 'first');
  ed.input('\x1b[B\x1b[B');
  assert.equal(ed.line, 'draft');
  assert.equal(s.text(), '$ draft');
  assert.deepEqual(history, ['first', 'second']);
});

test('ctrl keys: C interrupts, D on an empty line ends input', () => {
  let interrupted = 0;
  let ended = 0;
  const { ed } = editor({ interrupt: () => interrupted++, endOfInput: () => ended++ });
  ed.input('abc\x03');
  assert.equal(interrupted, 1);
  assert.equal(ed.line, '');
  ed.input('\x04');
  assert.equal(ended, 1);
});

test('tab completes, or lists the options', () => {
  const { ed, s } = editor({
    complete: (before) =>
      before === 'ca' ? { insert: 't ', options: [] } : { insert: '', options: ['main.py', 'math.py'] },
  });
  ed.input('ca\t');
  assert.equal(ed.line, 'cat ');
  ed.input('ma\t');
  assert.ok(s.lines.includes('main.py  math.py'));
  assert.equal(s.text(), '$ cat ma');
});

test('wide characters move the cursor by two cells', () => {
  const { ed, s } = editor();
  ed.input('a你b');
  ed.input('\x1b[D\x1b[D');
  assert.equal(s.col(), 3);
});
