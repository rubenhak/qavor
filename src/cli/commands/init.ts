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
      if (root.json) {
        emitJson({
          ok: true,
          workspace: result.paths.root,
          project_name: result.project.name,
          project_repo_path: result.projectRepoPath,
          cloned_project: result.cloned,
          repositories: result.project.repositories.length,
        });
      } else {
        emit(`Workspace initialized at ${result.paths.root}`);
        emit(`  project: ${result.project.name}`);
        emit(`  project repo: ${path.relative(result.paths.root, result.projectRepoPath)}`);
        emit(`  repositories declared: ${result.project.repositories.length}`);
        emit(`  next: qavor clone`);
      }
    });
}
