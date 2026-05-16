import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { pathExists } from '../util/fs.js';

export interface TailOptions {
  /** Path to the log file. */
  file: string;
  /** Stream to write decoded UTF-8 chunks to. */
  out: NodeJS.WritableStream;
  /** When true, keep watching for appended bytes. */
  follow: boolean;
  /** AbortSignal to terminate follow loop. */
  signal?: AbortSignal;
  /** Number of bytes from the tail to read initially (default 16KB). */
  initialBytes?: number;
}

/**
 * Print the tail of a log file. Optionally follows new appends using
 * `fs.watch` (event-driven) plus a stat-based polling fallback.
 */
export async function tailFile(opts: TailOptions): Promise<void> {
  if (!(await pathExists(opts.file))) {
    if (!opts.follow) return;
    // Wait for the file to appear when following.
    await waitForFile(opts.file, opts.signal);
  }
  let offset = await initialOffset(opts.file, opts.initialBytes ?? 16 * 1024);
  await streamFrom(opts.file, offset, opts.out);
  if (!opts.follow) return;

  let stat = await fs.stat(opts.file);
  offset = stat.size;

  const watcher = fs.watch(opts.file, { persistent: true });
  const abort = opts.signal ?? new AbortController().signal;

  const pollTimer = setInterval(async () => {
    try {
      const cur = await fs.stat(opts.file);
      if (cur.size < offset) {
        offset = 0; // rotated
      }
      if (cur.size > offset) {
        await streamFrom(opts.file, offset, opts.out);
        offset = cur.size;
      }
    } catch {
      /* ignore */
    }
  }, 500);

  try {
    for await (const _event of watcher) {
      if (abort.aborted) break;
      const cur = await fs.stat(opts.file).catch(() => null);
      if (!cur) continue;
      if (cur.size < offset) {
        offset = 0;
      }
      if (cur.size > offset) {
        await streamFrom(opts.file, offset, opts.out);
        offset = cur.size;
      }
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ABORT_ERR') return;
    throw err;
  } finally {
    clearInterval(pollTimer);
  }
}

async function initialOffset(file: string, fromEndBytes: number): Promise<number> {
  const st = await fs.stat(file);
  return Math.max(0, st.size - fromEndBytes);
}

async function streamFrom(file: string, start: number, out: NodeJS.WritableStream): Promise<void> {
  return new Promise((resolve, reject) => {
    const rs = createReadStream(file, { start, encoding: 'utf8' });
    rs.on('data', (chunk) => out.write(chunk as string));
    rs.on('end', () => resolve());
    rs.on('error', (err) => reject(err));
  });
}

async function waitForFile(file: string, signal?: AbortSignal): Promise<void> {
  const dir = path.dirname(file);
  await fs.mkdir(dir, { recursive: true });
  for (;;) {
    if (signal?.aborted) return;
    if (await pathExists(file)) return;
    await new Promise((r) => setTimeout(r, 250));
  }
}
