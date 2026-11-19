// Lets `node --test` load the app's TypeScript as Next does: `@/` is the project root,
// and relative imports leave off `.ts`.
import { statSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const isFile = (url) => {
  try {
    return statSync(fileURLToPath(url)).isFile();
  } catch {
    return false;
  }
};

registerHooks({
  resolve(specifier, context, next) {
    const local = specifier.startsWith('@/') || specifier.startsWith('./') || specifier.startsWith('../');
    if (!local) return next(specifier, context);
    const base = specifier.startsWith('@/') ? new URL(specifier.slice(2), root) : new URL(specifier, context.parentURL);
    for (const candidate of [base.href, `${base.href}.ts`, `${base.href}.tsx`, `${base.href}/index.ts`]) {
      if (isFile(new URL(candidate))) return next(candidate, context);
    }
    return next(specifier, context);
  },
});
