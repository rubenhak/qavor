import fs from 'node:fs/promises';
import path from 'node:path';
import { type Options as ExecaOptions, execa, type ResultPromise } from 'execa';
import { assertNoIssues, composeServiceEnv, toEnvObject } from '../env/composer.js';
import type { LoadedDocument } from '../manifest/loader.js';
import type { ServiceManifest } from '../manifest/types/index.js';
import { RuntimeFailure, UserError } from '../util/exit-codes.js';
import { ensureDir } from '../util/fs.js';
import { runHooks } from '../util/hooks.js';
import type { Logger } from '../util/logger.js';
import type { WorkspacePaths } from '../workspace/paths.js';
import {
  clearState,
  isPidAlive,
  listSupervisorStates,
  readState,
  type SupervisorState,
  writeState,
} from './state.js';

export interface StartOptions {
  paths: WorkspacePaths;
  serviceDoc: LoadedDocument;
  service: ServiceManifest;
  logger: Logger;
  cliEnv?: Record<string, string>;
}

export interface StartResult {
  pid: number;
  pgid: number;
  logFile: string;
}

const LOG_FILE_NAME = 'service.log';
const LOG_MAX_BYTES = 5 * 1024 * 1024;
const LOG_BACKLOG = 5;

export async function startNativeService(opts: StartOptions): Promise<StartResult> {
  const cmd = opts.service.runtime?.native?.run?.cmd;
  if (!cmd) {
    throw new UserError(
      `Service '${opts.service.name}' has no runtime.native.run.cmd. Cannot start in native mode.`,
    );
  }
  if (opts.service.runtime?.native?.enabled === false) {
    throw new UserError(
      `Service '${opts.service.name}' has runtime.native.enabled: false. Cannot start in native mode.`,
    );
  }

  const existing = await readState(opts.paths, opts.service.name);
  if (existing && existing.status === 'running' && isPidAlive(existing.pid)) {
    throw new UserError(`Service '${opts.service.name}' is already running (pid ${existing.pid}).`);
  }

  const manifestDir = path.dirname(opts.serviceDoc.file);
  const cwd = opts.service.runtime?.native?.run?.cwd
    ? path.resolve(manifestDir, opts.service.runtime.native.run.cwd)
    : manifestDir;

  const envRes = await composeServiceEnv({
    mode: 'native',
    serviceDoc: opts.serviceDoc,
    service: opts.service,
    workspaceRoot: opts.paths.root,
    ...(opts.cliEnv ? { cliEnv: opts.cliEnv } : {}),
  });
  assertNoIssues(envRes);
  const env = toEnvObject(envRes);

  const serviceLogDir = path.join(opts.paths.logsDir, opts.service.name);
  await ensureDir(serviceLogDir);
  await rotateLog(serviceLogDir);
  const logFile = path.join(serviceLogDir, LOG_FILE_NAME);
  const fh = await fs.open(logFile, 'a');

  // pre_run hook
  await runHooks({
    hooks: opts.service.hooks,
    event: 'pre_run',
    cwd: manifestDir,
    env,
    logger: opts.logger,
  });

  let child: ResultPromise;
  const shell = opts.service.runtime?.native?.run?.shell ?? '/bin/sh';
  try {
    const spawnOpts: ExecaOptions = {
      cwd,
      env: { ...process.env, ...env },
      detached: true,
      stdio: ['ignore', fh.fd, fh.fd] as ExecaOptions['stdio'],
      reject: false,
    };
    child = execa(shell, ['-c', cmd], spawnOpts);
  } catch (err) {
    await fh.close().catch(() => undefined);
    throw new RuntimeFailure(
      `Failed to spawn ${opts.service.name}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const pid = child.pid ?? 0;
  if (!pid) {
    await fh.close().catch(() => undefined);
    throw new RuntimeFailure(`Failed to spawn ${opts.service.name}: no pid assigned.`);
  }

  // detach so the child survives this CLI process exiting.
  child.unref();

  // Close our copy of the log fd — the child holds its own.
  await fh.close().catch(() => undefined);

  // Record state.
  const state: SupervisorState = {
    service: opts.service.name,
    pid,
    pgid: pid,
    startedAt: new Date().toISOString(),
    cmd,
    cwd,
    logFile,
    status: 'running',
    updatedAt: new Date().toISOString(),
  };
  await writeState(opts.paths, state);

  opts.logger.info({ service: opts.service.name, pid, logFile }, 'up: started');
  return { pid, pgid: pid, logFile };
}

export interface StopOptions {
  paths: WorkspacePaths;
  service: string;
  manifestDir?: string;
  hooks?: ServiceManifest['hooks'];
  graceMs?: number;
  logger: Logger;
}

const DEFAULT_GRACE_MS = 10_000;

export async function stopNativeService(opts: StopOptions): Promise<{ stopped: boolean }> {
  const state = await readState(opts.paths, opts.service);
  if (!state) {
    opts.logger.info({ service: opts.service }, 'down: no state file; nothing to do');
    return { stopped: false };
  }
  if (!isPidAlive(state.pid)) {
    opts.logger.info(
      { service: opts.service, pid: state.pid },
      'down: process already gone; clearing state',
    );
    await clearState(opts.paths, opts.service);
    return { stopped: true };
  }

  if (opts.manifestDir && opts.hooks) {
    await runHooks({
      hooks: opts.hooks,
      event: 'pre_stop',
      cwd: opts.manifestDir,
      logger: opts.logger,
    });
  }

  const grace = opts.graceMs ?? DEFAULT_GRACE_MS;
  try {
    process.kill(-state.pid, 'SIGTERM');
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code !== 'ESRCH') throw err;
  }
  const stoppedGracefully = await waitForExit(state.pid, grace);
  if (!stoppedGracefully) {
    opts.logger.warn({ service: opts.service, pid: state.pid }, 'down: grace exceeded; SIGKILL');
    try {
      process.kill(-state.pid, 'SIGKILL');
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code !== 'ESRCH') throw err;
    }
    await waitForExit(state.pid, 5000);
  }

  if (opts.manifestDir && opts.hooks) {
    await runHooks({
      hooks: opts.hooks,
      event: 'post_stop',
      cwd: opts.manifestDir,
      logger: opts.logger,
    });
  }

  await clearState(opts.paths, opts.service);
  return { stopped: true };
}

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return true;
    await sleep(100);
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function rotateLog(dir: string): Promise<void> {
  const main = path.join(dir, LOG_FILE_NAME);
  let st: import('node:fs').Stats | null = null;
  try {
    st = await fs.stat(main);
  } catch {
    return;
  }
  if (st.size < LOG_MAX_BYTES) return;
  // Rotate .log -> .log.1 -> .log.2 ...
  for (let i = LOG_BACKLOG - 1; i >= 1; i--) {
    const src = path.join(dir, `${LOG_FILE_NAME}.${i}`);
    const dst = path.join(dir, `${LOG_FILE_NAME}.${i + 1}`);
    try {
      await fs.rename(src, dst);
    } catch {
      /* missing */
    }
  }
  try {
    await fs.rename(main, path.join(dir, `${LOG_FILE_NAME}.1`));
  } catch {
    /* might be gone */
  }
}

export interface ListedService {
  service: string;
  status: 'running' | 'stopped' | 'crashed';
  pid: number | null;
  startedAt: string | null;
  uptimeSec: number | null;
  logFile: string | null;
}

/**
 * Cheap parallel liveness check. Used by `qavor ps`.
 */
export async function listServicesState(paths: WorkspacePaths): Promise<ListedService[]> {
  const states = await listSupervisorStates(paths);
  const out: ListedService[] = [];
  for (const s of states) {
    const alive = isPidAlive(s.pid);
    const status: ListedService['status'] = alive
      ? 'running'
      : s.status === 'running'
        ? 'crashed'
        : 'stopped';
    const started = new Date(s.startedAt);
    const uptimeSec = alive ? Math.floor((Date.now() - started.getTime()) / 1000) : null;
    out.push({
      service: s.service,
      status,
      pid: alive ? s.pid : null,
      startedAt: s.startedAt,
      uptimeSec,
      logFile: s.logFile,
    });
  }
  return out;
}

/**
 * If a state file reports `running` but the PID has died, mark it crashed
 * so subsequent `ps` calls report it. Returns the updated state, if any.
 */
export async function reconcileCrashedState(
  paths: WorkspacePaths,
  service: string,
): Promise<SupervisorState | null> {
  const state = await readState(paths, service);
  if (!state) return null;
  if (state.status === 'running' && !isPidAlive(state.pid)) {
    state.status = 'crashed';
    state.updatedAt = new Date().toISOString();
    await writeState(paths, state);
    return state;
  }
  return state;
}
