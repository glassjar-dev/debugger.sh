/**
 * Headless Playwright smoke: compile+run Stanford Vector + SimpleTest via the forked engine.
 * Requires: built ../engine, built CS106B artifacts, PLAYWRIGHT_MODULE or playwright installed.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const engineDist = join(root, 'node_modules/debugger-sh/dist');
const engineJs = await readFile(join(engineDist, 'glassjar.js'));
const engineWasm = await readFile(join(engineDist, 'engine_bg.wasm'));
const debugA = await readFile(join(root, 'public/cs106b/debug.a'));
const pch = await readFile(join(root, 'public/cs106b/support.pch'));
const dictionary = await readFile(join(root, 'public/cs106b/EnglishWords.dat'));
const { stanfordHeaders } = await import(pathToFileURL(join(root, 'cs106b/generated/headers.ts')).href);
const { simpleTestRunner } = await import(
  pathToFileURL(join(root, 'cs106b/generated/simpleTestRunner.ts')).href
);

const nonce = 'a'.repeat(32);
const student = `#include "SimpleTest.h"
#include "vector.h"
#include <iostream>

PROVIDED_TEST("Vector size") {
  Vector<int> v;
  v.add(3);
  EXPECT_EQUAL(v.size(), 1);
  EXPECT_EQUAL(v[0], 3);
}

int main() {
  Vector<int> v;
  v.add(1);
  std::cout << "main_ran:" << v.size() << std::endl;
  return 0;
}
`;

// Minimal prepare: rename main, inject keys (single test hardcoded for smoke).
const preparedStudent = student
  .replace('PROVIDED_TEST("Vector size")', 'SIMPLETEST_KEY("bbbbbbbbbbbbbbbb","Vector size","provided")')
  .replace(/int main\(\)/, 'int original_main(int argc, char** argv)');

const config = `#define SIMPLETEST_NONCE "${nonce}"
#define SIMPLETEST_ALL true
#define SIMPLETEST_SELECTION std::vector<std::string>{}
#define DEBUGGER_HAS_USER_MAIN 1
`;

const runnerBody = simpleTestRunner.replace(/^#include\s+"SimpleTest(?:_config)?\.h"\s*\n/gm, '');

function buildFs() {
  const files = {
    ...stanfordHeaders,
    'main.c': [
      '#include "SimpleTest.h"',
      '#line 1 "/main.c"',
      preparedStudent,
      '#include "SimpleTest_config.h"',
      runnerBody,
    ].join('\n'),
    'SimpleTest_config.h': config,
  };
  const rootFs = {};
  for (const [path, content] of Object.entries(files)) {
    const parts = path.split('/');
    let dir = rootFs;
    for (const part of parts.slice(0, -1)) {
      dir[part] ??= {};
      dir = dir[part];
    }
    dir[parts.at(-1)] = content;
  }
  return rootFs;
}

const html = `<script type="module">
import { Engine } from '/engine.js';
window.probe = {
  async run() {
    this.stdout = '';
    this.stderr = '';
    const engine = await Engine.create('c', { wasmUrl: '/engine_bg.wasm' });
    const dec = new TextDecoder();
    engine.stdout.on('data', b => this.stdout += dec.decode(b));
    engine.stderr.on('data', b => this.stderr += dec.decode(b));
    engine.fs = ${JSON.stringify(buildFs())};
    engine.binaryFiles = {
      '/__cs106b/debug.a': new Uint8Array(await (await fetch('/debug.a')).arrayBuffer()),
      '/__cs106b/support.pch': new Uint8Array(await (await fetch('/support.pch')).arrayBuffer()),
      '/__cs106b/EnglishWords.dat': new Uint8Array(await (await fetch('/EnglishWords.dat')).arrayBuffer()),
    };
    engine.cppArtifacts = {
      sources: ['/main.c'],
      archives: ['/__cs106b/debug.a'],
      precompiledHeader: '/__cs106b/support.pch',
    };
    engine.debugger.enabled = false;
    this.result = await engine.run();
    return { result: this.result, stdout: this.stdout, stderr: this.stderr };
  }
};
</script>`;

const playwrightPath =
  process.env.PLAYWRIGHT_MODULE ||
  join(root, 'node_modules/playwright/index.mjs');
let chromium;
try {
  ({ chromium } = await import(pathToFileURL(playwrightPath).href));
} catch {
  // Fall back to engine sibling / web-ide playwright if present.
  const candidates = [
    join(root, '../web-ide/node_modules/playwright/index.mjs'),
    join(root, '../web-ide-cs106b/node_modules/playwright/index.mjs'),
  ];
  for (const candidate of candidates) {
    try {
      ({ chromium } = await import(pathToFileURL(candidate).href));
      break;
    } catch {
      /* try next */
    }
  }
}
if (!chromium) {
  console.error('Install playwright or set PLAYWRIGHT_MODULE');
  process.exit(2);
}

const server = createServer((req, res) => {
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  const url = req.url?.split('?')[0];
  if (url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
  } else if (url === '/engine.js') {
    res.writeHead(200, { 'Content-Type': 'text/javascript' });
    res.end(engineJs);
  } else if (url === '/engine_bg.wasm') {
    res.writeHead(200, { 'Content-Type': 'application/wasm' });
    res.end(engineWasm);
  } else if (url?.startsWith('/assets/') && /^\/assets\/[\w.-]+\.js$/.test(url)) {
    // The engine loads its worker from assets/ next to /engine.js.
    readFile(join(engineDist, url.slice(1))).then(
      (body) => {
        res.writeHead(200, { 'Content-Type': 'text/javascript' });
        res.end(body);
      },
      () => {
        res.writeHead(404);
        res.end();
      },
    );
  } else if (url === '/debug.a') {
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    res.end(debugA);
  } else if (url === '/support.pch') {
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    res.end(pch);
  } else if (url === '/EnglishWords.dat') {
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    res.end(dictionary);
  } else {
    res.writeHead(404);
    res.end();
  }
});

await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
const { port } = server.address();
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  page.on('pageerror', (err) => console.error('pageerror', err));
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle' });
  const outcome = await page.evaluate(async () => window.probe.run());
  console.log('exit', outcome.result);
  console.log('stdout:\n', outcome.stdout);
  if (outcome.stderr) console.log('stderr:\n', outcome.stderr);
  assert.equal(outcome.result?.type, 'completed', JSON.stringify(outcome.result));
  assert.equal(outcome.result?.exitCode, 0, 'tests should pass');
  assert.match(outcome.stdout, /main_ran:1/);
  assert.match(outcome.stdout, new RegExp(`__SIMPLETEST_V1__:${nonce}:`));
  assert.match(outcome.stdout, /"type":"test_passed"/);
  console.log('smoke-engine: ok');
} finally {
  await browser.close();
  await new Promise((r) => server.close(r));
}
