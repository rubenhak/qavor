import type { Command } from 'commander';
import { parseCliEnv } from '../../env/composer.js';
import { buildWorkspaceRegistry, reportRegistryIssues } from '../../manifest/discovery.js';
import type { LoadedDocument } from '../../manifest/loader.js';
import { loadManifestFile } from '../../manifest/loader.js';
import type { ProjectManifest, ServiceManifest } from '../../manifest/types/index.js';
import { prepareService } from '../../prepare/prepare.js';
import { runFanOut } from '../../util/concurrency.js';
import { RuntimeFailure, UserError } from '../../util/exit-codes.js';
import { emitJson, getLogger } from '../../util/logger.js';
import { readProjectManifest, resolveWorkspace } from '../../workspace/locate.js';
import { resolveRepos } from '../../workspace/repos.js';
import { inheritRootOptions, resolveExecutionPlan } from '../options.js';
import { createPrepareView, type PrepareRow } from './prepare-view.js';

export function registerPrepare(program: Command): void {
  program
    .command('prepare')
    .description('Run `runtime.native.prepare` for every selected service.')
    .option('--only <name...>', 'Limit to specific service names.')
    .option('--env <kv...>', 'Override env values, KEY=VAL.')
    .action(async (opts: { only?: string[]; env?: string[] }, cmd: Command) => {
      const root = inheritRootOptions(cmd);
      const plan = resolveExecutionPlan(root, 'parallel');
      const logger = getLogger();
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
        concurrency: plan.concurrency,
      });

      reportRegistryIssues(registry.issues);

      let services = registry.entries.filter((e) => e.kind === 'service');
      if (opts.only && opts.only.length > 0) {
        const set = new Set(opts.only);
        services = services.filter((s) => set.has(s.name));
        const missing = [...set].filter((n) => !services.some((s) => s.name === n));
        if (missing.length > 0) {
          throw new UserError(`Unknown service(s): ${missing.join(', ')}`);
        }
      }

      const cliEnv = opts.env ? parseCliEnv(opts.env) : undefined;

      // Live table on stdout: one row per service, each pending with a spinner
      // until its prepare resolves. Auto-disabled for --json, non-TTY, and
      // --verbose (where the prepare command's raw output shares the terminal);
      // those fall back to a single static render in `finish`.
      const view = createPrepareView(
        services.map((s) => s.name),
        { enabled: !root.json && !root.verbose },
      );
      const rows = await runFanOut(
        services,
        async (entry, index): Promise<PrepareRow> => {
          const docs = await loadManifestFile(entry.file);
          const serviceDoc = docs[entry.docIndex] as LoadedDocument;
          const service = entry.data as unknown as ServiceManifest;
          const prepareOpts: Parameters<typeof prepareService>[0] = {
            paths: ws.paths,
            serviceDoc,
            service,
            logger,
            verbose: root.verbose,
            serial: plan.mode === 'serial',
          };
          if (cliEnv) prepareOpts.cliEnv = cliEnv;
          let row: PrepareRow;
          try {
            const res = await prepareService(prepareOpts);
            row =
              res.status === 'ok'
                ? { service: res.serviceName, outcome: 'ran', status: 'prepared' }
                : {
                    service: res.serviceName,
                    outcome: 'skip',
                    status: 'no prepare',
                    detail: 'no prepare command',
                  };
          } catch (err) {
            row = {
              service: entry.name,
              outcome: 'fail',
              status: 'failed',
              detail: err instanceof Error ? err.message : String(err),
            };
          }
          view.resolve(index, row);
          return row;
        },
        plan,
      );

      if (root.json) {
        // Preserve the machine contract: `serviceName` plus the underlying
        // `ok` / `no-prepare-cmd` status, with `failed` for errored services.
        emitJson({
          results: rows.map((r) => ({
            serviceName: r.service,
            status: r.outcome === 'ran' ? 'ok' : r.outcome === 'skip' ? 'no-prepare-cmd' : 'failed',
            ...(r.outcome === 'fail' && r.detail ? { error: r.detail } : {}),
          })),
        });
      } else {
        view.finish();
      }
      if (rows.some((r) => r.outcome === 'fail')) {
        throw new RuntimeFailure('Some services failed to prepare.');
      }
    });
}
