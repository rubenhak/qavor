import { ManifestError, UserError } from '../util/exit-codes.js';
import type { RegistryEntry, WorkspaceRegistry } from './discovery.js';
import type { ManifestKind } from './types/index.js';

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
  return mergeOverlay(acc, own);
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

/** Recursively merge plain objects; everything else is replaced by `top`. */
function deepMerge(base: unknown, top: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(top)) return top;
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(top)) {
    out[key] = key in out ? deepMerge(out[key], value) : value;
  }
  return out;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
