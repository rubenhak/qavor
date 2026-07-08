import { normalizeSteps } from './steps.js';
import type { RuntimeStep, RuntimeStepOrList, ServiceManifest } from './types/index.js';

/**
 * Keys under a runtime backend that are reserved for the start lifecycle and
 * are therefore *not* user-defined commands:
 *   - `enabled`         — backend gate (boolean, not a step).
 *   - `check_installed` — installation probe.
 *   - `install`         — installation step (runs when the probe fails).
 *   - `run`             — the long-lived process started by `qavor up`.
 *
 * Every other key on the backend is a dynamic command (`prepare`,
 * `update_libraries`, `lint`, `test`, …) discovered and run by `qavor <command>`.
 */
export const RESERVED_BACKEND_KEYS: ReadonlySet<string> = new Set([
  'enabled',
  'check_installed',
  'install',
  'run',
]);

/**
 * The uniform shape of every runtime command (`check_installed`, `install`,
 * `run`, and every user-defined command): a `{ description, operations }`
 * object (see the `runtimeDescribedCommand` schema def). `operations` holds the
 * steps to run — a single step or a list — by the time a service manifest
 * reaches this accessor, profile merging has already resolved away any
 * `$append`/`$prepend`/`$unset` directive.
 */
interface DescribedCommand {
  description?: string;
  operations?: RuntimeStepOrList;
}

function isDescribedCommand(value: unknown): value is DescribedCommand {
  return (
    typeof value === 'object' && value !== null && !Array.isArray(value) && 'operations' in value
  );
}

/**
 * Normalize a raw `runtime.<backend>.<command>` value into its ordered steps by
 * unwrapping the uniform `{ description, operations }` form to its `operations`.
 * Shared by every reader of a backend command — dynamic commands via
 * {@link serviceCommandSteps} below, `check_installed` / `install` (read off the
 * resolved manifest by `doctor.ts`), and `run` (read by the native supervisor).
 */
export function normalizeCommandValue(value: unknown): RuntimeStep[] {
  const steps = isDescribedCommand(value) ? value.operations : value;
  return normalizeSteps(steps as RuntimeStepOrList | undefined);
}

type BackendRecord = Record<string, unknown>;

/**
 * The native backend object, if the service declares one. Dynamic command keys
 * live here but aren't on the generated `RuntimeBackend` type (its
 * additionalProperties is stripped for type-gen — see `scripts/gen-types.ts`),
 * so this is the single typed accessor every caller routes through.
 */
function nativeBackend(service: ServiceManifest): BackendRecord | undefined {
  const backend = service.runtime?.native as BackendRecord | undefined;
  return backend && typeof backend === 'object' ? backend : undefined;
}

/**
 * Names of the user-defined commands declared on a service's native backend, in
 * stable sorted order. Reserved lifecycle keys are excluded.
 */
export function serviceCommandNames(service: ServiceManifest): string[] {
  const backend = nativeBackend(service);
  if (!backend) return [];
  return Object.keys(backend)
    .filter((key) => !RESERVED_BACKEND_KEYS.has(key))
    .sort();
}

/**
 * The ordered steps for a named command on a service. Returns `[]` when the
 * service does not declare the command (or the name is reserved), so callers can
 * treat "no steps" as "nothing to do here". Transparently unwraps the
 * `{ description, operations }` form to its `operations`.
 */
export function serviceCommandSteps(service: ServiceManifest, command: string): RuntimeStep[] {
  if (RESERVED_BACKEND_KEYS.has(command)) return [];
  const backend = nativeBackend(service);
  if (!backend) return [];
  return normalizeCommandValue(backend[command]);
}

/**
 * The manifest-declared description for a named command on a service's native
 * backend — set via the `{ description, operations }` form — or `undefined`
 * when the command is a bare step/list or sets no description. Documentation
 * only; has no bearing on what runs.
 */
export function serviceCommandDescription(
  service: ServiceManifest,
  command: string,
): string | undefined {
  const backend = nativeBackend(service);
  const value = backend?.[command];
  if (!isDescribedCommand(value)) return undefined;
  return value.description && value.description.length > 0 ? value.description : undefined;
}
