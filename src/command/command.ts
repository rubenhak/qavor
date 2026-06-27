import path from 'node:path';
import { type Options as ExecaOptions, execa } from 'execa';
import { assertNoIssues, composeServiceEnv, toEnvObject } from '../env/composer.js';
import type { LoadedDocument } from '../manifest/loader.js';
import { serviceCommandSteps } from '../manifest/runtime.js';
import type { ServiceManifest } from '../manifest/types/index.js';
import { RuntimeFailure } from '../util/exit-codes.js';
import { runHooks } from '../util/hooks.js';
import type { Logger } from '../util/logger.js';
import type { WorkspacePaths } from '../workspace/paths.js';

export interface RunCommandInput {
  /** The dynamic command name (e.g. `prepare`, `update_libraries`, `lint`). */
  command: string;
  paths: WorkspacePaths;
  serviceDoc: LoadedDocument;
  service: ServiceManifest;
  logger: Logger;
  signal?: AbortSignal;
  cliEnv?: Record<string, string>;
  /** Pass the command's raw output through to the terminal. */
  verbose?: boolean;
  /** Whether the fan-out runs one service at a time. Raw output streams only
   *  in serial mode (parallel runs would interleave output unreadably). */
  serial?: boolean;
}

export interface RunCommandResult {
  serviceName: string;
  status: 'ok' | 'skipped';
}

/**
 * Run a dynamic command (`runtime.native.<command>`) for a single service. The
 * command is whatever the manifest declares — qavor assumes no fixed set. Steps
 * run in declaration order; the first non-zero exit aborts the rest. The command
 * runs unconditionally every time — no hashing, caching, or skip logic. A
 * service that does not declare the command is reported `skipped`.
 */
export async function runServiceCommand(input: RunCommandInput): Promise<RunCommandResult> {
  const steps = serviceCommandSteps(input.service, input.command);
  if (steps.length === 0) {
    return { serviceName: input.service.name, status: 'skipped' };
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
  // Expose the running command name to steps and hooks so a single hook pair can
  // branch per command.
  const env = { ...toEnvObject(envRes), QAVOR_COMMAND: input.command };

  await runHooks({
    hooks: input.service.hooks,
    event: 'pre_command',
    cwd: manifestDir,
    env,
    logger: input.logger,
    ...(input.signal ? { signal: input.signal } : {}),
  });

  // The command's raw stdout/stderr pass straight through to the terminal only
  // under --verbose AND serial execution; in parallel the output would interleave
  // unreadably, so it is discarded. No log file either way.
  const stream = (input.verbose ?? false) && (input.serial ?? false);

  // Steps run in declaration order; the first non-zero exit aborts the rest.
  // Each step carries its own cwd/shell.
  for (const [index, step] of steps.entries()) {
    const stepLabel = steps.length > 1 ? ` (step ${index + 1}/${steps.length})` : '';
    input.logger.info(
      {
        service: input.service.name,
        command: input.command,
        cmd: step.cmd,
        step: index + 1,
        steps: steps.length,
      },
      `${input.command}: starting`,
    );

    const cwd = step.cwd ? path.resolve(manifestDir, step.cwd) : manifestDir;
    const shell = step.shell ?? '/bin/sh';
    const opts: ExecaOptions = {
      cwd,
      env: { ...process.env, ...env },
      stdio: stream ? ['ignore', 'inherit', 'inherit'] : ['ignore', 'ignore', 'ignore'],
      ...(input.signal ? { cancelSignal: input.signal } : {}),
      reject: false,
    };
    try {
      const res = await execa(shell, ['-c', step.cmd], opts);
      if (res.exitCode !== 0) {
        throw new RuntimeFailure(
          `${input.command} failed for ${input.service.name}${stepLabel} (exit ${res.exitCode}).` +
            (stream ? '' : ' Re-run with --serial --verbose to see the command output.'),
        );
      }
    } catch (err) {
      if (err instanceof RuntimeFailure) throw err;
      const message = err instanceof Error ? err.message : String(err);
      throw new RuntimeFailure(
        `${input.command} failed for ${input.service.name}${stepLabel}: ${message}.`,
      );
    }
  }

  await runHooks({
    hooks: input.service.hooks,
    event: 'post_command',
    cwd: manifestDir,
    env,
    logger: input.logger,
    ...(input.signal ? { signal: input.signal } : {}),
  });

  return { serviceName: input.service.name, status: 'ok' };
}
