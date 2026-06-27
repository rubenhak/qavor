import type { RuntimeStep, RuntimeStepOrList } from './types/index.js';

/**
 * Normalize a runtime step value into an ordered list of steps.
 *
 * A backend step (`prepare`, `update_libraries`, `check_installed`, …) may be
 * written either as a single object (`{ cmd: "…" }`) or as a list of step
 * objects (`[{ cmd: "…" }, { cmd: "…" }]`). Callers run the returned steps in
 * declaration order, aborting on the first non-zero exit. An absent step
 * yields an empty list.
 */
export function normalizeSteps(step: RuntimeStepOrList | undefined): RuntimeStep[] {
  if (step == null) return [];
  return Array.isArray(step) ? [...step] : [step];
}
