import fs from 'node:fs/promises';
import path from 'node:path';
import pMap from 'p-map';
import { isDirectory } from '../util/fs.js';
import { getLogger } from '../util/logger.js';
import { type LoadedDocument, loadManifestFile } from './loader.js';
import { type RemoteProfileOptions, resolveRemoteProfiles } from './remote.js';
import { resolveManifest } from './resolve.js';
import type { ManifestKind, Requirement } from './types/index.js';
import { formatIssue, isKnownKind, type ValidationIssue, validateDocument } from './validator.js';

const MAX_DEPTH = 5;
const SKIP_DIRS = new Set([
  '.git',
  '.qavor',
  'node_modules',
  '.venv',
  'venv',
  '__pycache__',
  'dist',
  'build',
  'target',
  '.next',
  '.svelte-kit',
  '.cache',
]);

/**
 * Discover manifest files under a repo root. Conventions:
 *
 *   - Root `qavor.yaml` (single or multi-document).
 *   - Every `qavor.yaml` under a `qavor/` directory at the repo root.
 *   - Every `<sub-dir>/qavor.yaml` under the repo root, at any depth (pruning the
 *     directories in SKIP_DIRS and bounded only by MAX_DEPTH as a runaway guard).
 *
 * Returns absolute file paths.
 */
export async function discoverManifestFiles(repoRoot: string): Promise<string[]> {
  const abs = path.resolve(repoRoot);
  const found = new Set<string>();
  if (!(await isDirectory(abs))) return [];

  // Root file
  const rootFile = path.join(abs, 'qavor.yaml');
  try {
    await fs.access(rootFile);
    found.add(rootFile);
  } catch {
    /* missing root manifest is fine */
  }

  // qavor/ directory at root
  const qavorDir = path.join(abs, 'qavor');
  if (await isDirectory(qavorDir)) {
    for await (const f of walk(qavorDir, qavorDir, 0)) found.add(f);
  }

  // Sub-directory manifests, depth-limited
  for await (const f of walk(abs, abs, 0)) {
    found.add(f);
  }

  return [...found].sort();
}

async function* walk(
  rootBase: string,
  current: string,
  depth: number,
): AsyncGenerator<string, void, void> {
  if (depth > MAX_DEPTH) return;
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(current, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(current, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      // Don't recurse into the rootBase's own `qavor/` dir twice.
      if (depth === 0 && entry.name === 'qavor') continue;
      yield* walk(rootBase, full, depth + 1);
    } else if (entry.isFile() && entry.name === 'qavor.yaml') {
      // Skip the root-of-rootBase file; caller handles it.
      if (depth === 0 && current === rootBase) continue;
      yield full;
    }
  }
}

export interface RegistryEntry {
  kind: ManifestKind;
  /** Discovered name from the manifest, when present. */
  name: string;
  file: string;
  docIndex: number;
  /** Directory containing the manifest, used to resolve relative paths. */
  dir: string;
  /** Optional repo name this manifest belongs to. */
  repo?: string;
  /** For profiles fetched from a remote source, the original source URI. */
  remoteSource?: string;
  /**
   * The manifest body. Profiles referenced via `profiles:` are flattened in at
   * registry-build time (see {@link resolveProfiles}), so this is the
   * *effective* definition every command consumes — runtime/mode/env carry the
   * merged values and the now-redundant `profiles:` key is removed.
   */
  data: LoadedDocument['data'];
  position: LoadedDocument['position'];
  /** Profile names flattened into `data`, in resolution order (earliest first). */
  appliedProfiles?: string[];
}

export interface WorkspaceRegistry {
  /** Workspace-scoped name → entry, validated unique. */
  byName: Map<string, RegistryEntry>;
  /** All loaded manifest entries (in discovery order). */
  entries: RegistryEntry[];
  issues: ValidationIssue[];
}

export interface DiscoveryOptions {
  /** Workspace root. */
  workspaceRoot: string;
  /** Map of repo name → absolute repo path on disk. */
  repos: Map<string, string>;
  /** Concurrency. Default Infinity (bounded by callers). */
  concurrency?: number;
  /** When true, manifests with unknown kinds raise issues; otherwise warned. */
  strictUnknownKind?: boolean;
  /** Use cached copies of remote profile sources only; never hit the network. */
  offline?: boolean;
  /** Bypass caches and re-fetch every remote profile source. */
  refresh?: boolean;
  /** Cancellation for remote profile fetches. */
  signal?: AbortSignal;
  /** Environment used to resolve remote profile `auth.tokenEnv`. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Walk every cloned repo, load + validate manifests, and assemble the
 * workspace registry. Cross-references (e.g. project repo names → cloned
 * repos) are checked at the caller layer; here we only enforce unique names
 * inside the union of manifests.
 */
export async function buildWorkspaceRegistry(opts: DiscoveryOptions): Promise<WorkspaceRegistry> {
  const issues: ValidationIssue[] = [];
  const all: RegistryEntry[] = [];

  // Dedupe by resolved directory: a repo may be reachable under more than one
  // key (e.g. its own name in `repositories:` and the `__project__` sentinel
  // when it is the project repo). Scanning the same dir twice would load every
  // manifest twice and raise spurious duplicate-name issues. First key wins.
  const reposList: { name: string; dir: string }[] = [];
  const seenDirs = new Set<string>();
  for (const [name, dir] of opts.repos) {
    const real = path.resolve(dir);
    if (seenDirs.has(real)) continue;
    seenDirs.add(real);
    reposList.push({ name, dir });
  }

  await pMap(
    reposList,
    async ({ name: repoName, dir }) => {
      const files = await discoverManifestFiles(dir);
      for (const file of files) {
        let docs: LoadedDocument[];
        try {
          docs = await loadManifestFile(file);
        } catch (err) {
          issues.push({
            file,
            line: 1,
            column: 1,
            kind: 'unknown',
            path: '',
            message: err instanceof Error ? err.message : String(err),
          });
          continue;
        }
        for (const doc of docs) {
          if (!isKnownKind(doc.kind)) {
            const pos = doc.position('/kind');
            issues.push({
              file: pos.file,
              line: pos.line,
              column: pos.column,
              kind: String(doc.kind ?? 'unknown'),
              path: '/kind',
              message: `Unknown or missing kind in this document`,
            });
            continue;
          }
          const result = validateDocument(doc);
          if (!result.ok) {
            issues.push(...result.issues);
            continue;
          }
          const data = doc.data as { name?: string };
          all.push({
            kind: doc.kind,
            name: typeof data.name === 'string' ? data.name : '',
            file: doc.file,
            docIndex: doc.docIndex,
            dir: path.dirname(doc.file),
            repo: repoName,
            data: doc.data,
            position: doc.position,
          });
        }
      }
    },
    { concurrency: opts.concurrency ?? 8 },
  );

  // Fetch, validate, and register any profiles referenced by remote URL/git,
  // rewriting those references to bare names so the uniqueness, cross-reference,
  // and profile-flattening passes below run unchanged. No-op when nothing
  // declares a remote reference.
  const remoteOpts: RemoteProfileOptions = {
    concurrency: opts.concurrency ?? 8,
    offline: opts.offline ?? false,
    refresh: opts.refresh ?? false,
    ...(opts.signal ? { signal: opts.signal } : {}),
    ...(opts.env ? { env: opts.env } : {}),
  };
  await resolveRemoteProfiles(all, issues, remoteOpts);

  // Validate workspace-wide uniqueness of names within (service/profile/repo).
  const byName = new Map<string, RegistryEntry>();
  for (const entry of all) {
    if (!entry.name) continue;
    if (entry.kind === 'workspaces' || entry.kind === 'project') continue;
    const key = entry.name;
    const existing = byName.get(key);
    if (existing && existing.kind === entry.kind) {
      const pos = entry.position('/name');
      issues.push({
        file: pos.file,
        line: pos.line,
        column: pos.column,
        kind: entry.kind,
        path: '/name',
        message: `Duplicate ${entry.kind} name '${entry.name}'. Already declared at ${existing.file}.`,
      });
      continue;
    }
    if (!existing) byName.set(key, entry);
  }

  // Semantic pass: every `require:` / `profiles:` reference must resolve to a
  // manifest that actually exists in the workspace.
  checkCrossReferences(all, issues);

  // Profile resolution: flatten every referenced profile into each entry's
  // runtime/mode/env so downstream commands (prepare, run, env, …) consume the
  // effective definition without re-resolving.
  const registry: WorkspaceRegistry = { byName, entries: all, issues };
  resolveProfiles(registry);

  return registry;
}

/**
 * Flatten `profiles:` into every entry's `data` in place. Resolution is
 * computed against the still-raw entries first and assigned in a second pass,
 * so chained profiles always read pre-resolution data regardless of iteration
 * order. Resolution failures (profile cycles; missing profiles already flagged
 * by {@link checkCrossReferences}) are recorded as issues, deduped by message,
 * and leave the offending entry's data untouched.
 */
function resolveProfiles(registry: WorkspaceRegistry): void {
  const seen = new Set(registry.issues.map((i) => i.message));
  const resolved: { entry: RegistryEntry; data: RegistryEntry['data']; applied: string[] }[] = [];
  for (const entry of registry.entries) {
    try {
      const r = resolveManifest(entry, registry);
      resolved.push({ entry, data: r.data as RegistryEntry['data'], applied: r.appliedProfiles });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (seen.has(message)) continue;
      seen.add(message);
      const pos = entry.position('/profiles');
      registry.issues.push({
        file: pos.file,
        line: pos.line,
        column: pos.column,
        kind: entry.kind,
        path: '/profiles',
        message,
      });
    }
  }
  for (const { entry, data, applied } of resolved) {
    entry.data = data;
    entry.appliedProfiles = applied;
  }
}

/** Strip a `<repo>:<name>` qualifier down to the bare reference name. */
function bareRef(ref: string): string {
  return ref.includes(':') ? ref.slice(ref.lastIndexOf(':') + 1) : ref;
}

function refIssue(entry: RegistryEntry, pointer: string, message: string): ValidationIssue {
  const pos = entry.position(pointer);
  return {
    file: pos.file,
    line: pos.line,
    column: pos.column,
    kind: entry.kind,
    path: pointer,
    message,
  };
}

/**
 * Validate cross-manifest references after all documents are loaded and
 * schema-valid: `require:` deps (service/group) and `profiles:` must each point
 * at a manifest declared somewhere in the workspace. Optional requirements are
 * allowed to dangle. Group references resolve against the union of every
 * declared group (project `groups`, repo-inline groups, and service `groups`
 * memberships).
 */
function checkCrossReferences(entries: RegistryEntry[], issues: ValidationIssue[]): void {
  const serviceNames = new Set<string>();
  const profileNames = new Set<string>();
  const groupNames = new Set<string>();

  for (const e of entries) {
    if (!e.name) continue;
    if (e.kind === 'service') serviceNames.add(e.name);
    else if (e.kind === 'profile') profileNames.add(e.name);
  }

  // Collect every declared group name.
  for (const e of entries) {
    const ownGroups = (e.data as { groups?: unknown }).groups;
    if (Array.isArray(ownGroups)) {
      for (const g of ownGroups) if (typeof g === 'string') groupNames.add(g);
    }
    if (e.kind === 'project') {
      const groups = (e.data as { groups?: Record<string, unknown> }).groups;
      if (groups && typeof groups === 'object') {
        for (const g of Object.keys(groups)) groupNames.add(g);
      }
      const repos = (e.data as { repositories?: unknown[] }).repositories;
      if (Array.isArray(repos)) {
        for (const r of repos) {
          const repoGroups = (r as { groups?: unknown })?.groups;
          if (Array.isArray(repoGroups)) {
            for (const g of repoGroups) if (typeof g === 'string') groupNames.add(g);
          }
        }
      }
    }
  }

  for (const e of entries) {
    if (e.kind !== 'service') continue;
    const label = e.name || e.kind;

    const requires = (e.data as { require?: Requirement[] }).require;
    if (Array.isArray(requires)) {
      requires.forEach((req, i) => {
        if (!req || typeof req !== 'object' || req.optional) return;
        const ptr = `/require/${i}`;
        if (typeof req.service === 'string' && req.service.length > 0) {
          const bare = bareRef(req.service);
          if (!serviceNames.has(bare)) {
            issues.push(
              refIssue(
                e,
                ptr,
                `'${label}' requires service '${req.service}', which is not defined in the workspace.`,
              ),
            );
          }
        } else if (typeof req.group === 'string' && req.group.length > 0) {
          if (!groupNames.has(req.group)) {
            issues.push(
              refIssue(
                e,
                ptr,
                `'${label}' requires group '${req.group}', which is not defined in any manifest.`,
              ),
            );
          }
        }
      });
    }

    const profiles = (e.data as { profiles?: unknown[] }).profiles;
    if (Array.isArray(profiles)) {
      profiles.forEach((p, i) => {
        if (typeof p !== 'string' || profileNames.has(p)) return;
        issues.push(
          refIssue(
            e,
            `/profiles/${i}`,
            `'${label}' references profile '${p}', which is not defined in the workspace.`,
          ),
        );
      });
    }
  }
}

/**
 * Emit every manifest issue (parse, schema, and cross-reference errors)
 * collected while building the workspace registry. Logs go to stderr in both
 * human and `--json` (NDJSON) modes. Returns true when any issue was reported,
 * so callers can decide whether to fail closed.
 */
export function reportRegistryIssues(issues: ValidationIssue[]): boolean {
  if (issues.length === 0) return false;
  const logger = getLogger();
  for (const issue of issues) {
    logger.error(
      { file: issue.file, line: issue.line, column: issue.column, path: issue.path },
      formatIssue(issue),
    );
  }
  return true;
}
