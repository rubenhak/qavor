import os from 'node:os';
import pLimit from 'p-limit';

/**
 * Resolve the effective concurrency for a fan-out operation. Defaults to
 * `os.availableParallelism()` (Node 19+); falls back to `os.cpus().length`.
 * Callers may override globally via `--jobs N`.
 */
export function resolveJobs(override?: number): number {
  if (typeof override === 'number' && Number.isFinite(override) && override >= 1) {
    return Math.floor(override);
  }
  const avail = typeof os.availableParallelism === 'function'
    ? os.availableParallelism()
    : os.cpus().length;
  return Math.max(1, avail);
}

export function makeLimiter(jobs: number): <T>(fn: () => Promise<T>) => Promise<T> {
  return pLimit(jobs);
}
