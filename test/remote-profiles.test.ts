import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import { execa } from 'execa';
import { buildWorkspaceRegistry, type WorkspaceRegistry } from '../src/manifest/discovery.js';
import { cleanup, makeTempDir } from './helpers/fixtures.js';

// A reusable profile document. Referenced remotely under different names.
function profileYaml(name: string, extra = ''): string {
  return [
    'kind: profile',
    `name: ${name}`,
    'mode: native',
    'runtime:',
    '  native:',
    '    enabled: true',
    '    run: { operations: { cmd: "profile run" } }',
    'env: { common: { FROM_REMOTE: yes } }',
    extra,
    '',
  ].join('\n');
}

function serviceYaml(profiles: string): string {
  return ['kind: service', 'name: svc', `profiles: ${profiles}`, ''].join('\n');
}

/** Build a registry rooted at `repo`, isolating the global cache under `cacheHome`. */
async function build(
  repo: string,
  cacheHome: string,
  opts: { env?: Record<string, string>; offline?: boolean; refresh?: boolean } = {},
): Promise<WorkspaceRegistry> {
  const env: NodeJS.ProcessEnv = { ...process.env, XDG_CACHE_HOME: cacheHome, ...(opts.env ?? {}) };
  return buildWorkspaceRegistry({
    workspaceRoot: repo,
    repos: new Map([['repo', repo]]),
    env,
    offline: opts.offline ?? false,
    refresh: opts.refresh ?? false,
  });
}

function svc(reg: WorkspaceRegistry): {
  runtime?: { native?: { run?: { operations?: { cmd?: string } } } };
  env?: { common?: Record<string, unknown> };
  appliedProfiles?: string[];
} {
  const e = reg.entries.find((x) => x.kind === 'service' && x.name === 'svc');
  assert.ok(e, 'service entry should exist');
  return { ...(e.data as object), appliedProfiles: e.appliedProfiles } as never;
}

async function writeFile(repo: string, rel: string, body: string): Promise<string> {
  const abs = path.join(repo, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, body);
  return abs;
}

test('remote profile: file:// string reference is fetched and flattened', async () => {
  const repo = await makeTempDir('qavor-rp-');
  const cache = await makeTempDir('qavor-rpc-');
  try {
    const p = await writeFile(repo, 'shared/base.profile.yaml', profileYaml('remote_base'));
    await writeFile(repo, 'svc/qavor.yaml', serviceYaml(`["file://${p}"]`));
    const reg = await build(repo, cache);
    assert.equal(reg.issues.length, 0, JSON.stringify(reg.issues));
    const s = svc(reg);
    assert.equal(s.runtime?.native?.run?.operations?.cmd, 'profile run');
    assert.equal(s.env?.common?.FROM_REMOTE, 'yes');
    assert.deepEqual(s.appliedProfiles, ['remote_base']);
  } finally {
    await cleanup(repo);
    await cleanup(cache);
  }
});

test('remote profile: inline object and relative file path both resolve', async () => {
  const repo = await makeTempDir('qavor-rp-');
  const cache = await makeTempDir('qavor-rpc-');
  try {
    // Relative path (object form) is resolved against the referencing manifest dir.
    await writeFile(repo, 'svc/base.profile.yaml', profileYaml('rel_base'));
    await writeFile(repo, 'svc/qavor.yaml', serviceYaml('[{ url: "./base.profile.yaml" }]'));
    const reg = await build(repo, cache);
    assert.equal(reg.issues.length, 0, JSON.stringify(reg.issues));
    assert.deepEqual(svc(reg).appliedProfiles, ['rel_base']);
  } finally {
    await cleanup(repo);
    await cleanup(cache);
  }
});

test('remote profile: expected-name mismatch is a manifest issue', async () => {
  const repo = await makeTempDir('qavor-rp-');
  const cache = await makeTempDir('qavor-rpc-');
  try {
    const p = await writeFile(repo, 'shared/base.profile.yaml', profileYaml('actual_name'));
    await writeFile(
      repo,
      'svc/qavor.yaml',
      serviceYaml(`[{ url: "file://${p}", name: expected_name }]`),
    );
    const reg = await build(repo, cache);
    assert.ok(
      reg.issues.some((i) =>
        /declares name 'actual_name', expected 'expected_name'/.test(i.message),
      ),
      JSON.stringify(reg.issues),
    );
  } finally {
    await cleanup(repo);
    await cleanup(cache);
  }
});

test('remote profile: sha256 pin matches and mismatches', async () => {
  const repo = await makeTempDir('qavor-rp-');
  const cache = await makeTempDir('qavor-rpc-');
  try {
    const body = profileYaml('pinned');
    const p = await writeFile(repo, 'shared/pinned.profile.yaml', body);
    const digest = createHash('sha256').update(body).digest('hex');

    // Match → resolves.
    await writeFile(repo, 'ok/qavor.yaml', serviceYaml(`["file://${p}#sha256=${digest}"]`));
    let reg = await build(repo, cache);
    assert.equal(reg.issues.length, 0, JSON.stringify(reg.issues));

    // Mismatch → fails closed with an integrity error.
    const bad = 'f'.repeat(64);
    await fs.rm(path.join(repo, 'ok'), { recursive: true });
    await writeFile(repo, 'bad/qavor.yaml', serviceYaml(`["file://${p}#sha256=${bad}"]`));
    reg = await build(repo, cache);
    assert.ok(
      reg.issues.some((i) => /Integrity check failed/.test(i.message)),
      JSON.stringify(reg.issues),
    );
  } finally {
    await cleanup(repo);
    await cleanup(cache);
  }
});

test('remote profile: chained remote→remote and remote→local resolve', async () => {
  const repo = await makeTempDir('qavor-rp-');
  const cache = await makeTempDir('qavor-rpc-');
  try {
    // A local profile discovered in-workspace.
    await writeFile(
      repo,
      'local/qavor.yaml',
      ['kind: profile', 'name: local_prof', 'env: { common: { FROM_LOCAL: yes } }', ''].join('\n'),
    );
    // A remote leaf profile.
    const leaf = await writeFile(repo, 'shared/leaf.profile.yaml', profileYaml('remote_leaf'));
    // A remote profile that extends both the remote leaf (by URL) and the local one (by name).
    const mid = await writeFile(
      repo,
      'shared/mid.profile.yaml',
      [
        'kind: profile',
        'name: remote_mid',
        `profiles: ["file://${leaf}", local_prof]`,
        'env: { common: { FROM_MID: yes } }',
        '',
      ].join('\n'),
    );
    await writeFile(repo, 'svc/qavor.yaml', serviceYaml(`["file://${mid}"]`));
    const reg = await build(repo, cache);
    assert.equal(reg.issues.length, 0, JSON.stringify(reg.issues));
    const s = svc(reg);
    assert.equal(s.env?.common?.FROM_REMOTE, 'yes', 'leaf env');
    assert.equal(s.env?.common?.FROM_LOCAL, 'yes', 'local env');
    assert.equal(s.env?.common?.FROM_MID, 'yes', 'mid env');
  } finally {
    await cleanup(repo);
    await cleanup(cache);
  }
});

test('remote profile: a cycle across remote sources is detected', async () => {
  const repo = await makeTempDir('qavor-rp-');
  const cache = await makeTempDir('qavor-rpc-');
  try {
    const a = path.join(repo, 'shared/a.profile.yaml');
    const b = path.join(repo, 'shared/b.profile.yaml');
    await writeFile(
      repo,
      'shared/a.profile.yaml',
      ['kind: profile', 'name: cyc_a', `profiles: ["file://${b}"]`, ''].join('\n'),
    );
    await writeFile(
      repo,
      'shared/b.profile.yaml',
      ['kind: profile', 'name: cyc_b', `profiles: ["file://${a}"]`, ''].join('\n'),
    );
    await writeFile(repo, 'svc/qavor.yaml', serviceYaml(`["file://${a}"]`));
    const reg = await build(repo, cache);
    assert.ok(
      reg.issues.some((i) => /cycle detected/i.test(i.message)),
      JSON.stringify(reg.issues),
    );
  } finally {
    await cleanup(repo);
    await cleanup(cache);
  }
});

test('remote profile: two sources declaring the same name collide', async () => {
  const repo = await makeTempDir('qavor-rp-');
  const cache = await makeTempDir('qavor-rpc-');
  try {
    const p1 = await writeFile(repo, 'shared/one.profile.yaml', profileYaml('dup'));
    const p2 = await writeFile(
      repo,
      'shared/two.profile.yaml',
      profileYaml('dup', 'description: other'),
    );
    await writeFile(repo, 'svc/qavor.yaml', serviceYaml(`["file://${p1}", "file://${p2}"]`));
    const reg = await build(repo, cache);
    assert.ok(
      reg.issues.some((i) => /Duplicate profile name 'dup'/.test(i.message)),
      JSON.stringify(reg.issues),
    );
  } finally {
    await cleanup(repo);
    await cleanup(cache);
  }
});

test('remote profile: invalid fetched YAML reports a positioned error with the source as file', async () => {
  const repo = await makeTempDir('qavor-rp-');
  const cache = await makeTempDir('qavor-rpc-');
  try {
    const p = await writeFile(
      repo,
      'shared/broken.profile.yaml',
      'kind: profile\nname: [unclosed\n',
    );
    const url = `file://${p}`;
    await writeFile(repo, 'svc/qavor.yaml', serviceYaml(`["${url}"]`));
    const reg = await build(repo, cache);
    const issue = reg.issues.find((i) => /YAML parse error|invalid/.test(i.message));
    assert.ok(issue, JSON.stringify(reg.issues));
    assert.ok(issue.message.includes(url), `issue should name the source URL: ${issue.message}`);
  } finally {
    await cleanup(repo);
    await cleanup(cache);
  }
});

test('remote profile: wrong kind from a remote source is rejected', async () => {
  const repo = await makeTempDir('qavor-rp-');
  const cache = await makeTempDir('qavor-rpc-');
  try {
    const p = await writeFile(
      repo,
      'shared/svc.profile.yaml',
      ['kind: service', 'name: not_a_profile', ''].join('\n'),
    );
    await writeFile(repo, 'svc/qavor.yaml', serviceYaml(`["file://${p}"]`));
    const reg = await build(repo, cache);
    assert.ok(
      reg.issues.some((i) => /is kind 'service', expected 'profile'/.test(i.message)),
      JSON.stringify(reg.issues),
    );
  } finally {
    await cleanup(repo);
    await cleanup(cache);
  }
});

test('remote profile: http source with bearer token, then offline from cache', async () => {
  const repo = await makeTempDir('qavor-rp-');
  const cache = await makeTempDir('qavor-rpc-');
  const body = profileYaml('http_base');
  const server = http.createServer((req, res) => {
    if (req.headers.authorization !== 'Bearer s3cret') {
      res.writeHead(401);
      res.end('unauthorized');
      return;
    }
    if (req.url === '/base.profile.yaml') {
      res.writeHead(200, { 'content-type': 'text/yaml' });
      res.end(body);
      return;
    }
    res.writeHead(404);
    res.end('nope');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as import('node:net').AddressInfo).port;
  try {
    const url = `http://127.0.0.1:${port}/base.profile.yaml`;
    await writeFile(
      repo,
      'svc/qavor.yaml',
      serviceYaml(`[{ url: "${url}", auth: { tokenEnv: PROF_TOKEN } }]`),
    );

    // 1) With the token → fetch succeeds and is cached.
    let reg = await build(repo, cache, { env: { PROF_TOKEN: 's3cret' } });
    assert.equal(reg.issues.length, 0, JSON.stringify(reg.issues));
    assert.deepEqual(svc(reg).appliedProfiles, ['http_base']);

    // 2) Server down + --offline → served from cache, still resolves.
    await new Promise<void>((resolve) => server.close(() => resolve()));
    reg = await build(repo, cache, { env: { PROF_TOKEN: 's3cret' }, offline: true });
    assert.equal(reg.issues.length, 0, `offline cache miss: ${JSON.stringify(reg.issues)}`);
    assert.deepEqual(svc(reg).appliedProfiles, ['http_base']);
  } finally {
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    await cleanup(repo);
    await cleanup(cache);
  }
});

test('remote profile: http missing token and offline-miss surface errors', async () => {
  const repo = await makeTempDir('qavor-rp-');
  const cache = await makeTempDir('qavor-rpc-');
  const server = http.createServer((req, res) => {
    if (req.headers.authorization !== 'Bearer s3cret') {
      res.writeHead(401);
      res.end('unauthorized');
      return;
    }
    res.writeHead(200);
    res.end(profileYaml('http_base'));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as import('node:net').AddressInfo).port;
  try {
    const url = `http://127.0.0.1:${port}/base.profile.yaml`;

    // Missing token env → UserError issue.
    await writeFile(
      repo,
      'svc/qavor.yaml',
      serviceYaml(`[{ url: "${url}", auth: { tokenEnv: PROF_TOKEN } }]`),
    );
    let reg = await build(repo, cache);
    assert.ok(
      reg.issues.some((i) => /Auth env 'PROF_TOKEN'.*is not set/.test(i.message)),
      JSON.stringify(reg.issues),
    );

    // Non-2xx (wrong token) → runtime failure issue.
    reg = await build(repo, cache, { env: { PROF_TOKEN: 'wrong' } });
    assert.ok(
      reg.issues.some((i) => /HTTP 401/.test(i.message)),
      JSON.stringify(reg.issues),
    );

    // Offline with an empty cache → offline miss.
    reg = await build(repo, cache, { env: { PROF_TOKEN: 's3cret' }, offline: true });
    assert.ok(
      reg.issues.some((i) => /Offline: no cached copy/.test(i.message)),
      JSON.stringify(reg.issues),
    );
  } finally {
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    await cleanup(repo);
    await cleanup(cache);
  }
});

test('remote profile: git source over a file:// remote clones and reads the profile', async () => {
  const repo = await makeTempDir('qavor-rp-');
  const cache = await makeTempDir('qavor-rpc-');
  const gitBase = await makeTempDir('qavor-rpg-');
  const gitRepo = path.join(gitBase, 'profiles-repo.git');
  try {
    await fs.mkdir(gitRepo, { recursive: true });
    await fs.writeFile(path.join(gitRepo, 'base.profile.yaml'), profileYaml('git_base'));
    await execa('git', ['init', '-q', '-b', 'main'], { cwd: gitRepo });
    await execa('git', ['config', 'user.email', 'qavor-test@example.com'], { cwd: gitRepo });
    await execa('git', ['config', 'user.name', 'Qavor Test'], { cwd: gitRepo });
    await execa('git', ['add', '-A'], { cwd: gitRepo });
    await execa('git', ['commit', '-q', '-m', 'init'], { cwd: gitRepo });

    const url = `file://${gitRepo}//base.profile.yaml@main`;
    await writeFile(repo, 'svc/qavor.yaml', serviceYaml(`["${url}"]`));
    const reg = await build(repo, cache);
    assert.equal(reg.issues.length, 0, JSON.stringify(reg.issues));
    assert.deepEqual(svc(reg).appliedProfiles, ['git_base']);
  } finally {
    await cleanup(repo);
    await cleanup(cache);
    await cleanup(gitBase);
  }
});
