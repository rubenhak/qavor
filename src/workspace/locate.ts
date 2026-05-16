import fs from 'node:fs/promises';
import path from 'node:path';
import { loadManifestFile } from '../manifest/loader.js';
import { UserError } from '../util/exit-codes.js';
import { isFile } from '../util/fs.js';
import { type WorkspacePaths, workspacePaths } from './paths.js';

export interface ResolvedWorkspace {
  paths: WorkspacePaths;
  /** Absolute path to the project repo containing the kind: project manifest. */
  projectRepoPath: string;
  /** Path to project manifest file (absolute). */
  projectManifestFile: string;
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
 * Resolve and load the workspace pointer for the given starting directory.
 * Throws UserError when no workspace is found.
 */
export async function resolveWorkspace(start: string = process.cwd()): Promise<ResolvedWorkspace> {
  const root = await findWorkspaceRoot(start);
  if (!root) {
    throw new UserError(
      `No qavor workspace found searching upward from ${start}. Run \`qavor init <project-repo-source>\` first.`,
    );
  }
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
  return { paths, projectRepoPath, projectManifestFile };
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

/** Ensure a directory + file are present. Useful in startup paths. */
export async function ensureWorkspaceDirs(paths: WorkspacePaths): Promise<void> {
  await fs.mkdir(paths.stateRoot, { recursive: true });
  await fs.mkdir(paths.stateDir, { recursive: true });
  await fs.mkdir(paths.logsDir, { recursive: true });
  await fs.mkdir(paths.composeDir, { recursive: true });
  await fs.mkdir(paths.cacheDir, { recursive: true });
}
