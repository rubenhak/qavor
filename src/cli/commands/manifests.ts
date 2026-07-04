import path from 'node:path';
import type { Command } from 'commander';
import {
  buildWorkspaceRegistry,
  type RegistryEntry,
  type WorkspaceRegistry,
} from '../../manifest/discovery.js';
import type { ManifestKind, ProjectManifest } from '../../manifest/types/index.js';
import { resolveJobs } from '../../util/concurrency.js';
import { isDirectory } from '../../util/fs.js';
import { emit, emitJson, getLogger } from '../../util/logger.js';
import { colorEnabled, type Palette, palette } from '../../util/style.js';
import { readProjectManifest, resolveWorkspace } from '../../workspace/locate.js';
import { resolveRepos } from '../../workspace/repos.js';
import { inheritRootOptions } from '../options.js';

/** Sentinel repo key for the project repo when it is not listed in `repositories:`. */
const PROJECT_KEY = '__project__';

interface KindStyle {
  emoji: string;
  /** Kind label colorizer. */
  color: (p: Palette) => (s: string) => string;
}

const KIND_STYLES: Record<ManifestKind, KindStyle> = {
  workspaces: { emoji: '🗂 ', color: (p) => p.cyan },
  project: { emoji: '🧭', color: (p) => p.magenta },
  service: { emoji: '🚀', color: (p) => p.green },
  profile: { emoji: '🎚 ', color: (p) => p.blue },
};

interface RepoNode {
  /** Display name for the repo. */
  name: string;
  /** Absolute repo directory. */
  dir: string;
  isProject: boolean;
  cloned: boolean;
  /** Manifest files keyed by absolute path, each holding its documents in order. */
  files: { file: string; entries: RegistryEntry[] }[];
}

export function registerManifests(program: Command): void {
  program
    .command('manifests')
    .description('Print the hierarchy of qavor manifests discovered across the workspace.')
    .action(async (_opts: unknown, cmd: Command) => {
      const root = inheritRootOptions(cmd);
      const logger = getLogger();
      const jobs = resolveJobs(root.jobs);

      const ws = await resolveWorkspace();
      const projectDoc = await readProjectManifest(ws.projectManifestFile);
      const project = projectDoc.data as unknown as ProjectManifest;
      const repos = resolveRepos({
        workspaceRoot: ws.paths.root,
        project,
        projectRepoPath: ws.projectRepoPath,
      });

      const repoMap = new Map<string, string>();
      for (const r of repos) repoMap.set(r.name, r.dir);
      // Discover the project repo's own manifests even when it is not listed in
      // `repositories:`. Skip the extra entry if a listed repo already points at it,
      // to avoid scanning the same directory twice.
      const projectListed = repos.some((r) => r.isProjectRepo);
      if (!projectListed) repoMap.set(PROJECT_KEY, ws.projectRepoPath);

      const registry = await buildWorkspaceRegistry({
        workspaceRoot: ws.paths.root,
        repos: repoMap,
        concurrency: jobs,
        offline: root.offline,
        refresh: root.refresh,
      });

      const repoNodes = await buildRepoNodes({ repoMap, repos, registry, ws });

      if (root.json) {
        emitJson({
          workspace_root: ws.paths.root,
          workspaces_file: ws.paths.workspacesFile,
          project_name: typeof project.name === 'string' ? project.name : null,
          repos: repoNodes.map((r) => ({
            name: r.name,
            dir: r.dir,
            is_project_repo: r.isProject,
            cloned: r.cloned,
            files: r.files.map((f) => ({
              file: f.file,
              manifests: f.entries.map((e) => manifestInfo(e)),
            })),
          })),
          issues: registry.issues,
        });
        return;
      }

      renderTree(repoNodes, ws, typeof project.name === 'string' ? project.name : null);

      if (registry.issues.length > 0) {
        const c = palette(colorEnabled());
        emit('');
        emit(c.yellow(`⚠ ${registry.issues.length} manifest issue(s) found:`));
        for (const issue of registry.issues) {
          const loc = c.dim(
            `${path.relative(ws.paths.root, issue.file)}:${issue.line}:${issue.column}`,
          );
          const kind = c.dim(`[${issue.kind}]`);
          const where = issue.path ? c.dim(` ${issue.path}:`) : '';
          emit(`  ${c.red('✗')} ${loc} ${kind}${where} ${issue.message}`);
        }
      }
      logger.debug({ repos: repoNodes.length }, 'manifests rendered');
    });
}

/** Build per-repo grouping of manifest entries, project repo first. */
async function buildRepoNodes(args: {
  repoMap: Map<string, string>;
  repos: ReturnType<typeof resolveRepos>;
  registry: WorkspaceRegistry;
  ws: Awaited<ReturnType<typeof resolveWorkspace>>;
}): Promise<RepoNode[]> {
  const { repoMap, repos, registry, ws } = args;
  const byRepo = new Map<string, RegistryEntry[]>();
  for (const entry of registry.entries) {
    const key = entry.repo ?? PROJECT_KEY;
    const list = byRepo.get(key);
    if (list) list.push(entry);
    else byRepo.set(key, [entry]);
  }

  const projectRepoName = repos.find((r) => r.isProjectRepo)?.name;
  const nodes: RepoNode[] = [];
  for (const [key, dir] of repoMap) {
    const isProject = key === PROJECT_KEY || key === projectRepoName;
    const entries = byRepo.get(key) ?? [];
    // Group entries by file, preserving discovery (sorted) order.
    const fileOrder: string[] = [];
    const fileGroups = new Map<string, RegistryEntry[]>();
    for (const e of entries) {
      const g = fileGroups.get(e.file);
      if (g) g.push(e);
      else {
        fileGroups.set(e.file, [e]);
        fileOrder.push(e.file);
      }
    }
    for (const list of fileGroups.values()) list.sort((a, b) => a.docIndex - b.docIndex);

    nodes.push({
      name: key === PROJECT_KEY ? path.basename(ws.projectRepoPath) : key,
      dir,
      isProject,
      cloned: await isDirectory(dir),
      files: fileOrder.map((file) => ({ file, entries: fileGroups.get(file) ?? [] })),
    });
  }

  // Project repo first, then the rest alphabetically by display name.
  nodes.sort((a, b) => {
    if (a.isProject !== b.isProject) return a.isProject ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return nodes;
}

interface ManifestInfo {
  kind: ManifestKind;
  name: string;
  description?: string;
  /** Compact detail bits (mode, dep counts, repo counts, …). */
  details: string[];
}

function manifestInfo(entry: RegistryEntry): ManifestInfo {
  const data = entry.data as Record<string, unknown>;
  const details: string[] = [];
  switch (entry.kind) {
    case 'project': {
      const repos = Array.isArray(data.repositories) ? data.repositories.length : 0;
      details.push(`${repos} repo${repos === 1 ? '' : 's'}`);
      break;
    }
    case 'service': {
      details.push(typeof data.mode === 'string' ? data.mode : 'native');
      const reqs = Array.isArray(data.require) ? data.require.length : 0;
      if (reqs > 0) details.push(`${reqs} dep${reqs === 1 ? '' : 's'}`);
      const profiles = Array.isArray(data.profiles) ? data.profiles.length : 0;
      if (profiles > 0) details.push(`${profiles} profile${profiles === 1 ? '' : 's'}`);
      const publishes = (data as { env?: { publish?: Record<string, unknown> } }).env?.publish;
      if (publishes && typeof publishes === 'object') {
        const n = Object.keys(publishes).length;
        if (n > 0) details.push(`publishes ${n}`);
      }
      break;
    }
    case 'profile': {
      if (typeof data.mode === 'string') details.push(data.mode);
      break;
    }
    default:
      break;
  }
  const info: ManifestInfo = { kind: entry.kind, name: entry.name, details };
  if (typeof data.description === 'string' && data.description.length > 0) {
    info.description = data.description;
  }
  return info;
}

const TREE = {
  unicode: { branch: '├─ ', last: '└─ ', vert: '│  ', space: '   ' },
  ascii: { branch: '|- ', last: '`- ', vert: '|  ', space: '   ' },
};

function renderTree(
  nodes: RepoNode[],
  ws: Awaited<ReturnType<typeof resolveWorkspace>>,
  projectName: string | null,
): void {
  const unicode = colorEnabled();
  const c = palette(colorEnabled());
  const g = unicode ? TREE.unicode : TREE.ascii;
  const treeGlyph = unicode ? '🌳 ' : '';

  emit(`${treeGlyph}${c.bold(c.cyan(projectName ?? '<workspace>'))}`);
  emit(`   ${c.dim(ws.paths.root)}`);
  emit(`   ${c.dim(`pointer: ${path.relative(ws.paths.root, ws.paths.workspacesFile)}`)}`);

  nodes.forEach((repo, ri) => {
    const lastRepo = ri === nodes.length - 1;
    const repoConn = lastRepo ? g.last : g.branch;
    const repoPrefix = lastRepo ? g.space : g.vert;
    const folder = unicode ? '📁 ' : '';
    const tags: string[] = [];
    if (repo.isProject) tags.push(c.magenta('project repo'));
    if (!repo.cloned) tags.push(c.red('not cloned'));
    const tagStr = tags.length > 0 ? ` ${c.dim('(')}${tags.join(c.dim(', '))}${c.dim(')')}` : '';
    emit(`${repoConn}${folder}${c.bold(repo.name)}${tagStr}`);

    if (repo.files.length === 0) {
      emit(`${repoPrefix}${g.last}${c.dim(repo.cloned ? '(no manifests)' : '(not cloned)')}`);
      return;
    }

    repo.files.forEach((f, fi) => {
      const lastFile = fi === repo.files.length - 1;
      const fileConn = lastFile ? g.last : g.branch;
      const filePrefix = repoPrefix + (lastFile ? g.space : g.vert);
      const rel = path.relative(repo.dir, f.file) || path.basename(f.file);
      const doc = unicode ? '📄 ' : '';
      emit(`${repoPrefix}${fileConn}${doc}${c.dim(rel)}`);

      f.entries.forEach((entry, ei) => {
        const lastEntry = ei === f.entries.length - 1;
        const entryConn = lastEntry ? g.last : g.branch;
        emit(`${filePrefix}${entryConn}${formatManifest(entry, c, unicode)}`);
      });
    });
  });
}

function formatManifest(entry: RegistryEntry, c: Palette, unicode: boolean): string {
  const info = manifestInfo(entry);
  const style = KIND_STYLES[info.kind];
  const emoji = unicode ? `${style.emoji.trimEnd()} ` : '';
  const kindLabel = style.color(c)(c.bold(info.kind));
  const name = info.name ? ` ${c.bold(info.name)}` : ` ${c.dim('<unnamed>')}`;
  let line = `${emoji}${kindLabel}${name}`;
  if (info.details.length > 0) line += `  ${c.dim(info.details.join(' · '))}`;
  if (info.description) line += `  ${c.gray(`— ${info.description}`)}`;
  return line;
}
