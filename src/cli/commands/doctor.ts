import fs from 'node:fs/promises';
import path from 'node:path';
import type { Command } from 'commander';
import { execa } from 'execa';
import { buildWorkspaceRegistry } from '../../manifest/discovery.js';
import { type LoadedDocument, loadManifestFile } from '../../manifest/loader.js';
import type { ProjectManifest, ServiceManifest } from '../../manifest/types/index.js';
import { resolveJobs } from '../../util/concurrency.js';
import { RuntimeFailure } from '../../util/exit-codes.js';
import { ensureDir, globalCacheDir } from '../../util/fs.js';
import { emit, emitJson, getLogger } from '../../util/logger.js';
import { readProjectManifest, resolveWorkspace } from '../../workspace/locate.js';
import { resolveRepos } from '../../workspace/repos.js';
import { inheritRootOptions } from '../options.js';

interface Check {
  name: string;
  status: 'ok' | 'warn' | 'fail';
  message?: string;
  hint?: string;
}

async function runShell(cmd: string, cwd: string): Promise<{ ok: boolean; exitCode: number }> {
  try {
    const res = await execa('/bin/sh', ['-c', cmd], { cwd, reject: false });
    return { ok: res.exitCode === 0, exitCode: res.exitCode ?? -1 };
  } catch {
    return { ok: false, exitCode: -1 };
  }
}

export function registerDoctor(program: Command): void {
  program
    .command('doctor')
    .description(
      'Verify toolchain prerequisites, workspace paths, and per-service check_installed steps.',
    )
    .action(async (_opts: unknown, cmd: Command) => {
      const root = inheritRootOptions(cmd);
      const logger = getLogger();
      const checks: Check[] = [];

      // git version
      try {
        const res = await execa('git', ['--version']);
        const version = res.stdout.trim().replace(/^git version /, '');
        const [maj, min] = version.split('.').map((s) => Number.parseInt(s, 10));
        if (
          Number.isFinite(maj) &&
          Number.isFinite(min) &&
          ((maj ?? 0) > 2 || ((maj ?? 0) === 2 && (min ?? 0) >= 30))
        ) {
          checks.push({ name: 'git ≥ 2.30', status: 'ok', message: version });
        } else {
          checks.push({ name: 'git ≥ 2.30', status: 'warn', message: `found ${version}` });
        }
      } catch {
        checks.push({
          name: 'git ≥ 2.30',
          status: 'fail',
          message: 'git not found',
          hint: 'Install git.',
        });
      }

      // docker (warn only at v0)
      try {
        await execa('docker', ['--version']);
        checks.push({ name: 'docker (optional v0)', status: 'ok' });
      } catch {
        checks.push({
          name: 'docker (optional v0)',
          status: 'warn',
          message: 'docker not detected',
        });
      }

      // Workspace + state dirs writable
      try {
        const ws = await resolveWorkspace();
        await ensureDir(ws.paths.stateRoot);
        const probe = path.join(ws.paths.stateRoot, '.doctor-write-check');
        await fs.writeFile(probe, '');
        await fs.unlink(probe);
        checks.push({
          name: 'workspace .qavor/ writable',
          status: 'ok',
          message: ws.paths.stateRoot,
        });
      } catch (err) {
        checks.push({
          name: 'workspace .qavor/ writable',
          status: 'fail',
          message: err instanceof Error ? err.message : String(err),
        });
      }

      // Global cache writable
      const cache = globalCacheDir();
      try {
        await ensureDir(cache);
        const probe = path.join(cache, '.doctor-write-check');
        await fs.writeFile(probe, '');
        await fs.unlink(probe);
        checks.push({ name: 'global cache writable', status: 'ok', message: cache });
      } catch (err) {
        checks.push({
          name: 'global cache writable',
          status: 'fail',
          message: err instanceof Error ? err.message : String(err),
        });
      }

      // Per-service check_installed.cmd
      try {
        const ws = await resolveWorkspace();
        const project = await readProjectManifest(ws.projectManifestFile);
        const repos = resolveRepos({
          workspaceRoot: ws.paths.root,
          project: project.data as unknown as ProjectManifest,
          projectRepoPath: ws.projectRepoPath,
        });
        const repoMap = new Map(repos.map((r) => [r.name, r.dir]));
        repoMap.set('__project__', ws.projectRepoPath);
        const registry = await buildWorkspaceRegistry({
          workspaceRoot: ws.paths.root,
          repos: repoMap,
          concurrency: resolveJobs(root.jobs),
        });
        for (const entry of registry.entries) {
          if (entry.kind !== 'service') continue;
          const svc = entry.data as unknown as ServiceManifest;
          const checkCmd = svc.runtime?.native?.check_installed?.cmd;
          if (!checkCmd) {
            checks.push({
              name: `service ${entry.name}: check_installed`,
              status: 'warn',
              message: 'no runtime.native.check_installed.cmd',
            });
            continue;
          }
          const docs = await loadManifestFile(entry.file);
          const serviceDoc = docs[entry.docIndex] as LoadedDocument;
          const cwd = svc.runtime?.native?.check_installed?.cwd
            ? path.resolve(path.dirname(serviceDoc.file), svc.runtime.native.check_installed.cwd)
            : path.dirname(serviceDoc.file);
          const res = await runShell(checkCmd, cwd);
          if (res.ok) {
            checks.push({ name: `service ${entry.name}: check_installed`, status: 'ok' });
          } else {
            const installHint = svc.runtime?.native?.install?.cmd;
            const failCheck: Check = {
              name: `service ${entry.name}: check_installed`,
              status: 'fail',
              message: `exit ${res.exitCode}`,
            };
            if (installHint) failCheck.hint = `Hint: \`${installHint}\``;
            checks.push(failCheck);
          }
        }
      } catch (err) {
        // doctor still emits other checks even if not in a workspace
        logger.debug(
          { err: err instanceof Error ? err.message : String(err) },
          'doctor: workspace probe failed',
        );
      }

      if (root.json) {
        emitJson({ checks, ok: checks.every((c) => c.status !== 'fail') });
      } else {
        for (const c of checks) {
          const sym = c.status === 'ok' ? '✓' : c.status === 'warn' ? '!' : '✗';
          let line = `${sym} ${c.status.toUpperCase().padEnd(5)} ${c.name}`;
          if (c.message) line += ` — ${c.message}`;
          emit(line);
          if (c.hint) emit(`     ${c.hint}`);
        }
      }
      if (checks.some((c) => c.status === 'fail')) {
        throw new RuntimeFailure('doctor: one or more checks failed.');
      }
    });
}
