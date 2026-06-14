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
