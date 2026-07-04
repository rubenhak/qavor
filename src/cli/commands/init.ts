import path from 'node:path';
import type { Command } from 'commander';
import { emit, emitJson, getLogger } from '../../util/logger.js';
import { initWorkspace } from '../../workspace/init.js';
import { inheritRootOptions } from '../options.js';

export function registerInit(program: Command): void {
  program
    .command('init')
    .description('Bootstrap a workspace from a project repo (local path or git URL).')
    .argument('<source>', 'Local path to a project repo, or a git URL.')
    .option('--into <dir>', 'Workspace root directory. Defaults to the current directory.')
    .action(async (source: string, opts: { into?: string }, cmd: Command) => {
      const root = inheritRootOptions(cmd);
      const logger = getLogger();
      const initOpts: Parameters<typeof initWorkspace>[0] = { source, logger };
      if (opts.into) initOpts.into = opts.into;
      const result = await initWorkspace(initOpts);
      const repoCount = result.project.repositories?.length ?? 0;
      if (root.json) {
        emitJson({
          ok: true,
          workspace: result.paths.root,
          layout: result.layout,
          project_name: result.project.name,
          project_repo_path: result.projectRepoPath,
          cloned_project: result.cloned,
          repositories: repoCount,
        });
      } else if (result.layout === 'single') {
        emit(`Single-repo workspace initialized at ${result.paths.root}`);
        emit(`  project: ${result.project.name}`);
        emit(`  next: qavor discover  (scaffold service manifests), then qavor up`);
      } else {
        emit(`Workspace initialized at ${result.paths.root}`);
        emit(`  project: ${result.project.name}`);
        emit(`  project repo: ${path.relative(result.paths.root, result.projectRepoPath)}`);
        emit(`  repositories declared: ${repoCount}`);
        emit(`  next: qavor clone`);
      }
    });
}
