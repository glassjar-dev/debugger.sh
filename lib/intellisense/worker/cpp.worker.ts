/// <reference lib="webworker" />
/**
 * C++ language worker: the engine's clang + the Stanford PCH, in memory.
 */

import { stanfordHeaders } from '@/cs106b/generated/headers';
import { CLANG_SYSROOT_URL, CLANG_WASM_URL } from '../toolchains';
import type { Position } from '../types';
import { ClangService, PCH } from './clangService';
import { postStatus, serve } from './host';
import { compileModule, fetchBytes, gunzip, newRoot, removeFile, untar, writeFile, type FsRoot } from './wasi';

let service: ClangService;
let root: FsRoot;
/** Workspace files written into the root, so deleted ones can be removed. */
let written = new Set<string>();
let active = 'main.cpp';

const ready = (async () => {
  postStatus({ state: 'loading', detail: 'Loading clang' });
  const started = performance.now();
  root = newRoot();
  const [module, sysroot, pch] = await Promise.all([
    compileModule(CLANG_WASM_URL),
    fetchBytes(CLANG_SYSROOT_URL).then(gunzip),
    fetchBytes('/cs106b/support.pch'),
  ]);
  untar(sysroot, root, (path) => path.startsWith('/include/'));
  for (const [name, source] of Object.entries(stanfordHeaders)) writeFile(root, `/${name}`, source);
  writeFile(root, PCH, pch);
  service = new ClangService(module, root, stanfordHeaders);
  postStatus({ state: 'ready', detail: `clang ready in ${Math.round(performance.now() - started)} ms` });
})();
ready.catch((error: unknown) => postStatus({ state: 'error', detail: String(error) }));

type At = { text: string; pos: Position };

serve({
  ready,
  diagnose: (text) => service.diagnose(text),
  setActive(path) {
    active = path;
    service.setActive(path);
  },
  // The file being edited is written by each request; the rest sit beside it for #include.
  setFiles(files) {
    for (const path of written) if (!Object.hasOwn(files, path)) removeFile(root, `/${path}`);
    written = new Set(Object.keys(files));
    for (const [path, text] of Object.entries(files)) if (path !== active) writeFile(root, `/${path}`, text);
  },
  handlers: {
    complete: ({ text, pos }: At) => service.complete(text, pos),
    hover: ({ text, pos }: At) => service.hover(text, pos),
    signature: ({ text, pos }: At) => service.signature(text, pos),
    definition: ({ text, pos }: At) => service.definition(text, pos),
  },
});
