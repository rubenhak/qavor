import os from 'node:os';
import pLimit from 'p-limit';
import pMap from 'p-map';

/**
 * Resolve the effective concurrency for a fan-out operation. Defaults to
 * `os.availableParallelism()` (Node 19+); falls back to `os.cpus().length`.
 * Callers may override globally via `--jobs N`.
 */
export function resolveJobs(override?: number): number {
  if (typeof override === 'number' && Number.isFinite(override) && override >= 1) {
    return Math.floor(override);
  }
  const avail =
    typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
  return Math.max(1, avail);
}

export function makeLimiter(jobs: number): <T>(fn: () => Promise<T>) => Promise<T> {
  return pLimit(jobs);
}

/**
 * How a fan-out command executes its per-item work.
 *
 * - `serial`   — one task at a time, in input order (deterministic; concurrency 1).
 * - `parallel` — bounded concurrency, up to `--jobs N` tasks in flight at once;
 *   any remaining tasks wait until a running task completes.
 */
export type ExecutionMode = 'serial' | 'parallel';

/** A resolved decision about how to run a fan-out: the mode plus its task cap. */
export interface ExecutionPlan {
  mode: ExecutionMode;
  /** Maximum number of tasks in flight at once. Always 1 for `serial`. */
  concurrency: number;
}

/** Inputs to {@link planExecution}: the command default plus CLI overrides. */
export interface ExecutionPreferences {
  /** The command's own default mode when the user gives no override. */
  defaultMode: ExecutionMode;
  /** `--serial` was passed: force one-at-a-time execution. */
  serial?: boolean | undefined;
  /** `--parallel` was passed: force bounded-concurrent execution. */
  parallel?: boolean | undefined;
  /** `--jobs N` value, if the user supplied one. */
  jobs?: number | undefined;
}

/**
 * Decide how a fan-out should run, combining a command's default mode with the
 * user's CLI overrides. Precedence (highest first):
 *
 * 1. `--serial` / `--parallel` — explicit mode switch.
 * 2. `--jobs N` — an explicit cap also picks the mode by its value
 *    (`N <= 1` ⇒ serial, `N > 1` ⇒ parallel).
 * 3. the command's `defaultMode`.
 *
 * Throws when both `--serial` and `--parallel` are given (caller maps to a
 * user error).
 */
export function planExecution(prefs: ExecutionPreferences): ExecutionPlan {
  if (prefs.serial && prefs.parallel) {
    throw new Error('Cannot combine --serial and --parallel; pick one.');
  }
  let mode = prefs.defaultMode;
  if (prefs.serial) {
    mode = 'serial';
  } else if (prefs.parallel) {
    mode = 'parallel';
  } else if (typeof prefs.jobs === 'number') {
    // An explicit --jobs value selects the mode by its magnitude.
    mode = prefs.jobs <= 1 ? 'serial' : 'parallel';
  }
  const concurrency = mode === 'serial' ? 1 : resolveJobs(prefs.jobs);
  return { mode, concurrency };
}

/**
 * Run `worker` over every item under the given execution plan, returning the
 * results in input order. `serial` plans run one task at a time; `parallel`
 * plans run up to `plan.concurrency` tasks at once with the rest queued.
 *
 * This is the single fan-out primitive every multi-repo / multi-service verb
 * routes through, satisfying the "bounded parallelism" engineering rule.
 */
export async function runFanOut<T, R>(
  items: readonly T[],
  worker: (item: T, index: number) => Promise<R>,
  plan: ExecutionPlan,
): Promise<R[]> {
  return pMap(items, worker, { concurrency: plan.concurrency });
}
