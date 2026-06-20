import type { Command } from 'commander';
import { parseCliEnv } from '../../env/composer.js';
import { buildWorkspaceRegistry, reportRegistryIssues } from '../../manifest/discovery.js';
import type { LoadedDocument } from '../../manifest/loader.js';
import { loadManifestFile } from '../../manifest/loader.js';
import type { ProjectManifest, ServiceManifest } from '../../manifest/types/index.js';
import { prepareService } from '../../prepare/prepare.js';
import { runFanOut } from '../../util/concurrency.js';
import { UserError } from '../../util/exit-codes.js';
import { emit, emitJson, getLogger } from '../../util/logger.js';
import { readProjectManifest, resolveWorkspace } from '../../workspace/locate.js';
import { resolveRepos } from '../../workspace/repos.js';
import { inheritRootOptions, resolveExecutionPlan } from '../options.js';

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

      const results = await runFanOut(
        services,
        async (entry) => {
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
          return prepareService(prepareOpts);
        },
        plan,
      );

      if (root.json) {
        emitJson({ results });
        return;
      }
      for (const r of results) {
        emit(`${r.status.padEnd(15)} ${r.serviceName}`);
      }
    });
}
