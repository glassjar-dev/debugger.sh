/**
 * Runs a WASI command-line tool (clang, rustc) over an in-memory filesystem.
 * The engine runs the same binaries for Run; here each request is one short
 * process, so a tiny shim is enough.
 */

import { Directory, File, OpenFile, PreopenDirectory, WASI, WASIProcExit, type Inode } from '@bjorn3/browser_wasi_shim';

export type FsRoot = Map<string, Inode>;

export function newRoot(): FsRoot {
  return new Map();
}

/** Writes `data` at absolute `path`, creating directories as needed. */
export function writeFile(root: FsRoot, path: string, data: Uint8Array | string): void {
  const parts = path.split('/').filter(Boolean);
  let dir = root;
  for (const part of parts.slice(0, -1)) {
    let next = dir.get(part);
    if (!(next instanceof Directory)) {
      next = new Directory(new Map());
      dir.set(part, next);
    }
    dir = (next as Directory).contents;
  }
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  dir.set(parts[parts.length - 1], new File(bytes));
}

export function readFile(root: FsRoot, path: string): Uint8Array | null {
  let node: Inode | undefined;
  let dir = root;
  for (const part of path.split('/').filter(Boolean)) {
    node = dir.get(part);
    if (node instanceof Directory) dir = node.contents;
  }
  return node instanceof File ? node.data : null;
}

/** Collects a stream into one buffer. */
async function collect(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

export async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'));
  return collect(stream);
}

/** Unpacks a (ustar / GNU) tar archive into `root`. `filter` can skip entries by path. */
export function untar(tar: Uint8Array, root: FsRoot, filter?: (path: string) => boolean): number {
  const decoder = new TextDecoder();
  const field = (at: number, len: number) => {
    const raw = tar.subarray(at, at + len);
    const end = raw.indexOf(0);
    return decoder.decode(end < 0 ? raw : raw.subarray(0, end));
  };
  let offset = 0;
  let count = 0;
  let longName: string | null = null;
  while (offset + 512 <= tar.length) {
    const name = field(offset, 100);
    if (!name) break;
    const size = parseInt(field(offset + 124, 12).trim() || '0', 8);
    const type = String.fromCharCode(tar[offset + 156] || 48);
    const prefix = field(offset + 345, 155);
    const body = offset + 512;
    let path = longName ?? (prefix ? `${prefix}/${name}` : name);
    longName = null;
    if (type === 'L') {
      longName = field(body, size);
    } else if (type === '0' || type === '\0' || type === '7') {
      path = '/' + path.replace(/^\.?\//, '');
      if (!filter || filter(path)) {
        writeFile(root, path, tar.slice(body, body + size));
        count++;
      }
    }
    offset = body + Math.ceil(size / 512) * 512;
  }
  return count;
}

/** Fetches a URL into memory. Toolchain URLs are immutable, so the HTTP cache usually answers. */
export async function fetchBytes(url: string): Promise<Uint8Array> {
  const response = await fetch(url, { mode: 'cors', credentials: 'omit' });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

export async function compileModule(url: string): Promise<WebAssembly.Module> {
  const response = await fetch(url, { mode: 'cors', credentials: 'omit' });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  try {
    return await WebAssembly.compileStreaming(response.clone());
  } catch {
    return WebAssembly.compile(await response.arrayBuffer());
  }
}

export type ProcessResult = { exitCode: number; stdout: string; stderr: string };

class Capture extends OpenFile {
  readonly chunks: Uint8Array[] = [];
  constructor() {
    super(new File([]));
  }
  override fd_write(data: Uint8Array) {
    this.chunks.push(data.slice());
    return { ret: 0, nwritten: data.byteLength };
  }
  text(): string {
    return new TextDecoder().decode(
      this.chunks.length === 1
        ? this.chunks[0]
        : this.chunks.reduce((acc, c) => {
            const out = new Uint8Array(acc.length + c.length);
            out.set(acc);
            out.set(c, acc.length);
            return out;
          }, new Uint8Array()),
    );
  }
}

export async function runProcess(
  module: WebAssembly.Module,
  args: string[],
  root: FsRoot,
  env: string[] = [],
): Promise<ProcessResult> {
  const stdout = new Capture();
  const stderr = new Capture();
  const fds = [new OpenFile(new File([])), stdout, stderr, new PreopenDirectory('/', root)];
  const wasi = new WASI(args, env, fds, { debug: false });
  const instance = await WebAssembly.instantiate(module, {
    wasi_snapshot_preview1: wasi.wasiImport,
  });
  let exitCode = 0;
  try {
    exitCode = wasi.start(instance as unknown as { exports: { memory: WebAssembly.Memory; _start: () => unknown } });
  } catch (error) {
    if (error instanceof WASIProcExit) exitCode = error.code;
    else throw error;
  }
  return { exitCode, stdout: stdout.text(), stderr: stderr.text() };
}
