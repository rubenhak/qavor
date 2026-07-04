import path from 'node:path';
import type { Command } from 'commander';
import { emit, emitJson } from '../../util/logger.js';
import { discoverRepos } from '../../workspace/discover.js';
import { resolveWorkspace } from '../../workspace/locate.js';
import { inheritRootOptions, resolveExecutionPlan } from '../options.js';

export function registerDiscover(program: Command): void {
  program
    .command('discover')
    .description(
      'Multi-repo: scan git repos at the workspace root and register them in the project manifest. Single-repo: scan sub-directories for runnable apps. A service qavor.yaml is scaffolded only into dirs that ship a Dockerfile.',
    )
    .option('--dry-run', 'Report what would change without writing any files.')
    .action(async (opts: { dryRun?: boolean }, cmd: Command) => {
      const root = inheritRootOptions(cmd);
      const dryRun = Boolean(opts.dryRun);
      const ws = await resolveWorkspace();
      const single = ws.layout === 'single';
      const unit = single ? 'service' : 'repo';
      const where = single ? 'in the repo' : 'at the workspace root';
      const plan = resolveExecutionPlan(root, 'parallel');
      const result = await discoverRepos({ workspace: ws, dryRun, concurrency: plan.concurrency });

      if (root.json) {
        emitJson({
          ok: true,
          dryRun,
          projectManifest: result.projectManifestFile,
          projectUpdated: result.projectUpdated,
          repos: result.repos.map((r) => ({
            name: r.name,
            dir: r.dir,
            manifestCreated: r.manifestCreated,
            referenceAdded: r.referenceAdded,
          })),
        });
        return;
      }

      if (result.repos.length === 0) {
        emit(`No ${single ? 'runnable apps' : 'git repos'} found ${where}.`);
        return;
      }

      const referenced = result.repos.filter((r) => r.referenceAdded).length;
      emit(`Discovered ${result.repos.length} ${unit}(s) ${where}${dryRun ? ' (dry run)' : ''}:`);
      for (const r of result.repos) {
        const marks: string[] = [];
        if (r.manifestCreated)
          marks.push(
            dryRun ? 'would scaffold service qavor.yaml' : 'scaffolded service qavor.yaml',
          );
        if (r.referenceAdded) marks.push(dryRun ? 'would add to project' : 'added to project');
        if (marks.length === 0) marks.push('up to date');
        emit(`  ${r.name.padEnd(24)} ${marks.join(', ')}`);
      }
      if (!single) {
        const rel = path.relative(ws.paths.root, result.projectManifestFile);
        if (result.projectUpdated) {
          emit(
            dryRun
              ? `Would update ${referenced} reference(s) in ${rel}.`
              : `Updated ${rel} (+${referenced} reference(s)).`,
          );
        } else {
          emit(`Project manifest ${rel} unchanged.`);
        }
      }
    });
}
