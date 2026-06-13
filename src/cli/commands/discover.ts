import path from 'node:path';
import type { Command } from 'commander';
import { resolveJobs } from '../../util/concurrency.js';
import { emit, emitJson } from '../../util/logger.js';
import { discoverRepos } from '../../workspace/discover.js';
import { resolveWorkspace } from '../../workspace/locate.js';
import { inheritRootOptions } from '../options.js';

export function registerDiscover(program: Command): void {
  program
    .command('discover')
    .description(
      'Scan git repos at the workspace root, scaffold a default service qavor.yaml in each, and register them in the project manifest.',
    )
    .option('--dry-run', 'Report what would change without writing any files.')
    .action(async (opts: { dryRun?: boolean }, cmd: Command) => {
      const root = inheritRootOptions(cmd);
      const dryRun = Boolean(opts.dryRun);
      const ws = await resolveWorkspace();
      const jobs = resolveJobs(root.jobs);
      const result = await discoverRepos({ workspace: ws, dryRun, concurrency: jobs });

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
        emit('No git repos found at the workspace root.');
        return;
      }

      const referenced = result.repos.filter((r) => r.referenceAdded).length;
      emit(
        `Discovered ${result.repos.length} repo(s) at the workspace root${dryRun ? ' (dry run)' : ''}:`,
      );
      for (const r of result.repos) {
        const marks: string[] = [];
        if (r.manifestCreated)
          marks.push(dryRun ? 'would scaffold qavor.yaml' : 'scaffolded qavor.yaml');
        if (r.referenceAdded) marks.push(dryRun ? 'would add to project' : 'added to project');
        if (marks.length === 0) marks.push('up to date');
        emit(`  ${r.name.padEnd(24)} ${marks.join(', ')}`);
      }
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
    });
}
