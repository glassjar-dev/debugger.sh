/**
 * The terminal's shell. It runs command lines against the language's workspace: the
 * built-ins (`ls`, `cd`, `cat`, `mv`...) edit the workspace's files directly, and the
 * language commands (`python`, `g++`, `./app`, `rustc`, `cargo`, `run`) become jobs the
 * host runs in the engine.
 *
 * Compiling is real (errors come from the compiler), but there are no binary files: a
 * built program is a record of the sources it was built from, run again by `./name`.
 *
 * Pure (no DOM or React), so it can be tested on its own.
 */

import { LANGS, type Lang } from '@/components/constants';
import {
  createFile,
  createFolder,
  deletePath,
  entryFile,
  folders,
  isFolder,
  LOCAL_LIMITS,
  renamePath,
  type Workspace,
  writeFile,
} from '@/lib/workspace/model';
import { basename, dirname, extname, isWithin, joinPath, normalizePath } from '@/lib/workspace/paths';

import type { Completion } from './lineEditor';
import { globPattern, parse, quoteWord, resolvePath, type Command, type Word } from './parse';

/** A program run (or build) the host does in the engine. */
export type ShellJob = {
  /** Files the program sees, by workspace path. */
  files: Record<string, string>;
  /** Build without running. */
  build?: boolean;
  args: string[];
  /** Absolute folder the program starts in. */
  cwd: string;
  /** Python script or Rust crate root, absolute; the language's entry file when unset. */
  entry?: string;
  /** Input, from `< file`. The program sees end-of-file after it. */
  stdin?: string;
  /** Collect stdout instead of showing it, for `> file`. */
  capture?: boolean;
  /** The Run button's run: debugger, tests and timing, as before the shell. */
  project?: boolean;
};

export type ShellJobResult = {
  exitCode: number;
  /** Stopped with Ctrl+C or the Stop button. */
  stopped?: boolean;
  stdout?: string;
  /** Files the program wrote or removed, by absolute path. */
  files?: { written: Record<string, Uint8Array>; removed: string[]; truncated: boolean };
};

export type ShellHost = {
  lang: () => Lang;
  workspace: () => Workspace;
  setWorkspace: (ws: Workspace) => void;
  /** Shows text in the terminal (`\n` line endings). */
  write: (text: string) => void;
  clear: () => void;
  columns: () => number;
  run: (job: ShellJob) => Promise<ShellJobResult>;
  /** Opens a file in the editor; false if it couldn't. */
  open?: (path: string) => boolean;
};

/** A program built by `g++` or `rustc`: its code as it was then. */
type Binary = { code: Record<string, string>; entry?: string };

type Output = { write: (text: string) => void; tty: boolean };
type Io = { out: Output; err: (text: string) => void; stdin?: string };
type Entry = { name: string; kind: 'file' | 'folder' | 'binary' };

const BUILTINS = [
  'cat', 'cd', 'clear', 'cp', 'echo', 'exit', 'help', 'history', 'ls', 'mkdir', 'mv', 'open', 'pwd', 'rm', 'run', 'touch',
] as const;
const CPP = ['g++', 'c++', 'clang++', 'gcc', 'cc', 'clang'];
const PYTHON = ['python', 'python3'];
const LANG_COMMANDS: Record<Lang, string[]> = { c: CPP, python: PYTHON, rust: ['rustc', 'cargo'] };
const CPP_CODE = new Set(['c', 'cc', 'cp', 'cpp', 'cxx', 'c++', 'h', 'hh', 'hpp', 'hxx', 'inl', 'ipp', 'tpp']);
const UTF8 = new TextDecoder('utf-8', { fatal: true });

const dim = (text: string) => `\x1b[2m${text}\x1b[0m`;

function isCode(lang: Lang, path: string): boolean {
  const ext = extname(path);
  if (lang === 'c') return CPP_CODE.has(ext);
  if (lang === 'rust') return ext === 'rs';
  return ext === 'py';
}

function isCppSource(path: string): boolean {
  return ['c', 'cc', 'cp', 'cpp', 'cxx', 'c++'].includes(extname(path));
}

const display = (path: string) => `/${path}`;

export class Shell {
  readonly history: string[] = [];
  private cwds: Record<Lang, string> = { c: '', python: '', rust: '' };
  private previous: Record<Lang, string> = { c: '', python: '', rust: '' };
  private binaries: Record<Lang, Map<string, Binary>> = { c: new Map(), python: new Map(), rust: new Map() };
  private lastExit = 0;
  private stopped = false;
  private readonly host: ShellHost;

  constructor(host: ShellHost) {
    this.host = host;
  }

  private get lang(): Lang {
    return this.host.lang();
  }

  private get ws(): Workspace {
    return this.host.workspace();
  }

  /** The current folder ('' is the root), falling back to the root if it was removed. */
  get cwd(): string {
    const cwd = this.cwds[this.lang];
    if (cwd && !isFolder(this.ws, cwd)) this.cwds[this.lang] = '';
    return this.cwds[this.lang];
  }

  get exitCode(): number {
    return this.lastExit;
  }

  /** Mark the last command as interrupted (Ctrl+C at the prompt). */
  interrupted() {
    this.lastExit = 130;
  }

  prompt(): string {
    const mark = this.lastExit === 0 ? '\x1b[32m$\x1b[0m' : '\x1b[31m$\x1b[0m';
    return `\x1b[1;34m${display(this.cwd)}\x1b[0m ${mark} `;
  }

  /** Run one command line. Resolves when it (and every program it started) is done. */
  async execute(line: string): Promise<number> {
    const parsed = parse(line);
    if (!parsed.ok) {
      this.host.write(`glassjar: ${parsed.error}\n`);
      return (this.lastExit = 2);
    }
    this.stopped = false;
    for (const { command, after } of parsed.chain) {
      if (this.stopped) break;
      if (after === '&&' && this.lastExit !== 0) continue;
      if (after === '||' && this.lastExit === 0) continue;
      try {
        this.lastExit = await this.command(command);
      } catch (error) {
        this.host.write(`glassjar: ${error instanceof Error ? error.message : String(error)}\n`);
        this.lastExit = 1;
      }
    }
    return this.lastExit;
  }

  /** Run the project the way the Run button does. */
  run(): Promise<number> {
    return this.execute('run');
  }

  // -------------------------------------------------------------------------
  // One command: redirects, then a built-in or a program
  // -------------------------------------------------------------------------

  private async command(command: Command): Promise<number> {
    const argv = this.expand(command.words);
    const name = argv[0]!;
    const terminal: Output = { write: (t) => this.host.write(t), tty: true };
    const err = (text: string) => this.host.write(text);

    let stdin: string | undefined;
    let target: { path: string; append: boolean } | null = null;
    for (const { op, target: word } of command.redirects) {
      const path = this.path(word.text);
      if (op === '<') {
        const text = this.ws.files[path];
        if (text === undefined) {
          err(`glassjar: ${word.text}: ${isFolder(this.ws, path) || !path ? 'Is a directory' : 'No such file or directory'}\n`);
          return 1;
        }
        stdin = text;
      } else {
        const problem = this.writable(path);
        if (problem) {
          err(`glassjar: ${word.text}: ${problem}\n`);
          return 1;
        }
        target = { path, append: op === '>>' };
      }
    }

    let captured = '';
    const out: Output = target ? { write: (t) => void (captured += t), tty: false } : terminal;
    const io: Io = { out, err, stdin };
    let code: number;
    const program = this.program(name, argv.slice(1), io, !!target);
    if (program) {
      const result = await program;
      code = result.code;
      captured += result.stdout ?? '';
    } else {
      code = this.builtin(name, argv.slice(1), io);
    }
    if (target) {
      const before = target.append ? (this.ws.files[target.path] ?? '') : '';
      const problem = this.save(target.path, before + captured);
      if (problem) {
        err(`glassjar: ${display(target.path)}: ${problem}\n`);
        return 1;
      }
    }
    return code;
  }

  /** Arguments with globs expanded against the workspace (unmatched globs stay as typed). */
  private expand(words: Word[]): string[] {
    const out: string[] = [];
    for (const word of words) {
      if (!word.glob) {
        out.push(word.text);
        continue;
      }
      const slash = word.text.lastIndexOf('/');
      const prefix = slash < 0 ? '' : word.text.slice(0, slash + 1);
      const pattern = globPattern(word.text.slice(slash + 1));
      const dir = this.path(prefix || '.');
      const matches = this.entries(dir)
        .map((e) => e.name)
        .filter((n) => pattern.test(n))
        .sort();
      if (matches.length) out.push(...matches.map((n) => prefix + n));
      else out.push(word.text);
    }
    return out;
  }

  private builtin(name: string, args: string[], io: Io): number {
    switch (name) {
      case 'cd':
        return this.cd(args, io);
      case 'pwd':
        io.out.write(`${display(this.cwd)}\n`);
        return 0;
      case 'ls':
        return this.ls(args, io);
      case 'cat':
        return this.cat(args, io);
      case 'echo': {
        const newline = args[0] !== '-n';
        io.out.write(args.slice(newline ? 0 : 1).join(' ') + (newline ? '\n' : ''));
        return 0;
      }
      case 'mkdir':
        return this.mkdir(args, io);
      case 'touch':
        return this.touch(args, io);
      case 'rm':
        return this.rm(args, io);
      case 'mv':
        return this.mvOrCp('mv', args, io);
      case 'cp':
        return this.mvOrCp('cp', args, io);
      case 'clear':
        this.host.clear();
        return 0;
      case 'history':
        this.history.forEach((line, i) => io.out.write(`${String(i + 1).padStart(5)}  ${line}\n`));
        return 0;
      case 'help':
        io.out.write(this.help());
        return 0;
      case 'open':
      case 'code':
        return this.open(name, args, io);
      case 'exit':
      case 'logout':
        io.err('This terminal stays open; hide it from the panel’s header.\n');
        return 0;
    }
    const binary = this.binaries[this.lang].has(this.path(name)) && !name.includes('/');
    io.err(`${name}: command not found${binary ? ` (to run your program, type ./${name})` : ''}\n`);
    if (!binary && !this.known(name)) io.err(dim(`Type help to see what works here.\n`));
    return 127;
  }

  private known(name: string): boolean {
    return Object.values(LANG_COMMANDS).flat().includes(name);
  }

  // -------------------------------------------------------------------------
  // Files and folders
  // -------------------------------------------------------------------------

  /** A workspace path for an argument, against the current folder. */
  private path(arg: string): string {
    return resolvePath(this.cwd, arg);
  }

  private entries(dir: string): Entry[] {
    const ws = this.ws;
    const out: Entry[] = [];
    for (const folder of folders(ws)) if (folder && dirname(folder) === dir) out.push({ name: basename(folder), kind: 'folder' });
    for (const path of Object.keys(ws.files)) if (dirname(path) === dir) out.push({ name: basename(path), kind: 'file' });
    for (const path of this.binaries[this.lang].keys()) {
      if (dirname(path) === dir && !(path in ws.files)) out.push({ name: basename(path), kind: 'binary' });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  }

  private kind(path: string): Entry['kind'] | null {
    if (!path || isFolder(this.ws, path)) return 'folder';
    if (Object.hasOwn(this.ws.files, path)) return 'file';
    if (this.binaries[this.lang].has(path)) return 'binary';
    return null;
  }

  /** Why `path` can't be written as a file, or null. */
  private writable(path: string): string | null {
    if (!path || isFolder(this.ws, path)) return 'Is a directory';
    if (!normalizePath(path)) return 'Names can use letters, numbers, dots, dashes and underscores';
    const parent = dirname(path);
    if (parent && !isFolder(this.ws, parent)) return 'No such file or directory';
    return null;
  }

  /** Write a text file, creating it if needed. Returns a problem, or null. */
  private save(path: string, text: string): string | null {
    const ws = this.ws;
    if (text.length > LOCAL_LIMITS.chars) return `too big to keep (over ${LOCAL_LIMITS.chars.toLocaleString()} characters)`;
    if (Object.hasOwn(ws.files, path)) {
      this.host.setWorkspace(writeFile(ws, path, text));
      return null;
    }
    const created = createFile(ws, path, text);
    if (!created.ok) return created.error;
    this.binaries[this.lang].delete(path);
    this.host.setWorkspace(created.ws);
    return null;
  }

  private flags(args: string[], allowed: string): { flags: Set<string>; rest: string[]; bad?: string } {
    const flags = new Set<string>();
    const rest: string[] = [];
    let done = false;
    for (const arg of args) {
      if (!done && arg === '--') done = true;
      else if (!done && arg.startsWith('-') && arg.length > 1) {
        for (const f of arg.slice(1)) {
          if (!allowed.includes(f)) return { flags, rest, bad: f };
          flags.add(f);
        }
      } else rest.push(arg);
    }
    return { flags, rest };
  }

  private cd(args: string[], io: Io): number {
    const lang = this.lang;
    const arg = args[0] ?? '/';
    const path = arg === '-' ? this.previous[lang] : this.path(arg);
    const kind = this.kind(path);
    if (kind !== 'folder') {
      io.err(`cd: ${arg}: ${kind ? 'Not a directory' : 'No such file or directory'}\n`);
      return 1;
    }
    this.previous[lang] = this.cwd;
    this.cwds[lang] = path;
    if (arg === '-') io.out.write(`${display(path)}\n`);
    return 0;
  }

  private ls(args: string[], io: Io): number {
    const { flags, rest, bad } = this.flags(args, 'la1AF');
    if (bad) {
      io.err(`ls: -${bad} isn’t supported here (try ls, ls -l or ls -1)\n`);
      return 2;
    }
    const long = flags.has('l');
    const oneColumn = flags.has('1') || !io.out.tty;
    const targets = rest.length ? rest : ['.'];
    let code = 0;
    const files: Entry[] = [];
    const dirs: { arg: string; path: string }[] = [];
    for (const arg of targets) {
      const path = this.path(arg);
      const kind = this.kind(path);
      if (!kind) {
        io.err(`ls: ${arg}: No such file or directory\n`);
        code = 1;
      } else if (kind === 'folder') dirs.push({ arg, path });
      else files.push({ name: arg, kind });
    }
    const show = (entries: Entry[], dir: string) => {
      if (long) {
        for (const e of entries) io.out.write(`${this.longLine(e, joinPath(dir, e.name))}\n`);
      } else if (oneColumn) {
        for (const e of entries) io.out.write(`${e.name}\n`);
      } else {
        io.out.write(this.columns(entries));
      }
    };
    if (files.length) show(files, '');
    dirs.forEach(({ arg, path }, i) => {
      if (targets.length > 1) io.out.write(`${files.length || i ? '\n' : ''}${arg}:\n`);
      show(this.entries(path), path);
    });
    return code;
  }

  private paint(e: Entry): string {
    if (e.kind === 'folder') return `\x1b[1;34m${e.name}\x1b[0m/`;
    if (e.kind === 'binary') return `\x1b[1;32m${e.name}\x1b[0m*`;
    return e.name;
  }

  private longLine(e: Entry, path: string): string {
    const size =
      e.kind === 'file' ? new TextEncoder().encode(this.ws.files[path] ?? '').length : e.kind === 'folder' ? 0 : null;
    const type = e.kind === 'folder' ? 'd' : e.kind === 'binary' ? 'x' : '-';
    return `${type} ${size === null ? '       -' : String(size).padStart(8)}  ${this.paint(e)}`;
  }

  /** Names in columns, filled down then across, like `ls`. */
  private columns(entries: Entry[]): string {
    if (!entries.length) return '';
    const widths = entries.map((e) => e.name.length + (e.kind === 'file' ? 0 : 1));
    const width = Math.max(...widths) + 2;
    const perRow = Math.max(1, Math.floor(Math.max(this.host.columns(), width) / width));
    const rows = Math.ceil(entries.length / perRow);
    let out = '';
    for (let r = 0; r < rows; r++) {
      let line = '';
      for (let c = 0; c < perRow; c++) {
        const i = c * rows + r;
        if (i >= entries.length) break;
        const last = (c + 1) * rows + r >= entries.length;
        line += this.paint(entries[i]!) + (last ? '' : ' '.repeat(width - widths[i]!));
      }
      out += `${line}\n`;
    }
    return out;
  }

  private cat(args: string[], io: Io): number {
    if (!args.length) {
      if (io.stdin !== undefined) {
        io.out.write(io.stdin);
        return 0;
      }
      io.err('cat: give it a file to show, like cat main.py\n');
      return 1;
    }
    let code = 0;
    for (const arg of args) {
      const path = this.path(arg);
      const kind = this.kind(path);
      if (kind === 'file') io.out.write(this.ws.files[path]!);
      else {
        io.err(`cat: ${arg}: ${kind === 'folder' ? 'Is a directory' : kind === 'binary' ? 'a built program, not text (run it with ./' + basename(path) + ')' : 'No such file or directory'}\n`);
        code = 1;
      }
    }
    return code;
  }

  private mkdir(args: string[], io: Io): number {
    const { flags, rest, bad } = this.flags(args, 'p');
    if (bad || !rest.length) {
      io.err(bad ? `mkdir: -${bad} isn’t supported here\n` : 'mkdir: missing folder name\n');
      return 1;
    }
    let code = 0;
    for (const arg of rest) {
      const path = this.path(arg);
      const kind = this.kind(path);
      if (kind) {
        if (kind === 'folder' && flags.has('p')) continue;
        io.err(`mkdir: ${arg}: File exists\n`);
        code = 1;
        continue;
      }
      const parent = dirname(path);
      if (parent && !flags.has('p') && this.kind(parent) !== 'folder') {
        io.err(`mkdir: ${arg}: No such file or directory (mkdir -p makes the folders above it too)\n`);
        code = 1;
        continue;
      }
      const result = createFolder(this.ws, path);
      if (!result.ok) {
        io.err(`mkdir: ${arg}: ${result.error}\n`);
        code = 1;
      } else this.host.setWorkspace(result.ws);
    }
    return code;
  }

  private touch(args: string[], io: Io): number {
    if (!args.length) {
      io.err('touch: missing file name\n');
      return 1;
    }
    let code = 0;
    for (const arg of args) {
      const path = this.path(arg);
      if (this.kind(path)) continue;
      const problem = this.writable(path) ?? this.save(path, '');
      if (problem) {
        io.err(`touch: ${arg}: ${problem}\n`);
        code = 1;
      }
    }
    return code;
  }

  private rm(args: string[], io: Io): number {
    const { flags, rest, bad } = this.flags(args, 'rRfdv');
    if (bad || !rest.length) {
      io.err(bad ? `rm: -${bad} isn’t supported here\n` : 'rm: missing file name\n');
      return 1;
    }
    const recursive = flags.has('r') || flags.has('R');
    let code = 0;
    for (const arg of rest) {
      const path = this.path(arg);
      const kind = this.kind(path);
      if (!kind) {
        if (!flags.has('f')) {
          io.err(`rm: ${arg}: No such file or directory\n`);
          code = 1;
        }
        continue;
      }
      if (!path) {
        io.err('rm: the workspace’s top folder can’t be removed\n');
        code = 1;
        continue;
      }
      if (kind === 'binary') {
        this.binaries[this.lang].delete(path);
        continue;
      }
      if (kind === 'folder' && !recursive) {
        io.err(`rm: ${arg}: is a directory (rm -r removes it and everything in it)\n`);
        code = 1;
        continue;
      }
      const result = deletePath(this.ws, path, entryFile(this.lang));
      if (!result.ok) {
        io.err(`rm: ${result.error}\n`);
        code = 1;
        continue;
      }
      this.host.setWorkspace(result.ws);
      for (const p of [...this.binaries[this.lang].keys()]) if (isWithin(p, path)) this.binaries[this.lang].delete(p);
    }
    return code;
  }

  private mvOrCp(name: 'mv' | 'cp', args: string[], io: Io): number {
    const { flags, rest, bad } = this.flags(args, name === 'cp' ? 'rRfv' : 'fv');
    if (bad) {
      io.err(`${name}: -${bad} isn’t supported here\n`);
      return 1;
    }
    if (rest.length < 2) {
      io.err(`${name}: needs a source and a destination, like ${name} a.txt b.txt\n`);
      return 1;
    }
    const sources = rest.slice(0, -1);
    const destArg = rest.at(-1)!;
    const dest = this.path(destArg);
    const intoFolder = this.kind(dest) === 'folder';
    if (sources.length > 1 && !intoFolder) {
      io.err(`${name}: ${destArg}: Not a directory\n`);
      return 1;
    }
    let code = 0;
    for (const arg of sources) {
      const from = this.path(arg);
      const to = intoFolder ? joinPath(dest, basename(from)) : dest;
      const problem = this.moveOne(name, from, to, flags.has('r') || flags.has('R'));
      if (problem) {
        io.err(`${name}: ${arg}: ${problem}\n`);
        code = 1;
      }
    }
    return code;
  }

  private moveOne(name: 'mv' | 'cp', from: string, to: string, recursive: boolean): string | null {
    const kind = this.kind(from);
    if (!kind) return 'No such file or directory';
    if (!from) return 'the workspace’s top folder stays put';
    if (from === to) return name === 'cp' ? 'it’s the same file' : null;
    const bins = this.binaries[this.lang];
    if (kind === 'binary') {
      const problem = this.kind(to) === 'folder' ? 'Is a directory' : this.writable(to);
      if (problem) return problem;
      bins.set(to, bins.get(from)!);
      if (name === 'mv') bins.delete(from);
      return null;
    }
    if (kind === 'folder' && isWithin(to, from)) return 'a folder can’t go inside itself';
    const toKind = this.kind(to);
    if (kind === 'folder' && toKind) return `${display(to)} already exists`;
    if (kind === 'file' && toKind === 'folder') return `${display(to)} is a directory`;
    if (kind === 'file' && toKind === 'file') {
      // Like mv and cp, replace the file that's there.
      if (name === 'cp') return this.save(to, this.ws.files[from]!);
      const removed = deletePath(this.ws, to, entryFile(this.lang));
      if (!removed.ok) return removed.error;
      this.host.setWorkspace(removed.ws);
    }
    const parent = dirname(to);
    if (parent && this.kind(parent) !== 'folder') return 'No such file or directory';
    if (!normalizePath(to)) return 'Names can use letters, numbers, dots, dashes and underscores';
    if (name === 'mv') {
      const moved = renamePath(this.ws, from, to, entryFile(this.lang));
      if (!moved.ok) return moved.error;
      this.host.setWorkspace(moved.ws);
      for (const [p, b] of [...bins]) {
        if (!isWithin(p, from)) continue;
        bins.delete(p);
        bins.set(to + p.slice(from.length), b);
      }
      return null;
    }
    if (kind === 'file') return this.save(to, this.ws.files[from]!);
    if (!recursive) return 'is a directory (cp -r copies it and everything in it)';
    let ws = this.ws;
    const made = createFolder(ws, to);
    if (!made.ok) return made.error;
    ws = made.ws;
    for (const dir of folders(this.ws)) {
      if (dir !== from && isWithin(dir, from)) {
        const sub = createFolder(ws, to + dir.slice(from.length));
        if (sub.ok) ws = sub.ws;
      }
    }
    for (const [p, text] of Object.entries(this.ws.files)) {
      if (!isWithin(p, from)) continue;
      const copied = createFile(ws, to + p.slice(from.length), text);
      if (!copied.ok) return copied.error;
      ws = copied.ws;
    }
    this.host.setWorkspace(ws);
    return null;
  }

  private open(name: string, args: string[], io: Io): number {
    if (!args.length) {
      io.err(`${name}: which file? like ${name} main.py\n`);
      return 1;
    }
    let code = 0;
    for (const arg of args) {
      const path = this.path(arg);
      if (this.kind(path) !== 'file') {
        io.err(`${name}: ${arg}: ${this.kind(path) ? 'only text files open in the editor' : 'No such file or directory'}\n`);
        code = 1;
      } else if (!this.host.open?.(path)) code = 1;
    }
    return code;
  }

  // -------------------------------------------------------------------------
  // Programs
  // -------------------------------------------------------------------------

  /** A language command as a running job, or null if `name` is a built-in or unknown. */
  private program(
    name: string,
    args: string[],
    io: Io,
    capture: boolean,
  ): Promise<{ code: number; stdout?: string }> | null {
    const lang = this.lang;
    const cwd = display(this.cwd);
    const base = { cwd, stdin: io.stdin, capture };
    if (name === 'run') {
      return this.job({ ...base, files: { ...this.ws.files }, args, cwd: '/', project: true }, io);
    }
    if (name.includes('/')) return this.runBinary(name, args, io, base);
    if (!this.known(name)) return null;
    if (!LANG_COMMANDS[lang].includes(name)) {
      const wants: Lang = CPP.includes(name) ? 'c' : PYTHON.includes(name) ? 'python' : 'rust';
      io.err(`${name}: this is the ${LANGS[lang].label} workspace; switch the language to ${LANGS[wants].label} to use ${name}\n`);
      return Promise.resolve({ code: 127 });
    }
    if (PYTHON.includes(name)) return this.python(name, args, io, base);
    if (CPP.includes(name)) return this.compileCpp(name, args, io);
    if (name === 'rustc') return this.rustc(args, io);
    return this.cargo(args, io, base);
  }

  private async job(job: ShellJob, io: Io): Promise<{ code: number; stdout?: string }> {
    const result = await this.host.run(job);
    if (result.stopped) this.stopped = true;
    if (result.files) this.applyFiles(result.files, io);
    return { code: result.exitCode, stdout: result.stdout };
  }

  private python(
    name: string,
    args: string[],
    io: Io,
    base: Pick<ShellJob, 'cwd' | 'stdin' | 'capture'>,
  ): Promise<{ code: number; stdout?: string }> {
    let i = 0;
    while (args[i] === '-u' || args[i] === '-B') i++;
    const script = args[i];
    if (script === '-V' || script === '--version') {
      io.out.write('Python 3 (glassjar, WebAssembly)\n');
      return Promise.resolve({ code: 0 });
    }
    if (script === undefined || script.startsWith('-')) {
      io.err(
        script
          ? `${name}: ${script} isn’t supported here; run a file, like ${name} main.py\n`
          : `${name}: the interactive prompt isn’t available yet; run a file, like ${name} main.py\n`,
      );
      return Promise.resolve({ code: 2 });
    }
    const path = this.path(script);
    if (this.kind(path) !== 'file') {
      io.err(`${name}: can't open file '${display(path)}': [Errno 2] No such file or directory\n`);
      return Promise.resolve({ code: 2 });
    }
    return this.job({ ...base, files: { ...this.ws.files }, entry: display(path), args: args.slice(i + 1) }, io);
  }

  /** `-o name` and the remaining arguments; other flags are accepted and ignored. */
  private compilerArgs(args: string[], ignored: (flag: string) => boolean) {
    let output: string | null = null;
    const inputs: string[] = [];
    let problem: string | null = null;
    for (let i = 0; i < args.length; i++) {
      const arg = args[i]!;
      if (arg === '-o') output = args[++i] ?? '';
      else if (arg.startsWith('-o') && arg.length > 2) output = arg.slice(2);
      else if (arg.startsWith('-')) {
        if (!ignored(arg)) problem ??= arg;
      } else inputs.push(arg);
    }
    return { output, inputs, problem };
  }

  private async compileCpp(name: string, args: string[], io: Io): Promise<{ code: number }> {
    const { output, inputs, problem } = this.compilerArgs(args, (f) => !['-c', '-S', '-E'].includes(f) && !f.startsWith('-l'));
    if (problem) {
      io.err(`${name}: ${problem} isn’t supported here; build in one step, like ${name} main.cpp -o app\n`);
      return { code: 1 };
    }
    if (output === '') {
      io.err(`${name}: missing filename after '-o'\n`);
      return { code: 1 };
    }
    const sources: string[] = [];
    for (const input of inputs) {
      const path = this.path(input);
      if (this.kind(path) !== 'file') {
        io.err(`${name}: error: ${input}: No such file or directory\n`);
        return { code: 1 };
      }
      if (isCppSource(path)) sources.push(path);
      else if (!isCode('c', path)) {
        io.err(`${name}: ${input}: not a C or C++ file\n`);
        return { code: 1 };
      }
    }
    if (!sources.length) {
      io.err(`${name}: fatal error: no input files\n`);
      return { code: 1 };
    }
    const out = this.path(output ?? 'a.out');
    const outProblem = this.binaryTarget(out);
    if (outProblem) {
      io.err(`${name}: ${output ?? 'a.out'}: ${outProblem}\n`);
      return { code: 1 };
    }
    // Every other source stays out of the build, as if it weren't on the command line.
    const chosen = new Set(sources);
    const files = Object.fromEntries(Object.entries(this.ws.files).filter(([p]) => !isCppSource(p) || chosen.has(p)));
    const result = await this.job({ files, build: true, args: [], cwd: '/' }, io);
    if (result.code === 0 && !this.stopped) {
      this.binaries.c.set(out, { code: Object.fromEntries(Object.entries(files).filter(([p]) => isCode('c', p))) });
    }
    return result;
  }

  private async rustc(args: string[], io: Io): Promise<{ code: number }> {
    const { output, inputs, problem } = this.compilerArgs(args, (f) => /^-(O|g|C|-edition|-crate-name)/.test(f));
    if (problem || inputs.length !== 1) {
      io.err(problem ? `rustc: ${problem} isn’t supported here\n` : 'rustc: give it one file, the crate root, like rustc main.rs\n');
      return { code: 1 };
    }
    const path = this.path(inputs[0]!);
    if (this.kind(path) !== 'file' || extname(path) !== 'rs') {
      io.err(`rustc: ${inputs[0]}: ${this.kind(path) ? 'not a Rust file' : 'No such file or directory'}\n`);
      return { code: 1 };
    }
    const out = output ? this.path(output) : joinPath(this.cwd, basename(path).replace(/\.rs$/, ''));
    const outProblem = this.binaryTarget(out);
    if (outProblem) {
      io.err(`rustc: ${output ?? display(out)}: ${outProblem}\n`);
      return { code: 1 };
    }
    const files = { ...this.ws.files };
    const result = await this.job({ files, build: true, args: [], cwd: '/', entry: display(path) }, io);
    if (result.code === 0 && !this.stopped) {
      this.binaries.rust.set(out, {
        code: Object.fromEntries(Object.entries(files).filter(([p]) => isCode('rust', p))),
        entry: display(path),
      });
    }
    return result;
  }

  private async cargo(
    args: string[],
    io: Io,
    base: Pick<ShellJob, 'cwd' | 'stdin' | 'capture'>,
  ): Promise<{ code: number; stdout?: string }> {
    const [sub, ...rest] = args;
    const entry = display(entryFile('rust'));
    const dashes = rest.indexOf('--');
    const programArgs = dashes < 0 ? [] : rest.slice(dashes + 1);
    if (sub === 'run') {
      return this.job({ ...base, files: { ...this.ws.files }, entry, args: programArgs }, io);
    }
    if (sub === 'build' || sub === 'check') {
      const result = await this.job({ files: { ...this.ws.files }, build: true, args: [], cwd: '/', entry }, io);
      if (result.code === 0 && !this.stopped) io.err(`${dim('    Finished')} build of ${entry}\n`);
      return result;
    }
    io.err('cargo: only cargo run [-- args] and cargo build work here; they build main.rs\n');
    return { code: 1 };
  }

  /** Why a built program can't be saved at `path`, or null. */
  private binaryTarget(path: string): string | null {
    const kind = this.kind(path);
    if (kind === 'folder') return 'Is a directory';
    if (kind === 'file') return 'a file with that name is in your workspace; pick another name with -o';
    const parent = dirname(path);
    if (parent && this.kind(parent) !== 'folder') return 'No such file or directory';
    if (!normalizePath(path)) return 'Names can use letters, numbers, dots, dashes and underscores';
    return null;
  }

  private runBinary(
    name: string,
    args: string[],
    io: Io,
    base: Pick<ShellJob, 'cwd' | 'stdin' | 'capture'>,
  ): Promise<{ code: number; stdout?: string }> {
    const lang = this.lang;
    const path = this.path(name);
    const binary = this.binaries[lang].get(path);
    if (!binary) {
      const kind = this.kind(path);
      const hint =
        kind === 'file' && extname(path) === 'py'
          ? ` (run it with python ${name.replace(/^\.\//, '')})`
          : kind === 'file' && isCode(lang, path)
            ? lang === 'rust'
              ? ` (build it first: rustc ${name.replace(/^\.\//, '')})`
              : ` (build it first: g++ ${name.replace(/^\.\//, '')} -o app)`
            : '';
      io.err(`glassjar: ${name}: ${kind === 'folder' ? 'Is a directory' : kind ? `Permission denied${hint}` : 'No such file or directory'}\n`);
      return Promise.resolve({ code: kind ? 126 : 127 });
    }
    // The program's code is as it was built; everything else (data files) is current.
    const data = Object.fromEntries(Object.entries(this.ws.files).filter(([p]) => !isCode(lang, p)));
    return this.job({ ...base, files: { ...data, ...binary.code }, entry: binary.entry, args }, io);
  }

  /** Keep the text files a program wrote; say what was left out. */
  private applyFiles(files: NonNullable<ShellJobResult['files']>, io: Io) {
    const skipped: string[] = [];
    for (const [abs, bytes] of Object.entries(files.written)) {
      const path = normalizePath(abs);
      let text: string | null = null;
      try {
        text = UTF8.decode(bytes);
      } catch {
        text = null;
      }
      if (!path || text === null || text.includes('\0')) {
        skipped.push(`${abs} (${path ? 'not text' : 'name not allowed in the workspace'})`);
        continue;
      }
      const problem = this.kind(path) === 'folder' ? 'Is a directory' : this.save(path, text);
      if (problem) skipped.push(`${abs} (${problem})`);
    }
    const entry = entryFile(this.lang);
    for (const abs of files.removed) {
      const path = normalizePath(abs);
      if (!path || this.kind(path) !== 'file' || path === entry) continue;
      const result = deletePath(this.ws, path, entry);
      if (result.ok) this.host.setWorkspace(result.ws);
    }
    if (skipped.length) io.err(dim(`Not kept in your workspace: ${skipped.join(', ')}\n`));
    if (files.truncated) io.err(dim('Some files the program wrote were too big to keep.\n'));
  }

  // -------------------------------------------------------------------------
  // Help and completion
  // -------------------------------------------------------------------------

  help(): string {
    const lang = this.lang;
    const entry = entryFile(lang);
    const rows: [string, string][] = [[`run [args]`, `run ${entry}, like the Run button`]];
    if (lang === 'python') rows.push(['python file.py [args]', 'run a Python file']);
    if (lang === 'c') rows.push(['g++ *.cpp -o app', 'compile; then ./app [args] runs it']);
    if (lang === 'rust') {
      rows.push(['rustc main.rs', 'compile; then ./main [args] runs it']);
      rows.push(['cargo run [-- args]', `build and run ${entry}`]);
    }
    const table = (r: [string, string][]) => r.map(([a, b]) => `  ${a.padEnd(24)}${dim(b)}\n`).join('');
    return (
      `\x1b[1mglassjar shell\x1b[0m ${dim(`· your ${LANGS[lang].label} workspace`)}\n\n` +
      table(rows) +
      '\n  ls  cd  pwd  cat  echo  mkdir  touch  rm  mv  cp  open  clear  history\n\n' +
      table([
        ['a && b', 'run b if a worked (a ; b runs both)'],
        ['< in.txt', 'read input from a file'],
        ['> out.txt', 'write output to a file (>> adds to it)'],
      ]) +
      `\n  ${dim('↑ ↓ history · Tab completes · Ctrl+C stops · Ctrl+D ends input · Ctrl+L clears')}\n`
    );
  }

  /** Tab completion for the text before the cursor. */
  complete(before: string): Completion {
    const match = /(?:^|[\s;&|<>])((?:\\.|[^\s;&|<>\\])*)$/.exec(before);
    const typed = (match?.[1] ?? '').replace(/\\(.)/g, '$1');
    const head = before.slice(0, before.length - (match?.[1]?.length ?? 0));
    const firstWord = /(^|[;&|])\s*$/.test(head);
    let candidates: { name: string; suffix: string }[];
    let prefix = typed;
    if (firstWord && !typed.includes('/')) {
      const names = [...BUILTINS, ...LANG_COMMANDS[this.lang]];
      candidates = names.map((n) => ({ name: n, suffix: ' ' }));
    } else {
      const slash = typed.lastIndexOf('/');
      const dirArg = slash < 0 ? '.' : typed.slice(0, slash + 1);
      prefix = typed.slice(slash + 1);
      const dir = this.path(dirArg);
      if (this.kind(dir) !== 'folder') return { insert: '', options: [] };
      candidates = this.entries(dir)
        .filter((e) => !firstWord || e.kind !== 'file')
        .map((e) => ({ name: e.name, suffix: e.kind === 'folder' ? '/' : ' ' }));
    }
    const hits = candidates.filter((c) => c.name.startsWith(prefix));
    if (hits.length === 0) return { insert: '', options: [] };
    if (hits.length === 1) {
      const hit = hits[0]!;
      return { insert: quoteWord(hit.name.slice(prefix.length)) + hit.suffix, options: [] };
    }
    let common = hits[0]!.name;
    for (const h of hits) while (!h.name.startsWith(common)) common = common.slice(0, -1);
    if (common.length > prefix.length) return { insert: quoteWord(common.slice(prefix.length)), options: [] };
    return { insert: '', options: hits.map((h) => h.name + (h.suffix === '/' ? '/' : '')) };
  }
}
