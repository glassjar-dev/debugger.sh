/**
 * IntelliSense is optional, and its workers load their own copy of the compilers. Each
 * language's IntelliSense starts once the run engine for that language has warmed up (or
 * finished a Run), so the two never compete for the CPU or the network while a student is
 * waiting on Run. Switching to C++ warms clang first, then C++ IntelliSense.
 */
import type { Lang } from '@/components/constants';

/** Optional features wait at most this long, in case the warm-up never settles. */
const FALLBACK_MS = 15_000;

const gates = new Map<Lang, { ready: Promise<void>; release: () => void }>();

function gate(lang: Lang) {
  let entry = gates.get(lang);
  if (!entry) {
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
      release = resolve;
    });
    if (typeof window !== 'undefined') setTimeout(() => release(), FALLBACK_MS);
    entry = { ready, release };
    gates.set(lang, entry);
  }
  return entry;
}

/** Resolves once `lang`'s run engine has warmed up (or after the fallback). */
export function runnerReady(lang: Lang): Promise<void> {
  return gate(lang).ready;
}

/** Called by the run engine once `lang`'s warm-up or Run has finished, successfully or not. */
export function markRunnerReady(lang: Lang): void {
  gate(lang).release();
}
