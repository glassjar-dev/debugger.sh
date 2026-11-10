/**
 * Puts the language-tooling assets the editor loads at runtime into public/:
 *   public/intellisense/pyright.worker.js   basedpyright's browser build (npm)
 *   public/intellisense/ra/*                rust-analyzer wasm from tools/ra-wasm/dist, only when
 *                                           NEXT_PUBLIC_RUST_ANALYZER_BASE=/intellisense/ra
 * Otherwise rust-analyzer loads from the CDN, and a local copy would only add
 * ~11 MB of unused files to the deploy.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const out = join(root, 'public/intellisense');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const pyright = join(dirname(require.resolve('browser-basedpyright/package.json')), 'dist/pyright.worker.js');
copyFileSync(pyright, join(out, 'pyright.worker.js'));
console.log(`copied ${pyright}`);

const ra = join(root, 'tools/ra-wasm/dist');
if (process.env.NEXT_PUBLIC_RUST_ANALYZER_BASE === '/intellisense/ra' && existsSync(ra)) {
  mkdirSync(join(out, 'ra'), { recursive: true });
  for (const name of readdirSync(ra)) {
    if (!/\.(js|wasm|gz)$/.test(name)) continue;
    copyFileSync(join(ra, name), join(out, 'ra', name));
    console.log(`copied ${join(ra, name)}`);
  }
}
