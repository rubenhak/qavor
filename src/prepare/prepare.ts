import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { type Options as ExecaOptions, execa } from 'execa';
import { assertNoIssues, composeServiceEnv, toEnvObject } from '../env/composer.js';
import type { LoadedDocument } from '../manifest/loader.js';
import type { ServiceManifest } from '../manifest/types/index.js';
import { ManifestError, RuntimeFailure } from '../util/exit-codes.js';
import { pathExists, readJsonFile, writeJsonFile } from '../util/fs.js';
import { runHooks } from '../util/hooks.js';
import type { Logger } from '../util/logger.js';
import type { WorkspacePaths } from '../workspace/paths.js';

const DEFAULT_LOCK_PATTERNS = [
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'uv.lock',
  'poetry.lock',
  'requirements.txt',
  'Pipfile.lock',
  'go.sum',
  'Cargo.lock',
];

export interface PrepareInput {
  paths: WorkspacePaths;
  serviceDoc: LoadedDocument;
  service: ServiceManifest;
  force: boolean;
  logger: Logger;
  signal?: AbortSignal;
  cliEnv?: Record<string, string>;
  /** Pass the prepare command's raw output through to the terminal. */
  verbose?: boolean;
}

export interface PrepareResult {
  serviceName: string;
  /** "ok" — prepared successfully. "skip" — lockfile-hash cache hit. */
  status: 'ok' | 'skipped' | 'no-prepare-cmd';
  cacheFile: string;
  hash: string | null;
}

/**
 * Run the service's `runtime.native.prepare.cmd` if present.
 * Lockfile-aware skip: hashes the configured lockfile inputs (default
 * heuristics) plus the prepare command itself; skip on cache hit unless
 * --force is set.
 */
export async function prepareService(input: PrepareInput): Promise<PrepareResult> {
  const cmd = input.service.runtime?.native?.prepare?.cmd;
  if (!cmd) {
    return {
      serviceName: input.service.name,
      status: 'no-prepare-cmd',
      cacheFile: '',
      hash: null,
    };
  }

  const manifestDir = path.dirname(input.serviceDoc.file);
  const cacheFile = path.join(input.paths.cacheDir, 'prepare', `${input.service.name}.json`);
  const hash = await computePrepareHash(manifestDir, cmd);

  if (!input.force) {
    const prev = await readPrev(cacheFile);
    if (prev && prev.hash === hash) {
      input.logger.info(
        { service: input.service.name },
        'prepare: lockfile hash unchanged; skipping',
      );
      return { serviceName: input.service.name, status: 'skipped', cacheFile, hash };
    }
  }

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
    event: 'pre_prepare',
    cwd: manifestDir,
    env,
    logger: input.logger,
    ...(input.signal ? { signal: input.signal } : {}),
  });

  input.logger.info({ service: input.service.name, cmd }, 'prepare: starting');

  const cwd = input.service.runtime?.native?.prepare?.cwd
    ? path.resolve(manifestDir, input.service.runtime.native.prepare.cwd)
    : manifestDir;

  // In --verbose mode the prepare command's raw stdout/stderr pass straight
  // through to the terminal; otherwise its output is discarded. No log file.
  const verbose = input.verbose ?? false;
  const shell = input.service.runtime?.native?.prepare?.shell ?? '/bin/sh';
  const opts: ExecaOptions = {
    cwd,
    env: { ...process.env, ...env },
    stdio: verbose ? ['ignore', 'inherit', 'inherit'] : ['ignore', 'ignore', 'ignore'],
    ...(input.signal ? { cancelSignal: input.signal } : {}),
    reject: false,
  };
  try {
    const res = await execa(shell, ['-c', cmd], opts);
    if (res.exitCode !== 0) {
      throw new RuntimeFailure(
        `prepare failed for ${input.service.name} (exit ${res.exitCode}).` +
          (verbose ? '' : ' Re-run with --verbose to see the command output.'),
      );
    }
  } catch (err) {
    if (err instanceof RuntimeFailure) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new RuntimeFailure(`prepare failed for ${input.service.name}: ${message}.`);
  }

  await runHooks({
    hooks: input.service.hooks,
    event: 'post_prepare',
    cwd: manifestDir,
    env,
    logger: input.logger,
    ...(input.signal ? { signal: input.signal } : {}),
  });

  await writeJsonFile(cacheFile, {
    service: input.service.name,
    hash,
    at: new Date().toISOString(),
    cmd,
  });
  return { serviceName: input.service.name, status: 'ok', cacheFile, hash };
}

async function readPrev(file: string): Promise<{ hash: string } | null> {
  if (!(await pathExists(file))) return null;
  try {
    return await readJsonFile<{ hash: string }>(file);
  } catch {
    return null;
  }
}

async function computePrepareHash(manifestDir: string, cmd: string): Promise<string> {
  const hash = createHash('sha256');
  hash.update(`cmd:${cmd}\n`);
  for (const candidate of DEFAULT_LOCK_PATTERNS) {
    const file = path.join(manifestDir, candidate);
    const stat = await safeStat(file);
    if (!stat) {
      hash.update(`missing:${candidate}\n`);
      continue;
    }
    hash.update(`file:${candidate}\nsize:${stat.size}\nmtime:${stat.mtimeMs}\n`);
    const fileHash = await hashFile(file);
    hash.update(`sha:${fileHash}\n`);
  }
  return hash.digest('hex');
}

async function safeStat(file: string): Promise<import('node:fs').Stats | null> {
  try {
    return await fs.stat(file);
  } catch {
    return null;
  }
}

async function hashFile(file: string): Promise<string> {
  const hash = createHash('sha256');
  const stream = createReadStream(file);
  for await (const chunk of stream) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

export class PrepareMissingManifestError extends ManifestError {}
