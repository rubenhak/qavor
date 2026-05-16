import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { gitClone, isGitRepo } from '../git/git.js';
import { loadManifestFile } from '../manifest/loader.js';
import type { ProjectManifest } from '../manifest/types/index.js';
import { validateDocument } from '../manifest/validator.js';
import { ManifestError, UserError } from '../util/exit-codes.js';
import { ensureDir, globalCacheDir, isDirectory, writeJsonFile } from '../util/fs.js';
import type { Logger } from '../util/logger.js';
import { type WorkspacePaths, workspacePaths } from './paths.js';

export interface InitOptions {
  /** Project repo source: local path or git URL. */
  source: string;
  /** Workspace root override. Defaults to cwd. */
  into?: string;
  logger: Logger;
}

export interface InitResult {
  paths: WorkspacePaths;
  /** Absolute path to the project repo on disk. */
  projectRepoPath: string;
  /** Parsed project manifest body. */
  project: ProjectManifest;
  /** Whether init had to clone the project repo. */
  cloned: boolean;
}

const URL_RE = /^(?:git@[^:]+:|https?:\/\/|git:\/\/|ssh:\/\/|file:\/\/)/;

function looksLikeGitUrl(s: string): boolean {
  return URL_RE.test(s);
}

function projectRepoNameFromUrl(url: string): string {
  // strip query/fragments
  const cleaned = url.replace(/[?#].*$/, '');
  const last = cleaned.split('/').pop() ?? cleaned.split(':').pop() ?? 'project';
  return last.replace(/\.git$/, '');
}

/**
 * Idempotent. Implements `qavor init <project-repo-source> [--into <dir>]`
 * per ADR-004:
 *   1. Resolve the source as local path or URL.
 *   2. Ensure the workspace dir exists; default to cwd.
 *   3. Clone the project repo into <workspace>/<repo-name>.git/ if not
 *      already on disk.
 *   4. Read its `kind: project` manifest.
 *   5. Write <workspace>/qavor.yaml with `kind: workspaces` pointing at it.
 *   6. Initialize `.qavor/` and `workspace.json`.
 */
export async function initWorkspace(opts: InitOptions): Promise<InitResult> {
  const workspaceRoot = path.resolve(opts.into ?? process.cwd());
  await ensureDir(workspaceRoot);
  const paths = workspacePaths(workspaceRoot);

  let projectRepoPath: string;
  let cloned = false;

  if (looksLikeGitUrl(opts.source)) {
    const repoName = projectRepoNameFromUrl(opts.source);
    const target = path.join(workspaceRoot, `${repoName}.git`);
    if (await isDirectory(target)) {
      if (!(await isGitRepo(target))) {
        throw new UserError(
          `Cannot reuse ${target}: directory exists but is not a git repo. Move it aside and re-run.`,
        );
      }
      opts.logger.info({ target }, 'reusing existing project repo clone');
      projectRepoPath = target;
    } else {
      // Use a global cache to speed up repeat init calls.
      const cacheDir = path.join(globalCacheDir(), 'projects', urlHash(opts.source));
      await ensureDir(path.dirname(cacheDir));
      opts.logger.info({ url: opts.source, target }, 'cloning project repo');
      await gitClone({ url: opts.source, dest: target });
      // Also populate the cache marker so future tooling can locate it.
      try {
        await ensureDir(cacheDir);
        await fs.writeFile(
          path.join(cacheDir, 'source.json'),
          JSON.stringify(
            { url: opts.source, cloned_to: target, at: new Date().toISOString() },
            null,
            2,
          ),
        );
      } catch {
        /* non-fatal */
      }
      projectRepoPath = target;
      cloned = true;
    }
  } else {
    const localPath = path.resolve(opts.source);
    if (!(await isDirectory(localPath))) {
      throw new UserError(`Project repo source does not exist or is not a directory: ${localPath}`);
    }
    projectRepoPath = localPath;
  }

  // Read the project manifest.
  const projectManifestFile = path.join(projectRepoPath, 'qavor.yaml');
  const docs = await loadManifestFile(projectManifestFile);
  const projectDoc = docs.find((d) => d.kind === 'project');
  if (!projectDoc) {
    throw new ManifestError(
      `Project repo at ${projectRepoPath} is missing a \`kind: project\` document in qavor.yaml.`,
    );
  }
  const result = validateDocument(projectDoc);
  if (!result.ok) {
    const msg = result.issues
      .map((i) => `  ${i.file}:${i.line}:${i.column} ${i.path}: ${i.message}`)
      .join('\n');
    throw new ManifestError(`Invalid project manifest:\n${msg}`);
  }
  const project = projectDoc.data as unknown as ProjectManifest;

  // Initialize workspace state directory.
  await ensureDir(paths.stateRoot);
  await ensureDir(paths.stateDir);
  await ensureDir(paths.logsDir);
  await ensureDir(paths.composeDir);
  await ensureDir(paths.cacheDir);
  await fs.writeFile(
    paths.stateGitignore,
    [
      '# qavor state directory — all files are generated. Do not commit.',
      '*',
      '!.gitignore',
      '',
    ].join('\n'),
  );

  // Write the workspaces pointer (idempotent).
  const relProjectPath = `./${path.relative(workspaceRoot, projectRepoPath).split(path.sep).join('/')}`;
  const workspacesYaml = renderWorkspacesYaml(relProjectPath);
  await fs.writeFile(paths.workspacesFile, workspacesYaml, 'utf8');

  // Workspace meta.
  const manifestHash = createHash('sha256')
    .update(await fs.readFile(projectManifestFile))
    .digest('hex');
  await writeJsonFile(paths.workspaceMetaFile, {
    project_name: project.name,
    project_repo_path: projectRepoPath,
    manifest_hash: manifestHash,
    initialized_at: new Date().toISOString(),
  });

  return { paths, projectRepoPath, project, cloned };
}

function urlHash(url: string): string {
  return createHash('sha256').update(url).digest('hex').slice(0, 16);
}

function renderWorkspacesYaml(relProjectPath: string): string {
  return [
    '# Generated by `qavor init`. Points at the project repo whose',
    '# `kind: project` manifest enumerates the rest of the workspace.',
    'kind: workspaces',
    `root_project_path: ${relProjectPath}`,
    '',
  ].join('\n');
}
