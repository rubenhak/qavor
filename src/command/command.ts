import path from 'node:path';
import { type Options as ExecaOptions, execa } from 'execa';
import { assertNoIssues, composeServiceEnv, toEnvObject } from '../env/composer.js';
import type { LoadedDocument } from '../manifest/loader.js';
import { serviceCommandSteps } from '../manifest/runtime.js';
import {
  composeStepOf,
  describeStep,
  dockerStepOf,
  isCmdStep,
  stepOriginDir,
} from '../manifest/steps.js';
import type { ServiceManifest } from '../manifest/types/index.js';
import { RuntimeFailure } from '../util/exit-codes.js';
import { runHooks } from '../util/hooks.js';
import type { Logger } from '../util/logger.js';
import type { WorkspacePaths } from '../workspace/paths.js';
import { runComposeStep } from './compose-step.js';
import { runDockerStep } from './docker-step.js';
import type { DeclarativeStepContext } from './exec.js';

export interface RunCommandInput {
  /** The dynamic command name (e.g. `prepare`, `update_libraries`, `lint`). */
  command: string;
  paths: WorkspacePaths;
  /** Absolute path to the project repo (holds the `kind: project` manifest). */
  projectDir: string;
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
  // Expose the running command name plus the workspace/project/service locations
  // to steps and hooks: a single hook pair can branch per command, and scripts
  // can resolve paths without hard-coding them. These are computed by qavor and
  // always win over any composed env of the same name.
  const env = {
    ...toEnvObject(envRes),
    QAVOR_COMMAND: input.command,
    QAVOR_WORKSPACE_DIR: input.paths.root,
    QAVOR_PROJECT_DIR: input.projectDir,
    QAVOR_SERVICE_DIR: manifestDir,
  };

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
  // A step is either a shell `cmd` step (run via the shell, which expands its
  // own variables) or a declarative `compose`/`docker` step (qavor interpolates
  // ${VAR} itself and shells out to docker). A step's working directory is
  // always the consuming service manifest's dir — referencing a profile behaves
  // as if its steps were copied inline. Profile-shipped assets (a compose
  // `file`/`env_file`, or anything reached via `$QAVOR_MANIFEST_DIR`) still
  // resolve against the defining manifest's dir — the profile's own
  // (materialized) directory for profile-contributed steps.
  for (const [index, step] of steps.entries()) {
    const stepLabel = steps.length > 1 ? ` (step ${index + 1}/${steps.length})` : '';
    const originDir = stepOriginDir(step) ?? manifestDir;
    const stepEnv = { ...env, QAVOR_MANIFEST_DIR: originDir };
    input.logger.info(
      {
        service: input.service.name,
        command: input.command,
        cmd: describeStep(step),
        step: index + 1,
        steps: steps.length,
      },
      `${input.command}: starting`,
    );

    try {
      if (isCmdStep(step)) {
        const cwd = step.cwd ? path.resolve(manifestDir, step.cwd) : manifestDir;
        const shell = step.shell ?? '/bin/sh';
        const opts: ExecaOptions = {
          cwd,
          env: { ...process.env, ...stepEnv },
          stdio: stream ? ['ignore', 'inherit', 'inherit'] : ['ignore', 'ignore', 'ignore'],
          ...(input.signal ? { cancelSignal: input.signal } : {}),
          reject: false,
        };
        const res = await execa(shell, ['-c', step.cmd], opts);
        if (res.exitCode !== 0) {
          throw new RuntimeFailure(
            `${input.command} failed for ${input.service.name}${stepLabel} (exit ${res.exitCode}).` +
              (stream ? '' : ' Re-run with --serial --verbose to see the command output.'),
          );
        }
      } else {
        const ctx: DeclarativeStepContext = {
          serviceName: input.service.name,
          command: input.command,
          serviceDir: manifestDir,
          originDir,
          env: { ...process.env, ...stepEnv },
          stream,
          logger: input.logger,
          ...(input.signal ? { signal: input.signal } : {}),
        };
        const compose = composeStepOf(step);
        const docker = dockerStepOf(step);
        if (compose) await runComposeStep(compose, ctx);
        else if (docker) await runDockerStep(docker, ctx);
        else throw new RuntimeFailure(`Unrecognized step shape${stepLabel}.`);
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
