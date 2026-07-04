import path from 'node:path';
import type { Command } from 'commander';
import { parseCliEnv } from '../../env/composer.js';
import { buildWorkspaceRegistry, reportRegistryIssues } from '../../manifest/discovery.js';
import { type LoadedDocument, loadManifestFile } from '../../manifest/loader.js';
import type { ProjectManifest, ServiceManifest } from '../../manifest/types/index.js';
import { tailFile } from '../../supervisor/logs.js';
import {
  listServicesState,
  startNativeService,
  stopNativeService,
} from '../../supervisor/native.js';
import { resolveJobs } from '../../util/concurrency.js';
import { ManifestError, UserError } from '../../util/exit-codes.js';
import { emit, emitJson, getLogger } from '../../util/logger.js';
import { readProjectManifest, resolveWorkspace } from '../../workspace/locate.js';
import { resolveRepos } from '../../workspace/repos.js';
import { inheritRootOptions } from '../options.js';

async function findService(
  name: string,
  jobs: number,
  net: { offline: boolean; refresh: boolean } = { offline: false, refresh: false },
): Promise<{
  serviceDoc: LoadedDocument;
  service: ServiceManifest;
  paths: ReturnType<typeof import('../../workspace/paths.js').workspacePaths>;
  manifestDir: string;
}> {
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
    concurrency: jobs,
    offline: net.offline,
    refresh: net.refresh,
  });
  if (reportRegistryIssues(registry.issues)) {
    throw new ManifestError(
      `Workspace has ${registry.issues.length} manifest issue(s); fix them before running services.`,
    );
  }
  const entry = registry.entries.find((e) => e.kind === 'service' && e.name === name);
  if (!entry) throw new UserError(`Service '${name}' not found in workspace.`);
  const docs = await loadManifestFile(entry.file);
  const serviceDoc = docs[entry.docIndex] as LoadedDocument;
  return {
    serviceDoc,
    service: entry.data as unknown as ServiceManifest,
    paths: ws.paths,
    manifestDir: path.dirname(entry.file),
  };
}

export function registerRunCommands(program: Command): void {
  program
    .command('up')
    .description('Start a single service in native mode.')
    .argument('<service>')
    .option('--mode <mode>', 'native | docker (default native; docker is v1).', 'native')
    .option('--env <kv...>', 'KEY=VAL overrides.')
    .action(async (name: string, opts: { mode: string; env?: string[] }, cmd: Command) => {
      const root = inheritRootOptions(cmd);
      const logger = getLogger();
      if (opts.mode === 'docker') {
        throw new UserError(`--mode docker is deferred to v1.`);
      }
      const cliEnv = opts.env ? parseCliEnv(opts.env) : undefined;
      const jobs = resolveJobs(root.jobs);
      const ctx = await findService(name, jobs, { offline: root.offline, refresh: root.refresh });
      const startOpts: Parameters<typeof startNativeService>[0] = {
        paths: ctx.paths,
        serviceDoc: ctx.serviceDoc,
        service: ctx.service,
        logger,
      };
      if (cliEnv) startOpts.cliEnv = cliEnv;
      const result = await startNativeService(startOpts);
      if (root.json) {
        emitJson({ service: name, pid: result.pid, logFile: result.logFile });
      } else {
        emit(`Started ${name} pid=${result.pid}`);
        emit(`  log file: ${result.logFile}`);
        emit(`  tail with: qavor logs ${name} -f`);
      }
    });

  program
    .command('down')
    .description('Stop a single running service gracefully.')
    .argument('<service>')
    .option('--grace <ms>', 'Grace period for SIGTERM before SIGKILL (default 10000).', '10000')
    .action(async (name: string, opts: { grace: string }, cmd: Command) => {
      const root = inheritRootOptions(cmd);
      const logger = getLogger();
      const jobs = resolveJobs(root.jobs);
      const ctx = await findService(name, jobs, { offline: root.offline, refresh: root.refresh });
      const graceMs = Number.parseInt(opts.grace, 10);
      const res = await stopNativeService({
        paths: ctx.paths,
        service: name,
        manifestDir: ctx.manifestDir,
        ...(ctx.service.hooks ? { hooks: ctx.service.hooks } : {}),
        graceMs: Number.isFinite(graceMs) ? graceMs : 10_000,
        logger,
      });
      if (root.json) {
        emitJson({ service: name, stopped: res.stopped });
      } else {
        emit(`${res.stopped ? 'Stopped' : 'No-op'} ${name}`);
      }
    });

  program
    .command('logs')
    .description('Print or tail a service log file.')
    .argument('<service>')
    .option('-f, --follow', 'Follow the log file as new lines append.')
    .option('--bytes <n>', 'Initial bytes from the tail to print (default 16384).', '16384')
    .action(async (name: string, opts: { follow?: boolean; bytes: string }, cmd: Command) => {
      const root = inheritRootOptions(cmd);
      const jobs = resolveJobs(root.jobs);
      const ctx = await findService(name, jobs, { offline: root.offline, refresh: root.refresh });
      const logFile = path.join(ctx.paths.logsDir, name, 'service.log');
      const ac = new AbortController();
      process.on('SIGINT', () => ac.abort());
      process.on('SIGTERM', () => ac.abort());
      await tailFile({
        file: logFile,
        out: process.stdout,
        follow: Boolean(opts.follow),
        signal: ac.signal,
        initialBytes: Number.parseInt(opts.bytes, 10) || 16 * 1024,
      });
      void root;
    });

  program
    .command('ps')
    .description('List services tracked by the supervisor.')
    .action(async (_opts: unknown, cmd: Command) => {
      const root = inheritRootOptions(cmd);
      const ws = await resolveWorkspace();
      const list = await listServicesState(ws.paths);
      if (root.json) {
        emitJson({ services: list });
        return;
      }
      if (list.length === 0) {
        emit('(no services tracked)');
        return;
      }
      const headers = ['SERVICE', 'STATUS', 'PID', 'UPTIME', 'LOG'];
      const data = list.map((s) => [
        s.service,
        s.status,
        s.pid !== null ? String(s.pid) : '-',
        s.uptimeSec !== null ? `${s.uptimeSec}s` : '-',
        s.logFile ?? '-',
      ]);
      const widths = headers.map((h, i) =>
        Math.max(h.length, ...data.map((row) => (row[i] ?? '').length)),
      );
      const fmt = (row: string[]): string => row.map((c, i) => c.padEnd(widths[i] ?? 0)).join('  ');
      emit(fmt(headers));
      for (const row of data) emit(fmt(row));
    });
}
