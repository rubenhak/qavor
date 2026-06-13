import fs from 'node:fs/promises';
import path from 'node:path';
import { type ExecaError, execa, type ResultPromise } from 'execa';
import simpleGit, { type SimpleGit } from 'simple-git';
import { RuntimeFailure } from '../util/exit-codes.js';
import { isDirectory } from '../util/fs.js';

export interface GitRunOptions {
  cwd: string;
  signal?: AbortSignal;
  /** Subprocess env merged on top of process.env. */
  env?: Record<string, string>;
}

/**
 * Run a `git` subcommand asynchronously via execa. Returns stdout text on
 * success. Throws RuntimeFailure with the underlying command + stderr tail
 * on non-zero exit.
 */
export async function runGit(args: string[], opts: GitRunOptions): Promise<string> {
  let child: ResultPromise;
  try {
    child = execa('git', args, {
      cwd: opts.cwd,
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
      ...(opts.signal ? { cancelSignal: opts.signal } : {}),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const res = await child;
    return typeof res.stdout === 'string' ? res.stdout : '';
  } catch (err) {
    const ee = err as ExecaError;
    const stderr = typeof ee.stderr === 'string' ? ee.stderr : '';
    const stdout = typeof ee.stdout === 'string' ? ee.stdout : '';
    const code = ee.exitCode ?? -1;
    const tail = stderr.trim() || stdout.trim() || ee.shortMessage || ee.message;
    throw new RuntimeFailure(`git ${args.join(' ')} (exit ${code}) in ${opts.cwd}\n  ${tail}`);
  }
}

/** True when `dir` is a git working tree (contains .git or is bare). */
export async function isGitRepo(dir: string): Promise<boolean> {
  if (!(await isDirectory(dir))) return false;
  try {
    await fs.access(path.join(dir, '.git'));
    return true;
  } catch {
    // Maybe bare or worktree; fall back to running git
    try {
      const out = await runGit(['rev-parse', '--is-inside-work-tree'], { cwd: dir });
      return out.trim() === 'true';
    } catch {
      return false;
    }
  }
}

export interface RepoStatus {
  branch: string | null;
  ahead: number;
  behind: number;
  dirtyCount: number;
  /** Short last commit oid (7 chars), or null if no commits yet. */
  lastCommit: string | null;
  lastCommitSubject: string | null;
}

export async function readRepoStatus(dir: string): Promise<RepoStatus> {
  const git: SimpleGit = simpleGit({ baseDir: dir });
  let branch: string | null = null;
  try {
    const summary = await git.branch();
    branch = summary.current || null;
  } catch {
    branch = null;
  }
  let ahead = 0;
  let behind = 0;
  try {
    const counts = await runGit(['rev-list', '--left-right', '--count', '@{u}...HEAD'], {
      cwd: dir,
    });
    const [b, a] = counts
      .trim()
      .split(/\s+/)
      .map((n) => Number.parseInt(n, 10));
    behind = Number.isFinite(b) ? (b ?? 0) : 0;
    ahead = Number.isFinite(a) ? (a ?? 0) : 0;
  } catch {
    /* no upstream */
  }
  let dirtyCount = 0;
  try {
    const status = await git.status();
    dirtyCount = status.files.length;
  } catch {
    /* ignore */
  }
  let lastCommit: string | null = null;
  let lastCommitSubject: string | null = null;
  try {
    const log = await git.log({ maxCount: 1 });
    if (log.latest) {
      lastCommit = log.latest.hash.slice(0, 7);
      lastCommitSubject = log.latest.message;
    }
  } catch {
    /* ignore */
  }
  return { branch, ahead, behind, dirtyCount, lastCommit, lastCommitSubject };
}

export interface CloneOptions {
  url: string;
  /** Destination directory. */
  dest: string;
  branch?: string | undefined;
  tag?: string | undefined;
  commit?: string | undefined;
  shallow?: boolean | undefined;
  submodules?: boolean | undefined;
  signal?: AbortSignal | undefined;
}

export async function gitClone(opts: CloneOptions): Promise<void> {
  const args: string[] = ['clone'];
  if (opts.branch && !opts.commit) args.push('--branch', opts.branch);
  else if (opts.tag && !opts.commit) args.push('--branch', opts.tag);
  if (opts.shallow) args.push('--depth', '1');
  if (opts.submodules) args.push('--recurse-submodules');
  args.push('--', opts.url, opts.dest);
  await fs.mkdir(path.dirname(opts.dest), { recursive: true });
  const runOpts: GitRunOptions = { cwd: path.dirname(opts.dest) };
  if (opts.signal) runOpts.signal = opts.signal;
  await runGit(args, runOpts);
  if (opts.commit) {
    const checkoutOpts: GitRunOptions = { cwd: opts.dest };
    if (opts.signal) checkoutOpts.signal = opts.signal;
    await runGit(['checkout', opts.commit], checkoutOpts);
  }
}

export async function gitFetch(dir: string, signal?: AbortSignal): Promise<void> {
  const opts: GitRunOptions = { cwd: dir };
  if (signal) opts.signal = signal;
  await runGit(['fetch', '--prune'], opts);
}

export async function gitPullFastForward(dir: string, signal?: AbortSignal): Promise<void> {
  const opts: GitRunOptions = { cwd: dir };
  if (signal) opts.signal = signal;
  await runGit(['pull', '--ff-only'], opts);
}

export async function gitCommit(
  dir: string,
  message: string,
  opts: { allowEmpty?: boolean; files?: string[]; noVerify?: boolean; signal?: AbortSignal } = {},
): Promise<{ committed: boolean }> {
  const status = await runGit(['status', '--porcelain'], { cwd: dir });
  if (status.trim().length === 0 && !opts.allowEmpty) {
    return { committed: false };
  }
  const addOpts: GitRunOptions = { cwd: dir };
  if (opts.signal) addOpts.signal = opts.signal;
  // Stage only the requested paths when given; otherwise stage everything.
  if (opts.files && opts.files.length > 0) {
    await runGit(['add', '--', ...opts.files], addOpts);
  } else {
    await runGit(['add', '-A'], addOpts);
  }
  const args = ['commit', '-m', message];
  if (opts.allowEmpty) args.push('--allow-empty');
  if (opts.noVerify) args.push('--no-verify');
  const commitOpts: GitRunOptions = { cwd: dir };
  if (opts.signal) commitOpts.signal = opts.signal;
  await runGit(args, commitOpts);
  return { committed: true };
}

export async function gitPush(dir: string, signal?: AbortSignal): Promise<void> {
  const opts: GitRunOptions = { cwd: dir };
  if (signal) opts.signal = signal;
  await runGit(['push'], opts);
}

/**
 * Compose a clone URL from project-level `git` config + repo name. Honors:
 *   - explicit `url` (passthrough),
 *   - `git.root_url` + `git.repo_prefix` + name,
 *   - the conventional suffix `.git` on the URL.
 */
export interface UrlDeriveInput {
  rootUrl?: string | undefined;
  repoPrefix?: string | undefined;
  name: string;
  explicitUrl?: string | undefined;
}

export function deriveCloneUrl(input: UrlDeriveInput): string {
  if (input.explicitUrl) return input.explicitUrl;
  if (!input.rootUrl) {
    throw new RuntimeFailure(
      `Cannot derive clone URL for '${input.name}': project manifest has no git.root_url and no explicit url is set.`,
    );
  }
  const prefix = input.repoPrefix ?? '';
  const base = input.rootUrl.endsWith('/') ? input.rootUrl.slice(0, -1) : input.rootUrl;
  const fullName = `${prefix}${input.name}`;
  return `${base}/${fullName}.git`;
}
