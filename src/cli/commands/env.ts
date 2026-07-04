import type { Command } from 'commander';
import { composeServiceEnv, parseCliEnv } from '../../env/composer.js';
import { buildWorkspaceRegistry, reportRegistryIssues } from '../../manifest/discovery.js';
import { type LoadedDocument, loadManifestFile } from '../../manifest/loader.js';
import type { ProjectManifest, ServiceManifest } from '../../manifest/types/index.js';
import { resolveJobs } from '../../util/concurrency.js';
import { ManifestError, UserError } from '../../util/exit-codes.js';
import { emit, emitJson } from '../../util/logger.js';
import { readProjectManifest, resolveWorkspace } from '../../workspace/locate.js';
import { resolveRepos } from '../../workspace/repos.js';
import { inheritRootOptions } from '../options.js';

export function registerEnv(program: Command): void {
  program
    .command('env')
    .description('Print the fully-resolved environment for a service, with provenance per key.')
    .argument('<service>', 'Service name.')
    .option('--mode <mode>', 'native | docker (default: native).', 'native')
    .option('--env <kv...>', 'Layer KEY=VAL on top of the composed env.')
    .action(async (service: string, opts: { mode: string; env?: string[] }, cmd: Command) => {
      const root = inheritRootOptions(cmd);
      const mode = opts.mode === 'docker' ? 'docker' : 'native';
      if (opts.mode !== 'native' && opts.mode !== 'docker') {
        throw new UserError(`--mode must be 'native' or 'docker'.`);
      }
      const ws = await resolveWorkspace();
      const projectDoc = await readProjectManifest(ws.projectManifestFile);
      const repos = resolveRepos({
        workspaceRoot: ws.paths.root,
        project: projectDoc.data as unknown as ProjectManifest,
        projectRepoPath: ws.projectRepoPath,
      });
      const repoMap = new Map(repos.map((r) => [r.name, r.dir]));
      repoMap.set('__project__', ws.projectRepoPath);
      const registry = await buildWorkspaceRegistry({
        workspaceRoot: ws.paths.root,
        repos: repoMap,
        concurrency: resolveJobs(root.jobs),
        offline: root.offline,
        refresh: root.refresh,
      });
      if (reportRegistryIssues(registry.issues)) {
        throw new ManifestError(
          `Workspace has ${registry.issues.length} manifest issue(s); fix them before resolving env.`,
        );
      }
      const entry = registry.entries.find((e) => e.kind === 'service' && e.name === service);
      if (!entry) throw new UserError(`Service '${service}' not found in workspace.`);

      const docs = await loadManifestFile(entry.file);
      const serviceDoc = docs[entry.docIndex] as LoadedDocument;
      const cliEnv = opts.env ? parseCliEnv(opts.env) : undefined;
      const composeOpts: Parameters<typeof composeServiceEnv>[0] = {
        mode,
        serviceDoc,
        service: entry.data as unknown as ServiceManifest,
        workspaceRoot: ws.paths.root,
      };
      if (cliEnv) composeOpts.cliEnv = cliEnv;
      const resolved = await composeServiceEnv(composeOpts);

      if (root.json) {
        emitJson({
          service,
          mode,
          issues: resolved.issues,
          env: [...resolved.values].map(([k, v]) => ({
            key: k,
            value: v.secret ? '<redacted>' : v.value,
            secret: v.secret,
            required: v.required,
            provenance: v.provenance.map((p) => ({
              file: p.file,
              line: p.line,
              layer: p.layer,
              raw: v.secret ? '<redacted>' : p.raw,
            })),
          })),
        });
        return;
      }

      if (resolved.issues.length > 0) {
        emit('Issues:');
        for (const i of resolved.issues) emit(`  ${i.file}:${i.line}: ${i.message}`);
        emit('');
      }
      emit(`Resolved environment for ${service} (mode=${mode}):`);
      for (const [k, v] of resolved.values) {
        const printed = v.secret ? '<redacted>' : v.value;
        emit(`  ${k} = ${printed}`);
        for (const p of v.provenance) {
          const rawPrinted = v.secret ? '<redacted>' : p.raw;
          emit(`    via ${p.layer} (${p.file}:${p.line}) = ${rawPrinted}`);
        }
      }
    });
}
