import { type Options as ExecaOptions, execa } from 'execa';
import { RuntimeFailure } from '../util/exit-codes.js';
import type { Logger } from '../util/logger.js';

/**
 * Shared execution context for one declarative step (compose/docker). Built by
 * the command runner; carries the resolved defining-manifest directory and the
 * full spawn env (process.env + composed service env + injected `QAVOR_*`).
 */
export interface DeclarativeStepContext {
  serviceName: string;
  command: string;
  /** Directory of the manifest that defined the step; default cwd and base for relative paths. */
  stepDir: string;
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
    cwd: cwd ?? ctx.stepDir,
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
