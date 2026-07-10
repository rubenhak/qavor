import path from 'node:path';
import type { ComposeStep } from '../manifest/types/index.js';
import { captureDocker, type DeclarativeStepContext, execDocker, flagValue } from './exec.js';
import { interpolateDeep } from './interpolate.js';

/** Default compose file, resolved relative to the defining manifest's directory. */
const DEFAULT_COMPOSE_FILE = './docker-compose.yaml';

/**
 * Build the full `docker compose …` argv for a declarative compose step. Pure —
 * `step` must already be interpolated; paths in the result are absolute.
 * Exported for unit tests.
 */
export function composeArgv(
  step: ComposeStep,
  opts: { stepDir: string; serviceName: string },
): string[] {
  const files = toList(step.file ?? DEFAULT_COMPOSE_FILE).map((f) => path.resolve(opts.stepDir, f));
  const envFiles = toList(step.env_file).map((f) => path.resolve(opts.stepDir, f));
  const project = step.project ?? `qavor-${opts.serviceName}`;

  const argv = [
    'compose',
    '-p',
    project,
    ...files.flatMap((f) => ['-f', f]),
    ...(step.profiles ?? []).flatMap((p) => ['--profile', p]),
    ...envFiles.flatMap((f) => ['--env-file', f]),
    ...actionArgs(step),
    ...(step.args ?? []),
    ...(step.services ?? []),
  ];
  return argv;
}

function actionArgs(step: ComposeStep): string[] {
  switch (step.action) {
    case 'up':
      return [
        'up',
        '-d',
        ...(step.wait ? ['--wait'] : []),
        ...(step.wait && step.timeout != null ? ['--wait-timeout', flagValue(step.timeout)] : []),
        ...(step.build ? ['--build'] : []),
        ...(step.force_recreate ? ['--force-recreate'] : []),
        ...(step.remove_orphans ? ['--remove-orphans'] : []),
      ];
    case 'down':
      return [
        'down',
        ...(step.volumes ? ['--volumes'] : []),
        ...(step.remove_orphans ? ['--remove-orphans'] : []),
        ...(step.timeout != null ? ['--timeout', flagValue(step.timeout)] : []),
      ];
    case 'stop':
    case 'restart':
      return [step.action, ...(step.timeout != null ? ['--timeout', flagValue(step.timeout)] : [])];
    case 'logs':
      return [
        'logs',
        ...(step.tail != null ? ['--tail', flagValue(step.tail)] : []),
        ...(step.follow ? ['--follow'] : []),
      ];
    default:
      // start | ps | pull | build take no modeled flags beyond `args`.
      return [step.action];
  }
}

/**
 * Execute a declarative compose step: interpolate `${VAR}` from the step's
 * spawn env, build the argv, and shell out to `docker compose`. `ps` output is
 * always surfaced through the logger so `qavor status`-style commands are
 * useful outside `--serial --verbose`.
 */
export async function runComposeStep(raw: ComposeStep, ctx: DeclarativeStepContext): Promise<void> {
  const context = `${ctx.command} (compose ${raw.action}) of ${ctx.serviceName}`;
  const step = interpolateDeep(raw, ctx.env, context);
  const cwd = step.cwd ? path.resolve(ctx.stepDir, step.cwd) : ctx.stepDir;
  const argv = composeArgv(step, { stepDir: ctx.stepDir, serviceName: ctx.serviceName });
  const label = `${ctx.command}: compose ${step.action}`;

  if (step.action === 'ps') {
    const res = await captureDocker(argv, ctx, cwd);
    const summary = res.exitCode === 0 ? res.stdout || '(no containers)' : `exit ${res.exitCode}`;
    ctx.logger.info({ service: ctx.serviceName }, `${label}\n${summary}`);
    return;
  }
  await execDocker(argv, ctx, label, cwd);
}

function toList(value: string | string[] | undefined): string[] {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}
