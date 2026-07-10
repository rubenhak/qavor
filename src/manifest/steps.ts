import type {
  CmdStep,
  ComposeStep,
  DockerStep,
  RuntimeStep,
  RuntimeStepOrList,
} from './types/index.js';

/**
 * Internal, post-validation annotation key: the directory of the manifest that
 * defined a step. Profile flattening stamps it on every step a profile
 * contributes (see `resolve.ts`), so executors can resolve step-relative paths
 * (`cwd`, a compose step's `file`) against the profile's own directory — which
 * for a remote profile is its locally materialized cache directory — rather
 * than the referencing service's. Never part of the schema; stripped from any
 * user-facing manifest dump via {@link stripStepOrigins}.
 */
export const STEP_ORIGIN_KEY = '$dir';

/** A runtime step, possibly annotated with the defining manifest's directory. */
export type AnnotatedStep = RuntimeStep & { [STEP_ORIGIN_KEY]?: string };

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

/** Narrow a step to the classic shell form (`{ cmd, cwd?, env?, shell? }`). */
export function isCmdStep(step: RuntimeStep): step is CmdStep {
  return typeof (step as CmdStep).cmd === 'string';
}

/** The declarative compose body of a step, when it is a `{ compose: … }` step. */
export function composeStepOf(step: RuntimeStep): ComposeStep | undefined {
  const body = (step as { compose?: ComposeStep }).compose;
  return body && typeof body === 'object' ? body : undefined;
}

/** The declarative docker body of a step, when it is a `{ docker: … }` step. */
export function dockerStepOf(step: RuntimeStep): DockerStep | undefined {
  const body = (step as { docker?: DockerStep }).docker;
  return body && typeof body === 'object' ? body : undefined;
}

/** The defining manifest's directory stamped on a profile-contributed step. */
export function stepOriginDir(step: RuntimeStep): string | undefined {
  const dir = (step as AnnotatedStep)[STEP_ORIGIN_KEY];
  return typeof dir === 'string' && dir.length > 0 ? dir : undefined;
}

/** One-line human label for a step, used in logs and failure messages. */
export function describeStep(step: RuntimeStep): string {
  if (isCmdStep(step)) return step.cmd;
  const compose = composeStepOf(step);
  if (compose) return `compose ${compose.action}`;
  const docker = dockerStepOf(step);
  if (docker) return `docker ${docker.action} ${docker.name}`;
  return '(unknown step)';
}
