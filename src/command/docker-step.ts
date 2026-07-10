import { setTimeout as sleep } from 'node:timers/promises';
import type { DockerStep } from '../manifest/types/index.js';
import { RuntimeFailure } from '../util/exit-codes.js';
import { captureDocker, type DeclarativeStepContext, execDocker, flagValue } from './exec.js';
import { interpolateDeep } from './interpolate.js';

const DEFAULT_WAIT_TIMEOUT_S = 60;

/**
 * Build the `docker run …` argv for a declarative docker step. Pure — `step`
 * must already be interpolated. Exported for unit tests.
 */
export function dockerRunArgv(step: DockerStep): string[] {
  if (!step.image) {
    throw new RuntimeFailure(`docker ${step.action} for '${step.name}' requires an image.`);
  }
  const hc = step.healthcheck;
  return [
    'run',
    ...(step.detach === false ? [] : ['-d']),
    '--name',
    step.name,
    ...(step.ports ?? []).flatMap((p) => ['-p', p]),
    ...Object.entries(step.env ?? {}).flatMap(([k, v]) => ['-e', `${k}=${String(v)}`]),
    ...(step.volumes ?? []).flatMap((v) => ['-v', v]),
    ...(step.network ? ['--network', step.network] : []),
    ...(step.user ? ['--user', step.user] : []),
    ...(step.workdir ? ['--workdir', step.workdir] : []),
    ...(step.restart ? ['--restart', step.restart] : []),
    ...Object.entries(step.labels ?? {}).flatMap(([k, v]) => ['--label', `${k}=${v}`]),
    ...(step.platform ? ['--platform', step.platform] : []),
    ...(step.pull ? ['--pull', step.pull] : []),
    ...(step.entrypoint ? ['--entrypoint', step.entrypoint] : []),
    ...(hc?.test ? ['--health-cmd', hc.test] : []),
    ...(hc?.interval ? ['--health-interval', hc.interval] : []),
    ...(hc?.retries != null ? ['--health-retries', flagValue(hc.retries)] : []),
    ...(hc?.timeout ? ['--health-timeout', hc.timeout] : []),
    ...(hc?.start_period ? ['--health-start-period', hc.start_period] : []),
    ...(step.args ?? []),
    step.image,
    ...commandArgs(step.command),
  ];
}

/** Normalize the post-image command: lists pass through, strings split on whitespace. */
function commandArgs(command: DockerStep['command']): string[] {
  if (command == null) return [];
  if (Array.isArray(command)) return command;
  return command.split(/\s+/).filter((s) => s.length > 0);
}

/**
 * Execute a declarative docker step. `up` is the idempotent ensure-running
 * lifecycle (run if absent, start if stopped, no-op if running); `down` stops
 * and removes the container, leaving named volumes unless `remove_volumes`
 * lists them. The raw primitives (`run`/`start`/`stop`/`restart`/`rm`) map
 * one-to-one onto the docker CLI and fail as docker fails.
 */
export async function runDockerStep(raw: DockerStep, ctx: DeclarativeStepContext): Promise<void> {
  const context = `${ctx.command} (docker ${raw.action}) of ${ctx.serviceName}`;
  const step = interpolateDeep(raw, ctx.env, context);
  const label = `${ctx.command}: docker ${step.action}`;
  const stopFlags = step.timeout != null ? ['-t', flagValue(step.timeout)] : [];

  switch (step.action) {
    case 'up': {
      const state = await containerState(step.name, ctx);
      if (state === 'running') {
        ctx.logger.info(
          { service: ctx.serviceName, container: step.name },
          `${label}: '${step.name}' already running`,
        );
      } else if (state) {
        await execDocker(['start', step.name], ctx, label);
      } else {
        await execDocker(dockerRunArgv(step), ctx, label);
      }
      if (step.wait) await waitReady(step, ctx, label);
      return;
    }
    case 'run': {
      await execDocker(dockerRunArgv(step), ctx, label);
      if (step.wait) await waitReady(step, ctx, label);
      return;
    }
    case 'down': {
      const state = await containerState(step.name, ctx);
      if (state) {
        await execDocker(['stop', ...stopFlags, step.name], ctx, label);
        await execDocker(['rm', step.name], ctx, label);
      } else {
        ctx.logger.info(
          { service: ctx.serviceName, container: step.name },
          `${label}: '${step.name}' not created`,
        );
      }
      await removeVolumes(step, ctx, label);
      return;
    }
    case 'rm': {
      await execDocker(['rm', ...(step.args ?? []), step.name], ctx, label);
      await removeVolumes(step, ctx, label);
      return;
    }
    case 'stop':
    case 'restart':
      await execDocker([step.action, ...stopFlags, step.name], ctx, label);
      return;
    case 'start':
      await execDocker(['start', step.name], ctx, label);
      return;
    case 'logs':
      await execDocker(
        [
          'logs',
          ...(step.tail != null ? ['--tail', flagValue(step.tail)] : []),
          ...(step.follow ? ['-f'] : []),
          step.name,
        ],
        ctx,
        label,
      );
      return;
    case 'status': {
      const res = await captureDocker(
        ['ps', '-a', '--filter', `name=^/${step.name}$`, '--format', '{{.Names}}\t{{.Status}}'],
        ctx,
      );
      const summary =
        res.exitCode === 0 ? res.stdout || `${step.name}: not created` : `exit ${res.exitCode}`;
      ctx.logger.info({ service: ctx.serviceName, container: step.name }, `${label}\n${summary}`);
      return;
    }
  }
}

/** Container state via `docker inspect`; `undefined` when the container does not exist. */
async function containerState(
  name: string,
  ctx: DeclarativeStepContext,
): Promise<string | undefined> {
  const res = await captureDocker(['inspect', '-f', '{{.State.Status}}', name], ctx);
  return res.exitCode === 0 && res.stdout.length > 0 ? res.stdout : undefined;
}

/**
 * Poll the container once a second until its healthcheck reports healthy — or,
 * when it defines no healthcheck, until it is running. Fails fast if the
 * container exits, and fails closed at the deadline.
 */
async function waitReady(
  step: DockerStep,
  ctx: DeclarativeStepContext,
  label: string,
): Promise<void> {
  const timeoutS = step.timeout != null ? Number(step.timeout) : DEFAULT_WAIT_TIMEOUT_S;
  const deadline = Date.now() + timeoutS * 1000;
  const format =
    '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}';

  while (true) {
    const res = await captureDocker(['inspect', '-f', format, step.name], ctx);
    const [status, health] = res.exitCode === 0 ? res.stdout.split(/\s+/) : ['absent', 'none'];
    if (health === 'healthy' || (health === 'none' && status === 'running')) {
      ctx.logger.info(
        { service: ctx.serviceName, container: step.name },
        `${label}: '${step.name}' ready`,
      );
      return;
    }
    if (status === 'exited' || status === 'dead') {
      throw new RuntimeFailure(
        `${label}: container '${step.name}' exited while waiting for readiness.`,
      );
    }
    if (Date.now() >= deadline) {
      throw new RuntimeFailure(
        `${label}: container '${step.name}' not ready after ${timeoutS}s (status ${status}, health ${health}).`,
      );
    }
    await sleep(1000, undefined, ctx.signal ? { signal: ctx.signal } : {});
  }
}

async function removeVolumes(
  step: DockerStep,
  ctx: DeclarativeStepContext,
  label: string,
): Promise<void> {
  for (const volume of step.remove_volumes ?? []) {
    await execDocker(['volume', 'rm', '-f', volume], ctx, label);
  }
}
