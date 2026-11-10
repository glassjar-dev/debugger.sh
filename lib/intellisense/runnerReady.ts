/**
 * IntelliSense is optional, and its workers load their own copy of the compilers. They start
 * once the run engine has warmed up, so the two never compete for the CPU or the network
 * while a student is waiting on Run.
 */

/** Optional features wait at most this long, in case the warm-up never settles. */
const FALLBACK_MS = 15_000;

let release!: () => void;
export const runnerReady = new Promise<void>((resolve) => {
  release = resolve;
});
if (typeof window !== 'undefined') setTimeout(() => release(), FALLBACK_MS);

/** Called by the run engine once its warm-up has finished, successfully or not. */
export function markRunnerReady(): void {
  release();
}
