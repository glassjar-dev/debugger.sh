/**
 * Shell command lines: words, quotes and the few operators the terminal understands
 * (`;`, `&&`, `||`, `<`, `>`, `>>`). Pure, so it can be tested on its own.
 */

export type Word = {
  text: string;
  /** Has an unquoted `*`, `?` or `[`, so it may expand to matching paths. */
  glob: boolean;
};

export type Redirect = { op: '<' | '>' | '>>'; target: Word };

export type Command = { words: Word[]; redirects: Redirect[] };

/** Commands in order, each with how it joins the one before it. */
export type Chain = { command: Command; after: ';' | '&&' | '||' }[];

type Op = ';' | '&&' | '||' | '|' | '&' | '<' | '>' | '>>' | '2>';
type Token = { kind: 'word'; word: Word } | { kind: 'op'; op: Op };

export type Parsed = { ok: true; chain: Chain } | { ok: false; error: string };

function tokenize(line: string): { ok: true; tokens: Token[] } | { ok: false; error: string } {
  const tokens: Token[] = [];
  let text = '';
  let glob = false;
  let inWord = false;
  const endWord = () => {
    if (inWord) tokens.push({ kind: 'word', word: { text, glob } });
    text = '';
    glob = false;
    inWord = false;
  };
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (/\s/.test(ch)) {
      endWord();
      continue;
    }
    if (ch === '#' && !inWord) break;
    if (ch === "'") {
      const close = line.indexOf("'", i + 1);
      if (close < 0) return { ok: false, error: 'missing closing quote (\')' };
      text += line.slice(i + 1, close);
      inWord = true;
      i = close;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      for (; j < line.length && line[j] !== '"'; j++) {
        if (line[j] === '\\' && /["\\$`]/.test(line[j + 1] ?? '')) j++;
        text += line[j];
      }
      if (j >= line.length) return { ok: false, error: 'missing closing quote (")' };
      inWord = true;
      i = j;
      continue;
    }
    if (ch === '\\') {
      if (i + 1 < line.length) text += line[++i];
      inWord = true;
      continue;
    }
    const two = line.slice(i, i + 2);
    if (two === '&&' || two === '||' || two === '>>') {
      endWord();
      tokens.push({ kind: 'op', op: two });
      i++;
      continue;
    }
    if (ch === '>' && inWord && text === '2' && !glob) {
      // `2>` redirects errors, which the terminal can't split out yet.
      text = '';
      inWord = false;
      tokens.push({ kind: 'op', op: '2>' });
      continue;
    }
    if (';|&<>'.includes(ch)) {
      endWord();
      tokens.push({ kind: 'op', op: ch as Op });
      continue;
    }
    if (ch === '~' && !inWord && (i + 1 === line.length || /[\s/;&|<>]/.test(line[i + 1]!))) {
      text = '/';
      inWord = true;
      if (line[i + 1] === '/') i++;
      continue;
    }
    if ('*?['.includes(ch)) glob = true;
    text += ch;
    inWord = true;
  }
  endWord();
  return { ok: true, tokens };
}

export function parse(line: string): Parsed {
  const lexed = tokenize(line);
  if (!lexed.ok) return lexed;
  const chain: Chain = [];
  let command: Command = { words: [], redirects: [] };
  let after: ';' | '&&' | '||' = ';';
  const tokens = lexed.tokens;
  const flush = (op: string): string | null => {
    if (command.words.length === 0 && command.redirects.length === 0) return `syntax error near \`${op}\``;
    if (command.words.length === 0) return 'a redirect needs a command';
    chain.push({ command, after });
    command = { words: [], redirects: [] };
    return null;
  };
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.kind === 'word') {
      command.words.push(token.word);
      continue;
    }
    switch (token.op) {
      case '|':
        return { ok: false, error: 'pipes (|) aren’t supported yet; use > file and < file instead' };
      case '&':
        return { ok: false, error: 'background jobs (&) aren’t supported' };
      case '2>':
        return { ok: false, error: 'only > and >> redirect output; errors always show in the terminal' };
      case '<':
      case '>':
      case '>>': {
        const next = tokens[i + 1];
        if (!next || next.kind !== 'word') return { ok: false, error: `syntax error: \`${token.op}\` needs a file name` };
        command.redirects.push({ op: token.op, target: next.word });
        i++;
        continue;
      }
      case ';':
      case '&&':
      case '||': {
        // A trailing `;` is fine; a trailing `&&` or `||` is not.
        if (token.op === ';' && command.words.length === 0 && command.redirects.length === 0 && chain.length > 0) {
          continue;
        }
        const error = flush(token.op);
        if (error) return { ok: false, error };
        after = token.op;
        if (i === tokens.length - 1 && token.op !== ';') return { ok: false, error: `syntax error: \`${token.op}\` needs a command after it` };
        continue;
      }
    }
  }
  if (command.words.length > 0 || command.redirects.length > 0) {
    const error = flush('newline');
    if (error) return { ok: false, error };
  }
  return { ok: true, chain };
}

/** A path argument against the current folder. Paths are workspace paths: '' is the root. */
export function resolvePath(cwd: string, arg: string): string {
  const segments = arg.startsWith('/') || !cwd ? [] : cwd.split('/');
  for (const segment of arg.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') segments.pop();
    else segments.push(segment);
  }
  return segments.join('/');
}

/** A glob's last segment as a RegExp (`*`, `?` and `[...]`); hidden-name rules don't apply here. */
export function globPattern(segment: string): RegExp {
  let source = '';
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i]!;
    if (ch === '*') source += '.*';
    else if (ch === '?') source += '.';
    else if (ch === '[') {
      const close = segment.indexOf(']', i + 1);
      if (close < 0) source += '\\[';
      else {
        const body = segment.slice(i + 1, close).replace(/^!/, '^').replace(/\\/g, '\\\\');
        source += `[${body}]`;
        i = close;
      }
    } else source += ch.replace(/[.+^${}()|\\]/g, '\\$&');
  }
  return new RegExp(`^${source}$`);
}

/** Quote a name for the command line if it needs it. */
export function quoteWord(name: string): string {
  return /^[A-Za-z0-9_+\-./]+$/.test(name) ? name : name.replace(/([^A-Za-z0-9_+\-./])/g, '\\$1');
}
