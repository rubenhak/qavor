import fs from 'node:fs/promises';
import path from 'node:path';
import pMap from 'p-map';
import { isDirectory } from '../util/fs.js';
import { type LoadedDocument, loadManifestFile } from './loader.js';
import type { ManifestKind } from './types/index.js';
import { isKnownKind, type ValidationIssue, validateDocument } from './validator.js';

const MAX_DEPTH = 4;
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
 *   - Every `<sub-dir>/qavor.yaml` under the repo root, to depth MAX_DEPTH.
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
  data: LoadedDocument['data'];
  position: LoadedDocument['position'];
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

  const reposList: { name: string; dir: string }[] = [];
  for (const [name, dir] of opts.repos) reposList.push({ name, dir });

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

  // Validate workspace-wide uniqueness of names within (service/stateful/profile/repo).
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

  return { byName, entries: all, issues };
}
