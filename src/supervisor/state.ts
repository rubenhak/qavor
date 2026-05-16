import fs from 'node:fs/promises';
import path from 'node:path';
import { pathExists, readJsonFile, writeJsonFile } from '../util/fs.js';
import type { WorkspacePaths } from '../workspace/paths.js';

export type SupervisorStatus = 'running' | 'stopped' | 'crashed' | 'unknown';

export interface SupervisorState {
  service: string;
  pid: number;
  pgid: number;
  startedAt: string;
  cmd: string;
  cwd: string;
  logFile: string;
  status: SupervisorStatus;
  /** Last known exit code, if the process has been observed exiting. */
  exitCode?: number;
  /** Last update timestamp. */
  updatedAt: string;
}

export function stateFile(paths: WorkspacePaths, service: string): string {
  return path.join(paths.stateDir, `${service}.json`);
}

export async function readState(paths: WorkspacePaths, service: string): Promise<SupervisorState | null> {
  const file = stateFile(paths, service);
  if (!(await pathExists(file))) return null;
  try {
    return await readJsonFile<SupervisorState>(file);
  } catch {
    return null;
  }
}

export async function writeState(paths: WorkspacePaths, state: SupervisorState): Promise<void> {
  state.updatedAt = new Date().toISOString();
  await writeJsonFile(stateFile(paths, state.service), state);
}

export async function clearState(paths: WorkspacePaths, service: string): Promise<void> {
  const file = stateFile(paths, service);
  try {
    await fs.unlink(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

/**
 * Synchronously check whether a tracked PID is still alive. We do not use
 * fs.existsSync — this is a signal-0 probe which is allowed on the hot path
 * because there's no file IO involved.
 */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'EPERM') return true;
    return false;
  }
}

export async function listSupervisorStates(paths: WorkspacePaths): Promise<SupervisorState[]> {
  const out: SupervisorState[] = [];
  if (!(await pathExists(paths.stateDir))) return out;
  const entries = await fs.readdir(paths.stateDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    try {
      const state = await readJsonFile<SupervisorState>(path.join(paths.stateDir, entry.name));
      out.push(state);
    } catch {
      /* corrupt state files are ignored */
    }
  }
  return out;
}
