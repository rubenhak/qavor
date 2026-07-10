import { ManifestError, UserError } from '../util/exit-codes.js';
import type { RegistryEntry, WorkspaceRegistry } from './discovery.js';
import { normalizeSteps, STEP_ORIGIN_KEY } from './steps.js';
import type { ManifestKind, RuntimeStepOrList } from './types/index.js';

/** Fields a profile contributes to (and that the referencing manifest overrides). */
const OVERLAY_KEYS = ['mode', 'runtime', 'env'] as const;
type OverlayKey = (typeof OVERLAY_KEYS)[number];
type Overlay = Partial<Record<OverlayKey, unknown>>;

export interface ResolvedManifest {
  /** Kind of the resolved manifest. */
  kind: ManifestKind;
  /** Name of the resolved manifest. */
  name: string;
  /** Absolute path of the source manifest file. */
  file: string;
  /**
   * The resolved manifest body: a deep copy of the source with every referenced
   * profile flattened in (later profiles and the manifest's own values winning)
   * and the now-redundant `profiles:` key removed.
   */
  data: Record<string, unknown>;
  /** Profile names applied, in resolution order (deepest/earliest first). */
  appliedProfiles: string[];
}

/** Strip a `<repo>:<name>` qualifier down to the bare reference name. */
function bareRef(ref: string): string {
  return ref.includes(':') ? ref.slice(ref.lastIndexOf(':') + 1) : ref;
}

/**
 * Locate a single manifest in the workspace by name (and, when given, kind).
 * Throws a {@link UserError} when nothing matches or when the name is ambiguous
 * across kinds and no kind was supplied.
 */
export function findManifest(
  registry: WorkspaceRegistry,
  name: string,
  kind?: ManifestKind,
): RegistryEntry {
  const matches = registry.entries.filter(
    (e) => e.name === name && (kind === undefined || e.kind === kind),
  );
  const [first, ...rest] = matches;
  if (!first) {
    const scope = kind ? `${kind} '${name}'` : `'${name}'`;
    const available = listManifests(registry, kind);
    const hint = available.length > 0 ? ` Available: ${available.join(', ')}.` : '';
    throw new UserError(`No ${scope} manifest found in the workspace.${hint}`);
  }
  if (rest.length > 0) {
    const kinds = [...new Set(matches.map((m) => m.kind))].sort();
    throw new UserError(
      `'${name}' is ambiguous; it matches ${matches.length} manifests (${kinds.join(', ')}). ` +
        `Disambiguate with --kind <${kinds.join('|')}>.`,
    );
  }
  return first;
}

/** Human-readable list of named manifests, optionally filtered by kind. */
function listManifests(registry: WorkspaceRegistry, kind?: ManifestKind): string[] {
  const out = new Set<string>();
  for (const e of registry.entries) {
    if (!e.name) continue;
    if (kind !== undefined && e.kind !== kind) continue;
    out.add(`${e.kind}:${e.name}`);
  }
  return [...out].sort();
}

/**
 * Resolve a manifest into its fully-flattened form: every profile referenced
 * via `profiles:` (recursively, chained profiles included) is merged in below
 * the manifest's own `runtime`/`mode`/`env`, with later profiles winning over
 * earlier ones and the manifest's own values winning over all profiles. The
 * resulting document drops the `profiles:` key, since it is now baked in.
 *
 * Only `runtime`, `mode`, and `env` flow from profiles — every other field
 * (name, description, groups, require, hooks, …) is left untouched on the
 * target manifest.
 */
export function resolveManifest(
  entry: RegistryEntry,
  registry: WorkspaceRegistry,
): ResolvedManifest {
  const applied: string[] = [];
  const overlay = collectOverlay(entry, registry, [], applied);

  // Deep-copy the source body so we never mutate the registry-held manifest.
  const data = structuredClone(entry.data) as Record<string, unknown>;
  delete data.profiles;
  for (const key of OVERLAY_KEYS) {
    if (key in overlay && typeof overlay[key] !== 'undefined') {
      data[key] = structuredClone(overlay[key]);
    }
  }

  return {
    kind: entry.kind,
    name: entry.name,
    file: entry.file,
    data,
    appliedProfiles: applied,
  };
}

/**
 * Build the merged overlay (`runtime`/`mode`/`env`) for an entry: each referenced
 * profile is resolved first (in declaration order, later winning), then the
 * entry's own overlay is layered on top so it wins over every profile.
 */
function collectOverlay(
  entry: RegistryEntry,
  registry: WorkspaceRegistry,
  stack: string[],
  applied: string[],
): Overlay {
  let acc: Overlay = {};

  const profiles = (entry.data as { profiles?: unknown }).profiles;
  if (Array.isArray(profiles)) {
    for (const ref of profiles) {
      if (typeof ref !== 'string' || ref.length === 0) continue;
      const name = bareRef(ref);
      if (stack.includes(name)) {
        throw new ManifestError(
          `Profile cycle detected while resolving '${entry.name || entry.kind}': ` +
            `${[...stack, name].join(' → ')}.`,
        );
      }
      const profile = registry.entries.find((e) => e.kind === 'profile' && e.name === name);
      if (!profile) {
        throw new ManifestError(
          `'${entry.name || entry.kind}' references profile '${ref}', ` +
            `which is not defined in the workspace.`,
        );
      }
      const sub = collectOverlay(profile, registry, [...stack, name], applied);
      acc = mergeOverlay(acc, sub);
      if (!applied.includes(name)) applied.push(name);
    }
  }

  // The entry's own runtime/mode/env wins over everything it extends.
  const own: Overlay = {};
  for (const key of OVERLAY_KEYS) {
    const value = (entry.data as Record<string, unknown>)[key];
    if (typeof value !== 'undefined') own[key] = value;
  }
  // Steps a profile contributes are stamped with the profile's own directory so
  // executors resolve profile-shipped asset paths (a compose step's
  // `file`/`env_file`) against the profile — for a remote profile, its locally
  // materialized directory. The step's working directory is unaffected: cwd
  // always follows the consuming service, as if the profile's steps had been
  // copied inline. Services' own steps stay unannotated.
  if (entry.kind === 'profile' && typeof own.runtime !== 'undefined') {
    own.runtime = annotateRuntimeOrigin(structuredClone(own.runtime), entry.dir);
  }
  return mergeOverlay(acc, own);
}

/**
 * Stamp {@link STEP_ORIGIN_KEY} onto every step object found inside a profile's
 * `runtime` block (all backends, all commands, including steps nested in
 * `$append`/`$prepend`/`$replace` directives). Mutates and returns `runtime`,
 * which must already be a private copy.
 */
function annotateRuntimeOrigin(runtime: unknown, dir: string): unknown {
  if (!isPlainObject(runtime)) return runtime;
  for (const backend of Object.values(runtime)) {
    if (!isPlainObject(backend)) continue;
    for (const [key, command] of Object.entries(backend)) {
      if (key === 'enabled') continue;
      annotateCommandValue(command, dir);
    }
  }
  return runtime;
}

/** Recurse a command value (described command, step, list, or directive). */
function annotateCommandValue(value: unknown, dir: string): void {
  if (Array.isArray(value)) {
    for (const item of value) annotateCommandValue(item, dir);
    return;
  }
  if (!isPlainObject(value)) return;
  if (isStepObject(value)) {
    value[STEP_ORIGIN_KEY] = dir;
    return;
  }
  // Merge directives carry their steps in the $append/$prepend/$replace payload.
  if (DIRECTIVE_KEYS.some((k) => k in value) || value.$unset === true) {
    for (const key of DIRECTIVE_KEYS) {
      if (key in value) annotateCommandValue(value[key], dir);
    }
    return;
  }
  if ('operations' in value) annotateCommandValue(value.operations, dir);
}

/** A step object of any kind: shell `cmd`, declarative `compose`, or `docker`. */
function isStepObject(v: Record<string, unknown>): boolean {
  return typeof v.cmd === 'string' || isPlainObject(v.compose) || isPlainObject(v.docker);
}

/**
 * Deep-copy a resolved manifest body with every internal step-origin annotation
 * removed — for user-facing dumps (`qavor resolve-manifest`) where the
 * annotation would read as a manifest field.
 */
export function stripStepOrigins<T>(data: T): T {
  if (Array.isArray(data)) return data.map((v) => stripStepOrigins(v)) as unknown as T;
  if (!isPlainObject(data)) return data;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (key === STEP_ORIGIN_KEY) continue;
    out[key] = stripStepOrigins(value);
  }
  return out as T;
}

/** Merge two overlays; `top` wins. Objects deep-merge, scalars/arrays replace. */
function mergeOverlay(base: Overlay, top: Overlay): Overlay {
  const out: Overlay = { ...base };
  for (const key of OVERLAY_KEYS) {
    if (!(key in top) || typeof top[key] === 'undefined') continue;
    out[key] = deepMerge(base[key], top[key]);
  }
  return out;
}

/**
 * Recursively merge plain objects; everything else is replaced by `top`.
 *
 * A command's `operations` additionally honours profile-merge directives: when
 * it is an `$append`/`$prepend`/`$replace` directive it is computed against the
 * inherited `base` (see {@link applyDirective}); a command whose `operations` is
 * `{ $unset: true }` drops the whole inherited command rather than being merged.
 * Any other array or scalar replaces `base`.
 */
function deepMerge(base: unknown, top: unknown): unknown {
  if (isMergeDirective(top)) return applyDirective(base, top);
  if (!isPlainObject(top)) return top;
  // Fresh subtree (no object to merge into): still resolve any nested directives.
  if (!isPlainObject(base)) return materialize(top);
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(top)) {
    if (isUnset(value) || isCommandUnset(value)) {
      delete out[key];
      continue;
    }
    out[key] = key in out ? deepMerge(out[key], value) : materialize(value);
  }
  return out;
}

const DIRECTIVE_KEYS = ['$append', '$prepend', '$replace'] as const;

/** A step-list merge directive (`$append`/`$prepend`/`$replace`); `$unset` is handled separately. */
function isMergeDirective(v: unknown): v is Record<string, unknown> {
  return isPlainObject(v) && DIRECTIVE_KEYS.some((k) => k in v);
}

/** The bare `{ $unset: true }` directive: drop the value it is assigned to. */
function isUnset(v: unknown): boolean {
  return isPlainObject(v) && v.$unset === true;
}

/**
 * A command whose `operations` is the `{ $unset: true }` directive — the uniform
 * way to drop a command inherited from a profile (`<cmd>: { operations: { $unset: true } }`).
 * The whole command key is removed rather than merged.
 */
function isCommandUnset(v: unknown): boolean {
  return isPlainObject(v) && isUnset(v.operations);
}

/** Apply a step-list directive against the inherited value, yielding a concrete step list. */
function applyDirective(base: unknown, dir: Record<string, unknown>): unknown {
  if ('$replace' in dir) return dir.$replace;
  const inherited = normalizeSteps(base as RuntimeStepOrList | undefined);
  if ('$prepend' in dir) {
    return [...normalizeSteps(dir.$prepend as RuntimeStepOrList), ...inherited];
  }
  return [...inherited, ...normalizeSteps(dir.$append as RuntimeStepOrList)];
}

/**
 * Resolve a value that has no inherited base (a fresh key): recurse through
 * plain objects so nested directives collapse to concrete step lists, drop any
 * `$unset` (nothing to remove), and pass scalars/arrays through untouched.
 */
function materialize(v: unknown): unknown {
  if (isMergeDirective(v)) return applyDirective(undefined, v);
  if (!isPlainObject(v)) return v;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(v)) {
    if (isUnset(value) || isCommandUnset(value)) continue;
    out[key] = materialize(value);
  }
  return out;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
