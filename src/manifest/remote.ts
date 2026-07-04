import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pMap from 'p-map';
import { gitClone } from '../git/git.js';
import { ManifestError, RuntimeFailure, UserError } from '../util/exit-codes.js';
import { ensureDir, globalCacheDir, pathExists } from '../util/fs.js';
import { getLogger } from '../util/logger.js';
import type { RegistryEntry } from './discovery.js';
import { parseManifestSource } from './loader.js';
import type { ProfileRef, ProfileSource } from './types/index.js';
import { type ValidationIssue, validateDocument } from './validator.js';

/** Matches a bare workspace-local profile name (mirrors the `name` schema def). */
const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,62}$/;

const FETCH_TIMEOUT_MS = 30_000;

export interface RemoteProfileOptions {
  /** Bounded fan-out for concurrent fetches. */
  concurrency?: number;
  /** Use cached copies only; never touch the network. */
  offline?: boolean;
  /** Bypass caches and re-fetch every source. */
  refresh?: boolean;
  /** Environment used to resolve `auth.tokenEnv`. Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** Cancellation for the whole pass. */
  signal?: AbortSignal;
  /** Override the global cache root (tests). Defaults to `globalCacheDir()`. */
  cacheRoot?: string;
}

type Backend = 'file' | 'http' | 'github' | 'git';

interface RemoteSource {
  backend: Backend;
  /** Fetch target: an https URL (http/github), a filesystem path (file), or a
   * git repo URL (git). */
  target: string;
  /** In-repo path for git sources. */
  gitSubpath?: string;
  /** Git ref (branch/tag/commit) for git sources. */
  gitRef?: string;
  /** Optional sha256 pin as lowercase hex (fragment or `integrity` field). */
  pin?: string;
  /** Env var holding a bearer token (http/github). */
  tokenEnv?: string;
  /** Expected/override profile name from the long-form object. */
  expectedName?: string;
  /** Original reference text, used verbatim as the diagnostic `file`. */
  label: string;
  /** Dedup identity: same key ⇒ same fetched document. */
  key: string;
}

export type ClassifiedRef =
  | { kind: 'local'; name: string }
  | { kind: 'remote'; source: RemoteSource };

/**
 * Classify a single `profiles:` entry as a bare workspace-local name or a remote
 * source. `baseDir` is the referencing manifest's directory, used to resolve a
 * relative `file` path given via the long-form object.
 */
export function classifyRef(ref: ProfileRef, baseDir: string): ClassifiedRef {
  if (typeof ref === 'string') {
    if (NAME_RE.test(ref)) return { kind: 'local', name: ref };
    return { kind: 'remote', source: parseSource(ref, undefined, baseDir) };
  }
  // Long-form object.
  return { kind: 'remote', source: parseSource(ref.url, ref, baseDir) };
}

function parseSource(
  rawUrl: string,
  obj: ProfileSource | undefined,
  baseDir: string,
): RemoteSource {
  // Peel an optional `#sha256=<hex>` fragment from the string form.
  let url = rawUrl;
  let pin = normalizePin(obj?.integrity);
  const frag = url.indexOf('#sha256=');
  if (frag >= 0) {
    pin = normalizePin(`sha256-${url.slice(frag + '#sha256='.length)}`) ?? pin;
    url = url.slice(0, frag);
  }

  const tokenEnv = obj?.auth?.tokenEnv;
  const expectedName = obj?.name;
  const inlineRef = obj?.ref;

  const base = { pin, tokenEnv, expectedName, label: rawUrl };

  // A `.git//<path>` marker means "read a file out of a git repo" regardless of
  // transport (git@, ssh://, https://, or a local file:// remote used by tests),
  // so it is checked before the plain file:// / http(s) branches claim the URL.
  if (
    url.startsWith('git@') ||
    url.startsWith('git://') ||
    url.startsWith('ssh://') ||
    url.includes('.git//')
  ) {
    return gitSource(url, inlineRef, base);
  }
  if (url.startsWith('file://')) {
    const p = fileURLToPath(url);
    return { ...base, backend: 'file', target: p, key: `file:${p}` };
  }
  if (url.startsWith('github:')) {
    const gh = normalizeGithub(url, inlineRef);
    return { ...base, backend: 'github', target: gh, key: `github:${gh}` };
  }
  if (url.startsWith('http://') || url.startsWith('https://')) {
    if (/^https?:\/\/(www\.)?github\.com\//.test(url) && url.includes('/blob/')) {
      const gh = normalizeGithub(url, inlineRef);
      return { ...base, backend: 'github', target: gh, key: `github:${gh}` };
    }
    return { ...base, backend: 'http', target: url, key: `http:${url}` };
  }
  // No scheme: only reachable via the long-form object `url`. Treat as a local
  // file path relative to the referencing manifest.
  const p = path.resolve(baseDir, url);
  return { ...base, backend: 'file', target: p, key: `file:${p}` };
}

function normalizePin(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const m = /^sha256-([A-Fa-f0-9]{64})$/.exec(raw);
  return m?.[1]?.toLowerCase();
}

/**
 * Normalize a GitHub reference to a `raw.githubusercontent.com` URL.
 *  - `github:owner/repo//path[@ref]`
 *  - `https://github.com/owner/repo/blob/<ref>/<path>`
 *  - `https://raw.githubusercontent.com/...` (passthrough)
 */
function normalizeGithub(url: string, inlineRef: string | undefined): string {
  if (url.startsWith('https://raw.githubusercontent.com/')) return url;
  if (url.startsWith('github:')) {
    const rest = url.slice('github:'.length);
    const sep = rest.indexOf('//');
    if (sep < 0) throw new ManifestError(`GitHub profile source needs '//<path>': ${url}`);
    const repo = rest.slice(0, sep).replace(/\.git$/, '');
    let subpath = rest.slice(sep + 2);
    let ref = inlineRef;
    const at = subpath.lastIndexOf('@');
    if (at >= 0) {
      ref = subpath.slice(at + 1);
      subpath = subpath.slice(0, at);
    }
    return `https://raw.githubusercontent.com/${repo}/${ref ?? 'HEAD'}/${subpath}`;
  }
  // https://github.com/<owner>/<repo>/blob/<ref>/<path...>
  const m = /^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+)$/.exec(url);
  if (!m) throw new ManifestError(`Unrecognized GitHub profile URL: ${url}`);
  const [, owner, repo, ref, subpath] = m;
  return `https://raw.githubusercontent.com/${owner}/${repo}/${inlineRef ?? ref}/${subpath}`;
}

function gitSource(
  url: string,
  inlineRef: string | undefined,
  base: Pick<RemoteSource, 'pin' | 'tokenEnv' | 'expectedName' | 'label'>,
): RemoteSource {
  // Repo and in-repo path are separated by `//`. A URL's scheme also contains
  // `//`, so the *last* `//` is the separator.
  const sep = url.lastIndexOf('//');
  if (sep <= 0) throw new ManifestError(`git profile source needs '//<path>': ${url}`);
  const repo = url.slice(0, sep);
  let subpath = url.slice(sep + 2);
  let ref = inlineRef;
  const at = subpath.lastIndexOf('@');
  if (at >= 0) {
    ref = subpath.slice(at + 1);
    subpath = subpath.slice(0, at);
  }
  if (subpath.length === 0) throw new ManifestError(`git profile source needs '//<path>': ${url}`);
  return {
    ...base,
    backend: 'git',
    target: repo,
    gitSubpath: subpath,
    gitRef: ref,
    key: `git:${repo}//${subpath}@${ref ?? ''}`,
  };
}

/** Strip credentials from a URL before it reaches a log line. */
function redact(url: string): string {
  return url.replace(/\/\/[^@/]+@/, '//');
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** Collect the remote refs declared on one entry's `profiles:` list. */
function remoteRefsOf(entry: RegistryEntry): RemoteSource[] {
  const profiles = (entry.data as { profiles?: unknown }).profiles;
  if (!Array.isArray(profiles)) return [];
  const out: RemoteSource[] = [];
  for (const ref of profiles) {
    const cls = classifyRef(ref as ProfileRef, entry.dir);
    if (cls.kind === 'remote') out.push(cls.source);
  }
  return out;
}

/**
 * Fetch, validate, and register every remote profile referenced across the
 * workspace, rewriting each remote `profiles:` entry to the bare name of the
 * fetched profile so the existing name-based resolver (manifest/resolve.ts) runs
 * unchanged. Mutates `all` (appends synthetic profile entries) and pushes issues.
 *
 * No-op — and zero network cost — when nothing declares a remote reference.
 */
export async function resolveRemoteProfiles(
  all: RegistryEntry[],
  issues: ValidationIssue[],
  opts: RemoteProfileOptions = {},
): Promise<void> {
  const hasRemote = all.some((e) => remoteRefsOf(e).length > 0);
  if (!hasRemote) return;

  const env = opts.env ?? process.env;
  const cacheRoot = opts.cacheRoot ?? globalCacheDir(env);
  // sourceKey → resolved profile name (present ⇒ fetched OK).
  const resolved = new Map<string, string>();
  // sourceKey → issue already recorded (present ⇒ fetch failed).
  const failed = new Set<string>();

  let frontier = all.slice();
  while (true) {
    const toFetch = new Map<string, RemoteSource>();
    for (const entry of frontier) {
      for (const source of remoteRefsOf(entry)) {
        if (resolved.has(source.key) || failed.has(source.key)) continue;
        if (!toFetch.has(source.key)) toFetch.set(source.key, source);
      }
    }
    if (toFetch.size === 0) break;

    const results = await pMap(
      [...toFetch.values()],
      async (source) => {
        try {
          const entry = await fetchAndBuildEntry(source, cacheRoot, env, opts);
          return { ok: true as const, source, entry };
        } catch (err) {
          return { ok: false as const, source, error: err };
        }
      },
      { concurrency: opts.concurrency ?? 8 },
    );

    const next: RegistryEntry[] = [];
    for (const r of results) {
      if (!r.ok) {
        failed.add(r.source.key);
        issues.push(issueFor(r.source, r.error));
        continue;
      }
      const entry = r.entry;
      // Expected-name mismatch is a manifest error, but we still register under
      // the declared name so downstream refs resolve rather than cascade.
      if (r.source.expectedName && entry.name !== r.source.expectedName) {
        issues.push({
          file: r.source.label,
          line: 1,
          column: 1,
          kind: 'profile',
          path: '/name',
          message: `Remote profile '${redact(r.source.label)}' declares name '${entry.name}', expected '${r.source.expectedName}'.`,
        });
      }
      resolved.set(r.source.key, entry.name);
      all.push(entry);
      next.push(entry);
    }
    // Only newly-fetched profiles can introduce not-yet-seen remote refs.
    frontier = next;
  }

  // Rewrite every remote ref to the resolved bare name; drop refs whose fetch
  // failed (the precise error is already recorded, so the build fails closed
  // without a confusing "profile not defined" cascade).
  for (const entry of all) {
    const profiles = (entry.data as { profiles?: unknown }).profiles;
    if (!Array.isArray(profiles)) continue;
    const rewritten: string[] = [];
    for (const ref of profiles) {
      const cls = classifyRef(ref as ProfileRef, entry.dir);
      if (cls.kind === 'local') {
        rewritten.push(cls.name);
        continue;
      }
      const name = resolved.get(cls.source.key);
      if (name) rewritten.push(name);
    }
    (entry.data as { profiles?: unknown }).profiles = rewritten;
  }
}

function issueFor(source: RemoteSource, err: unknown): ValidationIssue {
  const message = err instanceof Error ? err.message : String(err);
  return {
    file: source.label,
    line: 1,
    column: 1,
    kind: 'profile',
    path: '/profiles',
    message: `Failed to resolve remote profile '${redact(source.label)}': ${message}`,
  };
}

/**
 * Fetch a remote source, verify its optional pin, parse+validate it as a
 * `kind: profile` document, and build a synthetic registry entry for it.
 */
async function fetchAndBuildEntry(
  source: RemoteSource,
  cacheRoot: string,
  env: NodeJS.ProcessEnv,
  opts: RemoteProfileOptions,
): Promise<RegistryEntry> {
  const { content, dir } = await fetchContent(source, cacheRoot, env, opts);
  if (source.pin) {
    const got = sha256Hex(content);
    if (got !== source.pin) {
      throw new RuntimeFailure(
        `Integrity check failed for '${redact(source.label)}': expected sha256 ${source.pin}, got ${got}.`,
      );
    }
  }

  const docs = parseManifestSource(content, source.label);
  const doc = docs.find((d) => d.kind === 'profile') ?? docs[0];
  if (!doc) throw new ManifestError(`Remote profile '${redact(source.label)}' is empty.`);
  if (doc.kind !== 'profile') {
    throw new ManifestError(
      `Remote profile '${redact(source.label)}' is kind '${doc.kind ?? 'unknown'}', expected 'profile'.`,
    );
  }
  const result = validateDocument(doc);
  if (!result.ok) {
    const first = result.issues[0];
    throw new ManifestError(
      first ? `${first.file}:${first.line}:${first.column}: ${first.message}` : 'invalid profile',
    );
  }
  const name = typeof doc.data.name === 'string' ? doc.data.name : '';

  return {
    kind: 'profile',
    name,
    file: source.label,
    docIndex: doc.docIndex,
    dir,
    data: doc.data,
    position: doc.position,
    remoteSource: source.label,
  };
}

interface FetchedContent {
  content: string;
  /** Directory to resolve the fetched profile's own relative refs against. */
  dir: string;
}

async function fetchContent(
  source: RemoteSource,
  cacheRoot: string,
  env: NodeJS.ProcessEnv,
  opts: RemoteProfileOptions,
): Promise<FetchedContent> {
  switch (source.backend) {
    case 'file':
      return fetchFile(source);
    case 'http':
    case 'github':
      return fetchHttp(source, cacheRoot, env, opts);
    case 'git':
      return fetchGit(source, cacheRoot, opts);
  }
}

async function fetchFile(source: RemoteSource): Promise<FetchedContent> {
  try {
    const content = await fs.readFile(source.target, 'utf8');
    return { content, dir: path.dirname(source.target) };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new RuntimeFailure(`Local profile source not found: ${source.target}`);
    }
    throw err;
  }
}

async function fetchHttp(
  source: RemoteSource,
  cacheRoot: string,
  env: NodeJS.ProcessEnv,
  opts: RemoteProfileOptions,
): Promise<FetchedContent> {
  const cacheDir = path.join(cacheRoot, 'profiles');
  const cacheFile = path.join(cacheDir, `${sha256Hex(source.key)}.yaml`);

  if (!opts.refresh && (await pathExists(cacheFile))) {
    const cached = await fs.readFile(cacheFile, 'utf8');
    // A pinned source with a matching cache is deterministic — use it offline.
    if (!source.pin || sha256Hex(cached) === source.pin) {
      return { content: cached, dir: cacheDir };
    }
  }
  if (opts.offline) {
    throw new RuntimeFailure(`Offline: no cached copy of profile '${redact(source.target)}'.`);
  }

  if (source.target.startsWith('http://') && !isLoopback(source.target)) {
    getLogger().warn(
      { url: redact(source.target) },
      'fetching profile over insecure http://; prefer https',
    );
  }

  const headers: Record<string, string> = {};
  if (source.tokenEnv) {
    const token = env[source.tokenEnv];
    if (!token) {
      throw new UserError(
        `Auth env '${source.tokenEnv}' for profile '${redact(source.target)}' is not set.`,
      );
    }
    headers.Authorization = `Bearer ${token}`;
  }

  const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
  let res: Response;
  try {
    res = await fetch(source.target, { headers, redirect: 'follow', signal });
  } catch (err) {
    throw new RuntimeFailure(
      `Failed to fetch profile '${redact(source.target)}': ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!res.ok) {
    throw new RuntimeFailure(
      `Failed to fetch profile '${redact(source.target)}': HTTP ${res.status} ${res.statusText}.`,
    );
  }
  const content = await res.text();
  await ensureDir(cacheDir);
  await fs.writeFile(cacheFile, content, 'utf8');
  return { content, dir: cacheDir };
}

function isLoopback(url: string): boolean {
  try {
    const h = new URL(url).hostname;
    return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]';
  } catch {
    return false;
  }
}

async function fetchGit(
  source: RemoteSource,
  cacheRoot: string,
  opts: RemoteProfileOptions,
): Promise<FetchedContent> {
  const repoDir = path.join(cacheRoot, 'profiles-git', sha256Hex(source.target).slice(0, 16));
  const exists = await pathExists(path.join(repoDir, '.git'));

  if (opts.refresh && exists) {
    if (opts.offline)
      throw new RuntimeFailure('Cannot --refresh a git profile source while offline.');
    await fs.rm(repoDir, { recursive: true, force: true });
  }
  if (!(await pathExists(path.join(repoDir, '.git')))) {
    if (opts.offline) {
      throw new RuntimeFailure(
        `Offline: no cached clone of profile repo '${redact(source.target)}'.`,
      );
    }
    await gitClone({
      url: source.target,
      dest: repoDir,
      ...(source.gitRef ? { commit: source.gitRef } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
  }

  const filePath = path.join(repoDir, source.gitSubpath ?? '');
  try {
    const content = await fs.readFile(filePath, 'utf8');
    return { content, dir: path.dirname(filePath) };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new RuntimeFailure(
        `Profile '${source.gitSubpath}' not found in repo '${redact(source.target)}'` +
          (source.gitRef ? ` at ref '${source.gitRef}'.` : '.'),
      );
    }
    throw err;
  }
}
