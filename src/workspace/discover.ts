import fs from 'node:fs/promises';
import path from 'node:path';
import pMap from 'p-map';
import { parseAllDocuments, stringify } from 'yaml';
import { isGitRepo } from '../git/git.js';
import { ManifestError } from '../util/exit-codes.js';
import { isFile } from '../util/fs.js';
import type { ResolvedWorkspace } from './locate.js';

export interface DiscoveredRepo {
  /** Repo name (directory basename with a trailing `.git` stripped). */
  name: string;
  /** Absolute path to the repo directory. */
  dir: string;
  /** Absolute path to the repo's `qavor.yaml`. */
  manifestFile: string;
  /**
   * True when this run scaffolded a `kind: service` manifest into the repo.
   * Only happens for repos that have a `Dockerfile` at their root and no
   * existing `qavor.yaml`.
   */
  manifestCreated: boolean;
  /** True when this run added the repo to the project manifest. */
  referenceAdded: boolean;
}

export interface DiscoverResult {
  /** Absolute path to the project manifest that was (or would be) updated. */
  projectManifestFile: string;
  /** True when the project manifest was rewritten with new references. */
  projectUpdated: boolean;
  /** Repos found at the workspace root, sorted by name. */
  repos: DiscoveredRepo[];
}

export interface DiscoverOptions {
  workspace: ResolvedWorkspace;
  /** Report changes without writing any files. */
  dryRun?: boolean;
  /** Concurrency bound for git-repo probing. */
  concurrency?: number;
}

/**
 * The default `kind: service` manifest scaffolded into a freshly discovered
 * repo that ships a `Dockerfile`. A Dockerfile signals the repo is a runnable
 * app, so we seed a docker-mode service describing how to build and run it.
 */
function renderServiceManifest(name: string): string {
  return stringify({
    kind: 'service',
    name,
    description: name,
    mode: 'docker',
    runtime: {
      docker: {
        enabled: true,
        prepare: { cmd: `docker build -t \${IMAGE_NAME} .` },
        run: { cmd: `docker run -it --rm \${IMAGE_NAME}` },
      },
    },
    env: {
      docker: { IMAGE_NAME: name },
    },
  });
}

/** Collect the repo names already enumerated in a project manifest body. */
function referencedNames(repositories: unknown): Set<string> {
  const set = new Set<string>();
  if (!Array.isArray(repositories)) return set;
  for (const entry of repositories) {
    if (typeof entry === 'string') set.add(entry);
    else if (
      entry &&
      typeof entry === 'object' &&
      typeof (entry as { name?: unknown }).name === 'string'
    ) {
      set.add((entry as { name: string }).name);
    }
  }
  return set;
}

/**
 * Scan the immediate children of the workspace root for git repos and add any
 * unreferenced repo to the project manifest's `repositories:` list — the single
 * source of truth for the workspace repo set.
 *
 * A `kind: service` manifest is scaffolded into a repo only when it ships a
 * `Dockerfile` at its root and has no existing `qavor.yaml`; the Dockerfile
 * signals a runnable app. Repos without a Dockerfile are registered in the
 * project manifest but left untouched on disk.
 *
 * Idempotent: existing manifests are never overwritten and repos already listed
 * in the project manifest are not duplicated.
 */
export async function discoverRepos(opts: DiscoverOptions): Promise<DiscoverResult> {
  if (opts.workspace.layout === 'single') return discoverSingleRepoServices(opts);
  const ws = opts.workspace;
  const root = ws.paths.root;
  const projectRepoDir = path.resolve(ws.projectRepoPath);

  // Read the project manifest once, preserving formatting/comments for write-back.
  const source = await fs.readFile(ws.projectManifestFile, 'utf8');
  const docs = parseAllDocuments(source);
  const projectDoc = docs.find((d) => d.get('kind') === 'project');
  if (!projectDoc) {
    throw new ManifestError(`No \`kind: project\` document found in ${ws.projectManifestFile}.`);
  }
  const referenced = referencedNames(
    (projectDoc.toJS() as { repositories?: unknown }).repositories,
  );

  // Candidate directories: immediate children of the workspace root, skipping
  // hidden dirs (incl. `.qavor`) and the project repo itself.
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    entries = [];
  }
  const candidates = entries.filter(
    (e) =>
      e.isDirectory() && !e.name.startsWith('.') && path.resolve(root, e.name) !== projectRepoDir,
  );

  const probed = await pMap(
    candidates,
    async (e) => {
      const dir = path.join(root, e.name);
      return { dir, name: e.name, isRepo: await isGitRepo(dir) };
    },
    { concurrency: opts.concurrency ?? 8 },
  );

  const repos: DiscoveredRepo[] = [];
  const additions: { name: string; bare: boolean; relPath: string }[] = [];
  const seenNames = new Set<string>();

  for (const { dir, name: dirName, isRepo } of probed) {
    if (!isRepo) continue;
    const name = dirName.replace(/\.git$/, '');
    if (seenNames.has(name)) continue;
    seenNames.add(name);

    const manifestFile = path.join(dir, 'qavor.yaml');
    const hasManifest = await isFile(manifestFile);
    const hasDockerfile = await isFile(path.join(dir, 'Dockerfile'));
    const referenceAdded = !referenced.has(name);
    // Only seed a service manifest for runnable (Dockerfile-bearing) repos.
    const scaffold = !hasManifest && hasDockerfile;

    if (scaffold && !opts.dryRun) {
      await fs.writeFile(manifestFile, renderServiceManifest(name), 'utf8');
    }
    if (referenceAdded) {
      // A bare name resolves to `<name>.git`; anything else needs an explicit path.
      const bare = path.resolve(dir) === path.resolve(root, `${name}.git`);
      additions.push({
        name,
        bare,
        relPath: `./${path.relative(root, dir).split(path.sep).join('/')}`,
      });
    }

    repos.push({
      name,
      dir,
      manifestFile,
      manifestCreated: scaffold,
      referenceAdded,
    });
  }

  repos.sort((a, b) => a.name.localeCompare(b.name));
  additions.sort((a, b) => a.name.localeCompare(b.name));

  let projectUpdated = false;
  if (additions.length > 0) {
    if (!projectDoc.hasIn(['repositories'])) projectDoc.setIn(['repositories'], []);
    for (const add of additions) {
      if (add.bare) projectDoc.addIn(['repositories'], add.name);
      else projectDoc.addIn(['repositories'], { name: add.name, path: add.relPath });
    }
    projectUpdated = true;
    if (!opts.dryRun) {
      const out = docs.map((d) => String(d)).join('');
      await fs.writeFile(ws.projectManifestFile, out, 'utf8');
    }
  }

  return { projectManifestFile: ws.projectManifestFile, projectUpdated, repos };
}

/** Directories never worth scanning for services in a single repo. */
const SERVICE_SCAN_SKIP = new Set([
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
const SERVICE_SCAN_MAX_DEPTH = 5;

/** Coerce a directory basename into a valid service `name`, or null if impossible. */
function toServiceName(dirName: string): string | null {
  const name = dirName
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .slice(0, 63);
  return /^[a-z0-9][a-z0-9._-]{0,62}$/.test(name) ? name : null;
}

/**
 * Single-repo variant of {@link discoverRepos}: scan the repo's own sub-directories
 * for runnable apps (a `Dockerfile` with no accompanying `qavor.yaml`) and scaffold
 * a `kind: service` manifest for each. Never touches `repositories:` — a standalone
 * project has none. The repo root is skipped (it already holds the project manifest).
 */
async function discoverSingleRepoServices(opts: DiscoverOptions): Promise<DiscoverResult> {
  const ws = opts.workspace;
  const root = path.resolve(ws.projectRepoPath);
  const repos: DiscoveredRepo[] = [];
  const seenNames = new Set<string>();

  async function* walk(dir: string, depth: number): AsyncGenerator<string, void, void> {
    if (depth > SERVICE_SCAN_MAX_DEPTH) return;
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.') || SERVICE_SCAN_SKIP.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      yield full;
      yield* walk(full, depth + 1);
    }
  }

  const dirs: string[] = [];
  for await (const d of walk(root, 1)) dirs.push(d);
  dirs.sort();

  for (const dir of dirs) {
    const hasDockerfile = await isFile(path.join(dir, 'Dockerfile'));
    if (!hasDockerfile) continue;
    const manifestFile = path.join(dir, 'qavor.yaml');
    const hasManifest = await isFile(manifestFile);
    const name = toServiceName(path.basename(dir));
    if (!name || seenNames.has(name)) continue;
    seenNames.add(name);

    const scaffold = !hasManifest;
    if (scaffold && !opts.dryRun) {
      await fs.writeFile(manifestFile, renderServiceManifest(name), 'utf8');
    }
    repos.push({
      name,
      dir,
      manifestFile,
      manifestCreated: scaffold,
      referenceAdded: false,
    });
  }

  repos.sort((a, b) => a.name.localeCompare(b.name));
  return { projectManifestFile: ws.projectManifestFile, projectUpdated: false, repos };
}
