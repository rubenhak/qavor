import path from 'node:path';
import { deriveCloneUrl } from '../git/git.js';
import type { ProjectManifest, ProjectRepoEntry } from '../manifest/types/index.js';
import { ManifestError } from '../util/exit-codes.js';

export interface ResolvedRepo {
  name: string;
  url: string;
  dir: string;
  branch: string | undefined;
  tag: string | undefined;
  commit: string | undefined;
  shallow: boolean | undefined;
  submodules: boolean | undefined;
  optional: boolean;
  /** True if this repo is the project repo itself. */
  isProjectRepo: boolean;
}

interface ResolveOpts {
  /** Absolute workspace root. */
  workspaceRoot: string;
  /** The project manifest body. */
  project: ProjectManifest;
  /** Absolute path to the project repo directory. */
  projectRepoPath: string;
}

/**
 * Resolve every repo entry in a project manifest to a concrete clone target.
 * Skips the project repo (caller already has it).
 *
 * A standalone (single-repo) project declares no `repositories`; the workspace
 * is the project repo itself. We synthesize one self-entry so every downstream
 * multi-repo consumer (git fan-out, discovery, doctor, …) operates over the one
 * repo with no special-casing.
 */
export function resolveRepos(opts: ResolveOpts): ResolvedRepo[] {
  if (opts.project.standalone === true || !opts.project.repositories) {
    return [
      {
        name: opts.project.name,
        url: '',
        dir: path.resolve(opts.projectRepoPath),
        branch: opts.project.git?.default_branch,
        tag: undefined,
        commit: undefined,
        shallow: opts.project.git?.shallow,
        submodules: opts.project.git?.submodules,
        optional: false,
        isProjectRepo: true,
      },
    ];
  }

  const list = opts.project.repositories;
  const repos: ResolvedRepo[] = [];
  const seen = new Set<string>();
  for (const entry of list) {
    const normalized = typeof entry === 'string' ? ({ name: entry } as ProjectRepoEntry) : entry;
    const name = normalized.name;
    if (!name) throw new ManifestError(`Project repository entry is missing a name.`);
    if (seen.has(name)) {
      throw new ManifestError(`Duplicate repository name in project manifest: '${name}'.`);
    }
    seen.add(name);

    const dir = normalized.path
      ? path.isAbsolute(normalized.path)
        ? normalized.path
        : path.resolve(opts.workspaceRoot, normalized.path)
      : path.join(opts.workspaceRoot, `${name}.git`);

    const url = deriveCloneUrl({
      explicitUrl: normalized.url,
      rootUrl: opts.project.git?.root_url,
      repoPrefix: opts.project.git?.repo_prefix,
      name,
    });

    repos.push({
      name,
      url,
      dir,
      branch: normalized.branch ?? opts.project.git?.default_branch,
      tag: normalized.tag,
      commit: normalized.commit,
      shallow: normalized.shallow ?? opts.project.git?.shallow,
      submodules: normalized.submodules ?? opts.project.git?.submodules,
      optional: Boolean(normalized.optional),
      isProjectRepo: path.resolve(dir) === path.resolve(opts.projectRepoPath),
    });
  }
  return repos;
}
