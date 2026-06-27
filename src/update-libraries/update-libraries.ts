import path from 'node:path';
import { type Options as ExecaOptions, execa } from 'execa';
import { assertNoIssues, composeServiceEnv, toEnvObject } from '../env/composer.js';
import type { LoadedDocument } from '../manifest/loader.js';
import type { ServiceManifest } from '../manifest/types/index.js';
import { ManifestError, RuntimeFailure } from '../util/exit-codes.js';
import { runHooks } from '../util/hooks.js';
import type { Logger } from '../util/logger.js';
import type { WorkspacePaths } from '../workspace/paths.js';

export interface UpdateLibrariesInput {
  paths: WorkspacePaths;
  serviceDoc: LoadedDocument;
  service: ServiceManifest;
  logger: Logger;
  signal?: AbortSignal;
  cliEnv?: Record<string, string>;
  /** Pass the update command's raw output through to the terminal. */
  verbose?: boolean;
  /** Whether the fan-out runs one service at a time. Raw output streams only
   *  in serial mode (parallel runs would interleave output unreadably). */
  serial?: boolean;
}

export interface UpdateLibrariesResult {
  serviceName: string;
  status: 'ok' | 'no-update-cmd';
}

/**
 * Run the service's `runtime.native.update_libraries.cmd` if present. This is an
 * out-of-band maintenance step (e.g. `pnpm update`, `uv lock --upgrade`) — it is
 * never part of the start lifecycle. The command runs unconditionally every
 * time — no hashing, caching, or skip logic.
 */
export async function updateServiceLibraries(
  input: UpdateLibrariesInput,
): Promise<UpdateLibrariesResult> {
  const cmd = input.service.runtime?.native?.update_libraries?.cmd;
  if (!cmd) {
    return {
      serviceName: input.service.name,
      status: 'no-update-cmd',
    };
  }

  const manifestDir = path.dirname(input.serviceDoc.file);

  const envRes = await composeServiceEnv({
    mode: 'native',
    serviceDoc: input.serviceDoc,
    service: input.service,
    workspaceRoot: input.paths.root,
    ...(input.cliEnv ? { cliEnv: input.cliEnv } : {}),
  });
  assertNoIssues(envRes);
  const env = toEnvObject(envRes);

  await runHooks({
    hooks: input.service.hooks,
    event: 'pre_update_libraries',
    cwd: manifestDir,
    env,
    logger: input.logger,
    ...(input.signal ? { signal: input.signal } : {}),
  });

  input.logger.info({ service: input.service.name, cmd }, 'update-libraries: starting');

  const cwd = input.service.runtime?.native?.update_libraries?.cwd
    ? path.resolve(manifestDir, input.service.runtime.native.update_libraries.cwd)
    : manifestDir;

  // The command's raw stdout/stderr pass straight through to the terminal only
  // under --verbose AND serial execution; in parallel the output would
  // interleave unreadably, so it is discarded. No log file either way.
  const stream = (input.verbose ?? false) && (input.serial ?? false);
  const shell = input.service.runtime?.native?.update_libraries?.shell ?? '/bin/sh';
  const opts: ExecaOptions = {
    cwd,
    env: { ...process.env, ...env },
    stdio: stream ? ['ignore', 'inherit', 'inherit'] : ['ignore', 'ignore', 'ignore'],
    ...(input.signal ? { cancelSignal: input.signal } : {}),
    reject: false,
  };
  try {
    const res = await execa(shell, ['-c', cmd], opts);
    if (res.exitCode !== 0) {
      throw new RuntimeFailure(
        `update-libraries failed for ${input.service.name} (exit ${res.exitCode}).` +
          (stream ? '' : ' Re-run with --serial --verbose to see the command output.'),
      );
    }
  } catch (err) {
    if (err instanceof RuntimeFailure) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new RuntimeFailure(`update-libraries failed for ${input.service.name}: ${message}.`);
  }

  await runHooks({
    hooks: input.service.hooks,
    event: 'post_update_libraries',
    cwd: manifestDir,
    env,
    logger: input.logger,
    ...(input.signal ? { signal: input.signal } : {}),
  });

  return { serviceName: input.service.name, status: 'ok' };
}

export class UpdateLibrariesMissingManifestError extends ManifestError {}
