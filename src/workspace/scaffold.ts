import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ensureDir, writeJsonFile } from '../util/fs.js';
import type { WorkspacePaths } from './paths.js';

const STATE_GITIGNORE = [
  '# qavor state directory — all files are generated. Do not commit.',
  '*',
  '!.gitignore',
  '',
].join('\n');

/** Create the `.qavor/` state directory tree and its self-ignoring `.gitignore`. */
export async function ensureStateDirs(paths: WorkspacePaths): Promise<void> {
  await ensureDir(paths.stateRoot);
  await ensureDir(paths.stateDir);
  await ensureDir(paths.logsDir);
  await ensureDir(paths.composeDir);
  await ensureDir(paths.cacheDir);
  await fs.writeFile(paths.stateGitignore, STATE_GITIGNORE);
}

export type WorkspaceLayout = 'single-repo' | 'multi-repo';

export interface WorkspaceMetaInput {
  projectName: string;
  projectRepoPath: string;
  /** Manifest file whose contents are hashed for change detection. */
  manifestFile: string;
  layout: WorkspaceLayout;
}

/** Write `.qavor/workspace.json` recording project identity and the workspace layout. */
export async function writeWorkspaceMeta(
  paths: WorkspacePaths,
  meta: WorkspaceMetaInput,
): Promise<void> {
  const manifestHash = createHash('sha256')
    .update(await fs.readFile(meta.manifestFile))
    .digest('hex');
  await writeJsonFile(paths.workspaceMetaFile, {
    project_name: meta.projectName,
    project_repo_path: meta.projectRepoPath,
    layout: meta.layout,
    manifest_hash: manifestHash,
    initialized_at: new Date().toISOString(),
  });
}

/**
 * For a single-repo workspace, the `.qavor/` state dir lives *inside* the repo.
 * Ensure the repo-root `.gitignore` ignores it so generated state is never
 * committed. Idempotent: appends `.qavor/` only when not already present.
 */
export async function ensureRepoGitignoresState(repoRoot: string): Promise<void> {
  const file = path.join(repoRoot, '.gitignore');
  let content = '';
  try {
    content = await fs.readFile(file, 'utf8');
  } catch {
    /* absent — will be created */
  }
  const ignored = content.split(/\r?\n/).some((l) => {
    const t = l.trim();
    return t === '.qavor' || t === '.qavor/';
  });
  if (ignored) return;
  const prefix = content.length > 0 && !content.endsWith('\n') ? '\n' : '';
  await fs.writeFile(file, `${content}${prefix}.qavor/\n`);
}
