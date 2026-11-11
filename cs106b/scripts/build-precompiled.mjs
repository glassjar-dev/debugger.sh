/**
 * Build Stanford CS106B support archives + PCH for the debugger.sh engine.
 * Mirrors web-ide-cs106b/scripts/build-precompiled.mjs for the non-graphics subset.
 *
 * Outputs:
 *   cs106b/generated/{run.a,debug.a,support.pch,EnglishWords.dat,precompiled.json,headers.ts,precompiled.ts}
 *   public/cs106b/{run.a,debug.a,support.pch,EnglishWords.dat}
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile, cp, rm, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WASI } from 'node:wasi';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const cs106bRoot = resolve(scriptDir, '..');
const appRoot = resolve(cs106bRoot, '..');
const generated = join(cs106bRoot, 'generated');
const publicOut = join(appRoot, 'public/cs106b');
const cache =
  process.env.CS106B_TOOLCHAIN_CACHE || join(appRoot, 'node_modules/.cache/cs106b-toolchain');
const guestRoot = join(cache, 'sysroot');

const compilerDigest =
  'd6b8d6e4596136fc6ae451fe3b81b1be5a1829505cbc993179247c75a764ce87';
const sysrootDigest =
  '8745c6af23fd841fa507d0c73f6b6b8e8da1b4ec216a6339739a28b38ff7227b';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function collectSources() {
  const entries = [];
  async function headers(directory, prefix = '') {
    for (const entry of (
      await readdir(join(cs106bRoot, directory), { withFileTypes: true })
    ).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = prefix + entry.name;
      if (entry.isDirectory()) await headers(`${directory}/${entry.name}`, `${name}/`);
      else if (entry.name.endsWith('.h')) {
        entries.push({
          name,
          path: `${directory}/${entry.name}`,
          compile: false,
        });
      }
    }
  }
  await headers('cpp/include');
  for (const file of (await readdir(join(cs106bRoot, 'cpp/src'))).sort()) {
    if (file.endsWith('.cpp')) {
      entries.push({
        name: `support_${file}`,
        path: `cpp/src/${file}`,
        compile: true,
      });
    }
  }
  return entries;
}

// Resolve the installed debugger-sh package root (…/node_modules/debugger-sh).
// Prefer the main export path — `./package.json` is not in the package exports map.
const require = createRequire(import.meta.url);
const engineRoot = dirname(dirname(require.resolve('debugger-sh')));

const exceptions = await readFile(join(engineRoot, 'assets/cpp-exceptions/runtime.tar.gz'));
const sources = await Promise.all(
  (await collectSources()).map(async (entry) => ({
    ...entry,
    bytes: await readFile(join(cs106bRoot, entry.path)),
  })),
);

// SimpleTest.h / SimpleTest.cpp are collected with the other library sources.
// The prelude includes SimpleTest so test macros reuse PCH'd STL headers.
// Avoid dumping every collection header into the PCH — larger PCHs slow validation.
// SimpleTest_runner.cpp is not in cpp/src: it defines main and is spliced into
// the student translation unit instead of being archived.
const preludeHeaders = ['error.h', 'vector.h', 'map.h', 'set.h', 'strlib.h', 'simpio.h'];
const prelude =
  preludeHeaders.map((name) => `#include "${name}"`).join('\n') +
  '\n#include <iostream>\n#include "SimpleTest.h"\n';

const flags = [
  '-cc1',
  '-triple',
  'wasm32-wasip1',
  '-Werror',
  '-disable-free',
  '-isysroot',
  '/',
  '-internal-isystem',
  '/include/c++/v1',
  '-internal-isystem',
  '/include',
  '-internal-isystem',
  '/include/wasm32-wasip1',
  '-std=c++23',
  '-fexceptions',
  '-fcxx-exceptions',
  '-exception-model=wasm',
  '-target-feature',
  '+exception-handling',
  '-mllvm',
  '-wasm-enable-eh',
  '-mllvm',
  '-wasm-use-legacy-eh=true',
];

const dictionary = await readFile(join(cs106bRoot, 'resources/EnglishWords.dat'));
const identity = {
  compilerDigest,
  sysrootDigest,
  exceptionsDigest: hash(exceptions),
  flags,
  recipeDigest: hash(await readFile(fileURLToPath(import.meta.url))),
  sources: Object.fromEntries(sources.map((s) => [s.name, hash(s.bytes)])),
  dictionaryDigest: hash(dictionary),
  prelude,
};
const buildDigest = hash(JSON.stringify(identity));

await mkdir(generated, { recursive: true });
await mkdir(publicOut, { recursive: true });

const existing = await readFile(join(generated, 'precompiled.json'), 'utf8')
  .then(JSON.parse)
  .catch(() => undefined);

const artifactsFresh =
  existing?.buildDigest === buildDigest &&
  (
    await Promise.all(
      Object.keys(existing.files).map(async (name) =>
        hash(await readFile(join(generated, name)).catch(() => Buffer.alloc(0))) ===
        existing.files[name],
      ),
    )
  ).every(Boolean);

if (artifactsFresh) {
  console.log('CS106B precompiled artifacts unchanged');
} else {
  console.log('Building CS106B precompiled artifacts…');
  await rm(guestRoot, { recursive: true, force: true });
  await mkdir(guestRoot, { recursive: true });
  await mkdir(cache, { recursive: true });

  async function asset(name, expected) {
    const path = join(cache, name);
    let bytes = await readFile(path).catch(() => undefined);
    if (!bytes || hash(bytes) !== expected) {
      console.log(`  fetching ${name}…`);
      const release = name === 'llvm.core.wasm' ? '2026-11-10-fast' : '2026-05-22';
      const response = await fetch(`https://cdn.yousefabuhashem.com/clang/${release}/${name}`);
      if (!response.ok) throw new Error(`Cannot fetch ${name}: ${response.status}`);
      bytes = Buffer.from(await response.arrayBuffer());
      if (hash(bytes) !== expected) throw new Error(`Toolchain digest mismatch: ${name}`);
      await writeFile(path, bytes);
    }
    return bytes;
  }

  const compilerBytes = await asset('llvm.core.wasm', compilerDigest);
  await asset('llvm-resources.tar.gz', sysrootDigest);
  execFileSync('tar', ['-xzf', join(cache, 'llvm-resources.tar.gz'), '-C', guestRoot]);
  const exceptionPath = join(cache, 'exceptions.tar.gz');
  await writeFile(exceptionPath, exceptions);
  execFileSync('tar', ['-xzf', exceptionPath, '-C', guestRoot]);

  for (const source of sources) {
    await mkdir(dirname(join(guestRoot, source.name)), { recursive: true });
    await writeFile(join(guestRoot, source.name), source.bytes);
  }
  await writeFile(join(guestRoot, 'cs106b-prelude.h'), prelude);

  const compilerModule = await WebAssembly.compile(compilerBytes);
  async function invoke(args) {
    const wasi = new WASI({
      version: 'preview1',
      args,
      env: {},
      preopens: { '/': guestRoot },
      returnOnExit: true,
    });
    const instance = await WebAssembly.instantiate(compilerModule, wasi.getImportObject());
    const code = wasi.start(instance);
    if (code) throw new Error(`C++ artifact build failed (${code}): ${args.join(' ')}`);
  }

  await invoke([
    'clang',
    ...flags,
    '-emit-pch',
    '-fno-pch-timestamp',
    '-fvalidate-ast-input-files-content',
    '-x',
    'c++-header',
    '-o',
    '/support.pch',
    '/cs106b-prelude.h',
  ]);
  const pch = await readFile(join(guestRoot, 'support.pch'));
  await writeFile(join(generated, 'support.pch'), pch);
  await writeFile(join(generated, 'EnglishWords.dat'), dictionary);

  const files = {
    'support.pch': hash(pch),
    'EnglishWords.dat': hash(dictionary),
  };

  for (const mode of ['run', 'debug']) {
    console.log(`  compiling ${mode}.a…`);
    const options = [
      ...flags,
      ...(mode === 'debug'
        ? ['-O0', '-debug-info-kind=standalone', '-dwarf-version=5']
        : []),
    ];
    const objects = [];
    for (const source of sources.filter((s) => s.compile)) {
      const object = '/' + source.name + '.o';
      await invoke(['clang', ...options, '-emit-obj', '-x', 'c++', '-o', object, '/' + source.name]);
      objects.push(object);
    }
    await invoke(['llvm-ar', 'rcs', '/' + mode + '.a', ...objects]);
    const name = mode + '.a';
    const bytes = await readFile(join(guestRoot, name));
    await writeFile(join(generated, name), bytes);
    files[name] = hash(bytes);
  }

  await writeFile(
    join(generated, 'precompiled.json'),
    JSON.stringify({ buildDigest, ...identity, files }, null, 2),
  );
}

const { files } = JSON.parse(await readFile(join(generated, 'precompiled.json'), 'utf8'));

// Emit header map for the IDE to mount into engine.fs (needed for includes + PCH validation).
const headerMap = Object.fromEntries(
  sources.filter((s) => !s.compile).map((s) => [s.name, s.bytes.toString('utf8')]),
);
headerMap['cs106b-prelude.h'] = prelude;

await writeFile(
  join(generated, 'headers.ts'),
  `/* Generated by cs106b/scripts/build-precompiled.mjs — do not edit. */\n` +
    `export const stanfordHeaders: Record<string, string> = ${JSON.stringify(headerMap)};\n` +
    `export const stanfordPrelude = ${JSON.stringify(prelude)};\n`,
);

await writeFile(
  join(generated, 'precompiled.ts'),
  `/* Generated by cs106b/scripts/build-precompiled.mjs — do not edit. */\n` +
    `export const artifactHashes = ${JSON.stringify(files)} as const;\n` +
    `export const stanfordPrelude = ${JSON.stringify(prelude)};\n`,
);

for (const name of Object.keys(files)) {
  await cp(join(generated, name), join(publicOut, name));
}

// The runner is spliced into the student file at run time. The header and
// implementation travel with the other CS106B sources, so they are not embedded.
const runnerSource = await readFile(join(cs106bRoot, 'cpp/SimpleTest_runner.cpp'), 'utf8');
await writeFile(
  join(generated, 'simpleTestRunner.ts'),
  `/* Generated by cs106b/scripts/build-precompiled.mjs from cpp/SimpleTest_runner.cpp — do not edit. */\n` +
    `export const simpleTestRunner = ${JSON.stringify(runnerSource)};\n`,
);

console.log('CS106B artifacts ready:', Object.keys(files).join(', '));
