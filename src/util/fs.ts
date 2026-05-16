import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

export async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

export async function isDirectory(target: string): Promise<boolean> {
  try {
    const s = await fs.stat(target);
    return s.isDirectory();
  } catch {
    return false;
  }
}

export async function isFile(target: string): Promise<boolean> {
  try {
    const s = await fs.stat(target);
    return s.isFile();
  } catch {
    return false;
  }
}

export async function ensureDir(target: string): Promise<void> {
  await fs.mkdir(target, { recursive: true });
}

export async function readJsonFile<T = unknown>(target: string): Promise<T> {
  const raw = await fs.readFile(target, 'utf8');
  return JSON.parse(raw) as T;
}

export async function writeJsonFile(target: string, value: unknown): Promise<void> {
  await ensureDir(path.dirname(target));
  await fs.writeFile(target, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/**
 * Stream a file through SHA-256. Returns the hex digest. Returns null if the
 * file does not exist (so callers can include "missing" as a hash component).
 */
export async function sha256File(target: string): Promise<string | null> {
  try {
    const hash = createHash('sha256');
    const stream = createReadStream(target);
    for await (const chunk of stream) hash.update(chunk as Buffer);
    return hash.digest('hex');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Resolve `~` and `$XDG_CACHE_HOME` against the user's environment for
 * locating qavor's global cache directory.
 */
export function globalCacheDir(env: NodeJS.ProcessEnv = process.env): string {
  const xdg = env.XDG_CACHE_HOME;
  if (xdg && xdg.length > 0) return path.join(xdg, 'qavor');
  const home = env.HOME ?? env.USERPROFILE ?? '/tmp';
  return path.join(home, '.cache', 'qavor');
}
