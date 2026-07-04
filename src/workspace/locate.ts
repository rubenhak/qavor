import path from 'node:path';
import { loadManifestFile } from '../manifest/loader.js';
import { UserError } from '../util/exit-codes.js';
import { isDirectory, isFile } from '../util/fs.js';
import { type WorkspacePaths, workspacePaths } from './paths.js';
import { ensureRepoGitignoresState, ensureStateDirs, writeWorkspaceMeta } from './scaffold.js';

export type WorkspaceLayout = 'single' | 'multi';

export interface ResolvedWorkspace {
  paths: WorkspacePaths;
  /** Absolute path to the project repo containing the kind: project manifest. */
  projectRepoPath: string;
  /** Path to project manifest file (absolute). */
  projectManifestFile: string;
  /**
   * `multi` — a classic multi-repo workspace located via a `kind: workspaces`
   * pointer. `single` — a standalone single-repo project where the repo itself
   * is the workspace root (no pointer file).
   */
  layout: WorkspaceLayout;
}

/** A `kind: project` manifest found while walking up, with its standalone flag. */
interface FoundProject {
  /** Directory holding the `qavor.yaml`. */
  dir: string;
  standalone: boolean;
}

/**
 * Walk up from `start` looking for a qavor.yaml whose top-level doc is
 * `kind: workspaces`. Returns null if nothing is found before the filesystem
 * root.
 */
export async function findWorkspaceRoot(start: string): Promise<string | null> {
  let cur = path.resolve(start);
  // Walk up
  // Add a hard cap to avoid pathological symlink loops.
  for (let i = 0; i < 64; i++) {
    const candidate = path.join(cur, 'qavor.yaml');
    if (await isFile(candidate)) {
      try {
        const docs = await loadManifestFile(candidate, { throwOnParseError: false });
        if (docs.some((d) => d.kind === 'workspaces')) return cur;
      } catch {
        // not a workspaces manifest; keep walking up
      }
    }
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
  return null;
}

/**
 * Walk up from `start` looking for a `qavor.yaml` whose top-level doc is
 * `kind: project`. Returns the directory and whether that project declares
 * itself `standalone` (a single-repo project). Returns null if nothing is
 * found before the filesystem root.
 */
export async function findProjectRoot(start: string): Promise<FoundProject | null> {
  let cur = path.resolve(start);
  for (let i = 0; i < 64; i++) {
    const candidate = path.join(cur, 'qavor.yaml');
    if (await isFile(candidate)) {
      try {
        const docs = await loadManifestFile(candidate, { throwOnParseError: false });
        const project = docs.find((d) => d.kind === 'project');
        if (project) {
          const standalone = (project.data as { standalone?: unknown }).standalone === true;
          return { dir: cur, standalone };
        }
      } catch {
        // not a readable project manifest; keep walking up
      }
    }
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
  return null;
}

/**
 * Resolve the workspace for the given starting directory. Two layouts:
 *
 *   - `multi` — located via a `kind: workspaces` pointer file (created by
 *     `qavor init`); the pointer names the project repo.
 *   - `single` — a standalone (`standalone: true`) `kind: project` at a repo
 *     root, with no pointer above it. The repo is its own workspace root and
 *     the `.qavor/` state dir is bootstrapped inside it on first resolve.
 *
 * Throws UserError when no workspace is found.
 */
export async function resolveWorkspace(start: string = process.cwd()): Promise<ResolvedWorkspace> {
  const root = await findWorkspaceRoot(start);
  if (root) return resolveMultiRepo(root);

  // No pointer found — check for a standalone single-repo project at/above cwd.
  const project = await findProjectRoot(start);
  if (project?.standalone) return resolveSingleRepo(project.dir);
  if (project) {
    throw new UserError(
      `Found a multi-repo project manifest at ${path.join(project.dir, 'qavor.yaml')} but no ` +
        `\`kind: workspaces\` pointer above it. Run \`qavor init ${project.dir}\` to bootstrap the ` +
        `workspace, or set \`standalone: true\` for a single-repo project.`,
    );
  }
  throw new UserError(
    `No qavor workspace found searching upward from ${start}. Run \`qavor init <project-repo-source>\` first.`,
  );
}

async function resolveMultiRepo(root: string): Promise<ResolvedWorkspace> {
  const paths = workspacePaths(root);
  const docs = await loadManifestFile(paths.workspacesFile);
  const workspaceDoc = docs.find((d) => d.kind === 'workspaces');
  if (!workspaceDoc) {
    throw new UserError(
      `Workspace pointer at ${paths.workspacesFile} has no \`kind: workspaces\` document.`,
    );
  }
  const rootProjectPath = (workspaceDoc.data as { root_project_path?: unknown }).root_project_path;
  if (typeof rootProjectPath !== 'string' || rootProjectPath.length === 0) {
    throw new UserError(
      `Workspace pointer at ${paths.workspacesFile} is missing \`root_project_path\`.`,
    );
  }
  const projectRepoPath = path.isAbsolute(rootProjectPath)
    ? rootProjectPath
    : path.resolve(paths.root, rootProjectPath);
  const projectManifestFile = path.join(projectRepoPath, 'qavor.yaml');
  return { paths, projectRepoPath, projectManifestFile, layout: 'multi' };
}

async function resolveSingleRepo(repoRoot: string): Promise<ResolvedWorkspace> {
  const paths = workspacePaths(repoRoot);
  const projectManifestFile = path.join(repoRoot, 'qavor.yaml');
  // Lazy, idempotent bootstrap: create the in-repo `.qavor/` state dir the
  // first time we resolve, so single-repo projects need no explicit init.
  if (!(await isDirectory(paths.stateRoot))) {
    await ensureStateDirs(paths);
    await ensureRepoGitignoresState(repoRoot);
    const project = await readProjectManifest(projectManifestFile);
    const name =
      typeof project.data.name === 'string' ? project.data.name : path.basename(repoRoot);
    await writeWorkspaceMeta(paths, {
      projectName: name,
      projectRepoPath: repoRoot,
      manifestFile: projectManifestFile,
      layout: 'single-repo',
    });
  }
  return { paths, projectRepoPath: repoRoot, projectManifestFile, layout: 'single' };
}

export async function readProjectManifest(projectManifestFile: string): Promise<{
  data: Record<string, unknown>;
}> {
  const docs = await loadManifestFile(projectManifestFile);
  const project = docs.find((d) => d.kind === 'project');
  if (!project) {
    throw new UserError(`No \`kind: project\` document found in ${projectManifestFile}.`);
  }
  return { data: project.data };
}
