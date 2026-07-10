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
  /**
   * Directory-form source (path does not end in `.yaml`/`.yml`): the profile is
   * read from `<path>/qavor.yaml` and the whole directory is materialized so the
   * profile's steps can reference sibling files (compose files, configs).
   */
  dirForm?: boolean;
  /** Structured GitHub coordinates (github backend only). */
  gh?: { owner: string; repo: string; ref?: string; subpath: string };
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

/** The conventional profile filename inside a directory-form source. */
const DIR_PROFILE_FILE = 'qavor.yaml';

/** Safety caps for GitHub directory fetches. */
const MAX_DIR_FILES = 100;
const MAX_DIR_BYTES = 10 * 1024 * 1024;

/** A source path that does not name a YAML document is a directory reference. */
function isDirPath(p: string): boolean {
  return !/\.ya?ml$/i.test(p);
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
    return { ...base, backend: 'file', target: p, dirForm: isDirPath(p), key: `file:${p}` };
  }
  if (url.startsWith('github:')) {
    return githubSource(parseGithub(url, inlineRef), base);
  }
  if (url.startsWith('http://') || url.startsWith('https://')) {
    if (
      /^https?:\/\/(www\.)?github\.com\//.test(url) &&
      (url.includes('/blob/') || url.includes('/tree/'))
    ) {
      return githubSource(parseGithub(url, inlineRef), base);
    }
    if (url.startsWith('https://raw.githubusercontent.com/')) {
      return githubSource(parseGithub(url, inlineRef), base);
    }
    // Plain https cannot enumerate a directory — only a direct YAML document
    // reference is supported. Directory references need github:/git/file.
    if (isDirPath(new URL(url).pathname)) {
      throw new ManifestError(
        `Directory profile sources are not supported for plain https URLs (${url}). ` +
          `Point at the qavor.yaml document directly, or use a github:/git/file:// source.`,
      );
    }
    return { ...base, backend: 'http', target: url, key: `http:${url}` };
  }
  // No scheme: only reachable via the long-form object `url`. Treat as a local
  // file path relative to the referencing manifest.
  const p = path.resolve(baseDir, url);
  return { ...base, backend: 'file', target: p, dirForm: isDirPath(p), key: `file:${p}` };
}

/** Build a github-backend source from parsed coordinates. */
function githubSource(
  gh: NonNullable<RemoteSource['gh']>,
  base: Pick<RemoteSource, 'pin' | 'tokenEnv' | 'expectedName' | 'label'>,
): RemoteSource {
  const dirForm = isDirPath(gh.subpath);
  const canonical = `${gh.owner}/${gh.repo}/${gh.ref ?? 'HEAD'}/${gh.subpath}`;
  return {
    ...base,
    backend: 'github',
    // File-form target is the raw-content URL consumed by the http fetcher;
    // directory-form fetches derive URLs from the structured coordinates.
    target: `https://raw.githubusercontent.com/${canonical}`,
    gh,
    dirForm,
    key: `github:${canonical}`,
  };
}

function normalizePin(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const m = /^sha256-([A-Fa-f0-9]{64})$/.exec(raw);
  return m?.[1]?.toLowerCase();
}

/**
 * Parse a GitHub reference into structured coordinates.
 *  - `github:owner/repo//path[@ref]` (path may be a file or a directory)
 *  - `https://github.com/owner/repo/blob/<ref>/<path>` (file)
 *  - `https://github.com/owner/repo/tree/<ref>/<path>` (directory)
 *  - `https://raw.githubusercontent.com/owner/repo/<ref>/<path>`
 */
function parseGithub(url: string, inlineRef: string | undefined): NonNullable<RemoteSource['gh']> {
  if (url.startsWith('github:')) {
    const rest = url.slice('github:'.length);
    const sep = rest.indexOf('//');
    if (sep < 0) throw new ManifestError(`GitHub profile source needs '//<path>': ${url}`);
    const repoPart = rest.slice(0, sep).replace(/\.git$/, '');
    const slash = repoPart.indexOf('/');
    if (slash <= 0) throw new ManifestError(`GitHub profile source needs '<owner>/<repo>': ${url}`);
    const owner = repoPart.slice(0, slash);
    const repo = repoPart.slice(slash + 1);
    let subpath = rest.slice(sep + 2).replace(/\/+$/, '');
    let ref = inlineRef;
    const at = subpath.lastIndexOf('@');
    if (at >= 0) {
      ref = subpath.slice(at + 1);
      subpath = subpath.slice(0, at);
    }
    if (subpath.length === 0) {
      throw new ManifestError(`GitHub profile source needs '//<path>': ${url}`);
    }
    return { owner, repo, ...(ref ? { ref } : {}), subpath };
  }
  const raw = /^https:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/.exec(url);
  if (raw) {
    const [, owner, repo, ref, subpath] = raw;
    return {
      owner: owner as string,
      repo: repo as string,
      ref: (inlineRef ?? ref) as string,
      subpath: (subpath as string).replace(/\/+$/, ''),
    };
  }
  // https://github.com/<owner>/<repo>/(blob|tree)/<ref>/<path...>
  const m =
    /^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+)\/(?:blob|tree)\/([^/]+)\/(.+)$/.exec(url);
  if (!m) throw new ManifestError(`Unrecognized GitHub profile URL: ${url}`);
  const [, owner, repo, ref, subpath] = m;
  return {
    owner: owner as string,
    repo: repo as string,
    ref: (inlineRef ?? ref) as string,
    subpath: (subpath as string).replace(/\/+$/, ''),
  };
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
  subpath = subpath.replace(/\/+$/, '');
  return {
    ...base,
    backend: 'git',
    target: repo,
    gitSubpath: subpath,
    gitRef: ref,
    dirForm: isDirPath(subpath),
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
      return fetchHttp(source, cacheRoot, env, opts);
    case 'github':
      return source.dirForm
        ? fetchGithubDir(source, cacheRoot, env, opts)
        : fetchHttp(source, cacheRoot, env, opts);
    case 'git':
      return fetchGit(source, cacheRoot, opts);
  }
}

async function fetchFile(source: RemoteSource): Promise<FetchedContent> {
  const profilePath = source.dirForm ? path.join(source.target, DIR_PROFILE_FILE) : source.target;
  try {
    const content = await fs.readFile(profilePath, 'utf8');
    return { content, dir: source.dirForm ? source.target : path.dirname(profilePath) };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new RuntimeFailure(`Local profile source not found: ${profilePath}`);
    }
    throw err;
  }
}

/** Bearer-token headers for http/github sources; fails when the env var is unset. */
function authHeaders(source: RemoteSource, env: NodeJS.ProcessEnv): Record<string, string> {
  if (!source.tokenEnv) return {};
  const token = env[source.tokenEnv];
  if (!token) {
    throw new UserError(
      `Auth env '${source.tokenEnv}' for profile '${redact(source.label)}' is not set.`,
    );
  }
  return { Authorization: `Bearer ${token}` };
}

/** One timeout-bounded GET; network errors and non-2xx map to RuntimeFailure. */
async function httpGet(
  url: string,
  headers: Record<string, string>,
  opts: RemoteProfileOptions,
): Promise<Response> {
  const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
  let res: Response;
  try {
    res = await fetch(url, { headers, redirect: 'follow', signal });
  } catch (err) {
    throw new RuntimeFailure(
      `Failed to fetch profile '${redact(url)}': ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!res.ok) {
    throw new RuntimeFailure(
      `Failed to fetch profile '${redact(url)}': HTTP ${res.status} ${res.statusText}.`,
    );
  }
  return res;
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

  const res = await httpGet(source.target, authHeaders(source, env), opts);
  const content = await res.text();
  await ensureDir(cacheDir);
  await fs.writeFile(cacheFile, content, 'utf8');
  return { content, dir: cacheDir };
}

/** Shape of the GitHub git-trees API response (fields we consume). */
interface GithubTree {
  truncated?: boolean;
  tree?: { path?: string; type?: string; size?: number }[];
}

/**
 * Materialize a GitHub directory source: list the repo tree via the GitHub API,
 * download every blob under the referenced directory from raw.githubusercontent
 * into a per-source cache directory, and read `<dir>/qavor.yaml` as the profile.
 * A cached copy (keyed by owner/repo/ref/path) is reused until `--refresh`.
 */
async function fetchGithubDir(
  source: RemoteSource,
  cacheRoot: string,
  env: NodeJS.ProcessEnv,
  opts: RemoteProfileOptions,
): Promise<FetchedContent> {
  const gh = source.gh;
  if (!gh) throw new RuntimeFailure(`GitHub source '${redact(source.label)}' missing coordinates.`);
  const cacheDir = path.join(cacheRoot, 'profiles', sha256Hex(source.key).slice(0, 16));
  const profilePath = path.join(cacheDir, DIR_PROFILE_FILE);

  if (!opts.refresh && (await pathExists(profilePath))) {
    const cached = await fs.readFile(profilePath, 'utf8');
    if (!source.pin || sha256Hex(cached) === source.pin) {
      return { content: cached, dir: cacheDir };
    }
  }
  if (opts.offline) {
    throw new RuntimeFailure(
      `Offline: no cached copy of profile directory '${redact(source.label)}'.`,
    );
  }

  const headers = { Accept: 'application/vnd.github+json', ...authHeaders(source, env) };

  // Resolve the ref: an explicit @ref wins; otherwise the repo's default branch.
  let ref = gh.ref;
  if (!ref) {
    const meta = await httpGet(
      `https://api.github.com/repos/${gh.owner}/${gh.repo}`,
      headers,
      opts,
    );
    ref = ((await meta.json()) as { default_branch?: string }).default_branch ?? 'HEAD';
  }

  const treeRes = await httpGet(
    `https://api.github.com/repos/${gh.owner}/${gh.repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`,
    headers,
    opts,
  );
  const tree = (await treeRes.json()) as GithubTree;
  if (tree.truncated) {
    throw new RuntimeFailure(
      `GitHub tree listing for '${redact(source.label)}' is truncated; the repository is too large to enumerate. Use a git source instead.`,
    );
  }
  const prefix = `${gh.subpath}/`;
  const blobs = (tree.tree ?? []).filter(
    (e) => e.type === 'blob' && typeof e.path === 'string' && e.path.startsWith(prefix),
  );
  if (blobs.length === 0) {
    throw new RuntimeFailure(
      `GitHub directory '${redact(source.label)}' does not exist or contains no files at ref '${ref}'.`,
    );
  }
  if (blobs.length > MAX_DIR_FILES) {
    throw new RuntimeFailure(
      `GitHub directory '${redact(source.label)}' has ${blobs.length} files (limit ${MAX_DIR_FILES}). Use a git source instead.`,
    );
  }
  const totalBytes = blobs.reduce((sum, e) => sum + (e.size ?? 0), 0);
  if (totalBytes > MAX_DIR_BYTES) {
    throw new RuntimeFailure(
      `GitHub directory '${redact(source.label)}' is ${totalBytes} bytes (limit ${MAX_DIR_BYTES}). Use a git source instead.`,
    );
  }
  if (!blobs.some((e) => e.path === `${gh.subpath}/${DIR_PROFILE_FILE}`)) {
    throw new RuntimeFailure(
      `GitHub directory '${redact(source.label)}' has no ${DIR_PROFILE_FILE} at ref '${ref}'.`,
    );
  }

  // Refresh means a clean slate: never leave stale siblings behind.
  await fs.rm(cacheDir, { recursive: true, force: true });
  await ensureDir(cacheDir);
  await pMap(
    blobs,
    async (entry) => {
      const rel = (entry.path as string).slice(prefix.length);
      // Tree paths come from the API, but stay defensive about traversal.
      if (rel.split('/').some((seg) => seg === '..' || seg === '')) {
        throw new RuntimeFailure(`Unsafe path in GitHub tree: ${entry.path}`);
      }
      const res = await httpGet(
        `https://raw.githubusercontent.com/${gh.owner}/${gh.repo}/${ref}/${entry.path}`,
        authHeaders(source, env),
        opts,
      );
      const target = path.join(cacheDir, rel);
      await ensureDir(path.dirname(target));
      await fs.writeFile(target, Buffer.from(await res.arrayBuffer()));
    },
    { concurrency: opts.concurrency ?? 8, ...(opts.signal ? { signal: opts.signal } : {}) },
  );

  const content = await fs.readFile(profilePath, 'utf8');
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

  // Directory form: the clone already materialized the whole tree, so the
  // profile is simply `<subpath>/qavor.yaml` and siblings resolve for free.
  const subpath = source.dirForm
    ? path.join(source.gitSubpath ?? '', DIR_PROFILE_FILE)
    : (source.gitSubpath ?? '');
  const filePath = path.join(repoDir, subpath);
  try {
    const content = await fs.readFile(filePath, 'utf8');
    return { content, dir: path.dirname(filePath) };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new RuntimeFailure(
        `Profile '${subpath}' not found in repo '${redact(source.target)}'` +
          (source.gitRef ? ` at ref '${source.gitRef}'.` : '.'),
      );
    }
    throw err;
  }
}
