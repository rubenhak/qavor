import { type Options as ExecaOptions, execa } from 'execa';
import { RuntimeFailure } from '../util/exit-codes.js';
import type { Logger } from '../util/logger.js';

/**
 * Shared execution context for one declarative step (compose/docker). Built by
 * the command runner; carries the two directories a step resolves paths against
 * and the full spawn env (process.env + composed service env + injected
 * `QAVOR_*`).
 *
 * The two dirs are distinct for a profile-contributed step: the working
 * directory is the consuming service's own dir (so a step runs and writes output
 * where the service lives, exactly as if the profile had been copied inline),
 * while profile-shipped asset paths (a compose `file`/`env_file`) resolve against
 * the profile's own — for a remote profile, locally materialized — directory.
 * For a service's own step the two coincide.
 */
export interface DeclarativeStepContext {
  serviceName: string;
  command: string;
  /** The consuming service manifest's directory; the step's default cwd. */
  serviceDir: string;
  /** Directory of the manifest that defined the step; base for `file`/`env_file`. */
  originDir: string;
  /** Full spawn environment; also the `${VAR}` interpolation scope. */
  env: Record<string, string | undefined>;
  /** Pass raw output through to the terminal (verbose + serial fan-out). */
  stream: boolean;
  logger: Logger;
  signal?: AbortSignal;
}

/** Run `docker <argv>`; non-zero exit raises a RuntimeFailure with `label` context. */
export async function execDocker(
  argv: string[],
  ctx: DeclarativeStepContext,
  label: string,
  cwd?: string,
): Promise<void> {
  ctx.logger.debug({ service: ctx.serviceName, argv: ['docker', ...argv] }, `${label}: exec`);
  const res = await execa('docker', argv, execOpts(ctx, cwd));
  if (res.exitCode !== 0) {
    throw new RuntimeFailure(
      `${label} failed for ${ctx.serviceName} (exit ${res.exitCode}).` +
        (ctx.stream ? '' : ' Re-run with --serial --verbose to see the command output.'),
    );
  }
}

/** Run `docker <argv>` capturing stdout; returns exit code + trimmed output, never throws on non-zero. */
export async function captureDocker(
  argv: string[],
  ctx: DeclarativeStepContext,
  cwd?: string,
): Promise<{ exitCode: number; stdout: string }> {
  const res = await execa('docker', argv, {
    ...execOpts(ctx, cwd),
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const stdout = typeof res.stdout === 'string' ? res.stdout.trim() : '';
  return { exitCode: res.exitCode ?? 1, stdout };
}

function execOpts(ctx: DeclarativeStepContext, cwd?: string): ExecaOptions {
  return {
    cwd: cwd ?? ctx.serviceDir,
    env: ctx.env,
    stdio: ctx.stream ? ['ignore', 'inherit', 'inherit'] : ['ignore', 'ignore', 'ignore'],
    ...(ctx.signal ? { cancelSignal: ctx.signal } : {}),
    reject: false,
  };
}

/** Coerce a `number | string` schema field (already interpolated) to a flag value. */
export function flagValue(v: number | string): string {
  return String(v);
}
