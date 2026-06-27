import {
  buildWorkspaceRegistry,
  type RegistryEntry,
  type WorkspaceRegistry,
} from '../manifest/discovery.js';
import type { ProjectManifest } from '../manifest/types/index.js';
import { resolveJobs } from '../util/concurrency.js';
import {
  type ResolvedWorkspace,
  readProjectManifest,
  resolveWorkspace,
} from '../workspace/locate.js';
import { resolveRepos } from '../workspace/repos.js';

export interface ServicesContext {
  ws: ResolvedWorkspace;
  registry: WorkspaceRegistry;
  /** Service entries from the registry (profiles flattened in). */
  services: RegistryEntry[];
}

let cached: Promise<ServicesContext> | null = null;

/**
 * Resolve the workspace, build the manifest registry, and pick out the service
 * entries. Memoized per process so the dynamic-command startup discovery and the
 * command's own action share a single registry build instead of scanning the
 * workspace twice. A fresh CLI process always starts with an empty cache.
 */
export function loadServicesContext(opts: { concurrency?: number } = {}): Promise<ServicesContext> {
  cached ??= build(opts.concurrency);
  return cached;
}

async function build(concurrency?: number): Promise<ServicesContext> {
  const ws = await resolveWorkspace();
  const projectDoc = await readProjectManifest(ws.projectManifestFile);
  const allRepos = resolveRepos({
    workspaceRoot: ws.paths.root,
    project: projectDoc.data as unknown as ProjectManifest,
    projectRepoPath: ws.projectRepoPath,
  });
  const repoMap = new Map(allRepos.map((r) => [r.name, r.dir]));
  repoMap.set('__project__', ws.projectRepoPath);
  const registry = await buildWorkspaceRegistry({
    workspaceRoot: ws.paths.root,
    repos: repoMap,
    concurrency: concurrency ?? resolveJobs(undefined),
  });
  const services = registry.entries.filter((e) => e.kind === 'service');
  return { ws, registry, services };
}
