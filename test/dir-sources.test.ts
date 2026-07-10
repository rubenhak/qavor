import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { execa } from 'execa';
import { buildWorkspaceRegistry, type WorkspaceRegistry } from '../src/manifest/discovery.js';
import { classifyRef } from '../src/manifest/remote.js';
import { serviceCommandSteps } from '../src/manifest/runtime.js';
import { stepOriginDir } from '../src/manifest/steps.js';
import type { ServiceManifest } from '../src/manifest/types/index.js';
import { cleanup, makeTempDir } from './helpers/fixtures.js';

const PROFILE_YAML = [
  'kind: profile',
  'name: lib-db',
  'mode: native',
  'runtime:',
  '  native:',
  '    enabled: true',
  '    up: { operations: [{ compose: { action: up, project: p } }] }',
  '',
].join('\n');

const COMPOSE_YAML = ['services:', '  db:', '    image: postgres', ''].join('\n');

async function writeTree(root: string, files: Record<string, string>): Promise<void> {
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(root, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, body);
  }
}

async function build(repo: string, cache: string): Promise<WorkspaceRegistry> {
  return buildWorkspaceRegistry({
    workspaceRoot: repo,
    repos: new Map([['repo', repo]]),
    env: { ...process.env, XDG_CACHE_HOME: cache },
  });
}

function serviceEntry(reg: WorkspaceRegistry) {
  const e = reg.entries.find((x) => x.kind === 'service' && x.name === 'svc');
  assert.ok(e, 'service entry should exist');
  return e;
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

test('classify: paths not ending in .yaml/.yml are directory references', () => {
  const base = '/ws';
  const fileForm = classifyRef('github:acme/lib//profiles/base.yaml@v1', base);
  assert.ok(fileForm.kind === 'remote');
  assert.equal(fileForm.source.backend, 'github');
  assert.equal(fileForm.source.dirForm, false);

  const dirForm = classifyRef('github:acme/lib//library/postgresql@v1', base);
  assert.ok(dirForm.kind === 'remote');
  assert.equal(dirForm.source.dirForm, true);
  assert.deepEqual(dirForm.source.gh, {
    owner: 'acme',
    repo: 'lib',
    ref: 'v1',
    subpath: 'library/postgresql',
  });

  const tree = classifyRef('https://github.com/acme/lib/tree/main/library/mysql', base);
  assert.ok(tree.kind === 'remote');
  assert.equal(tree.source.backend, 'github');
  assert.equal(tree.source.dirForm, true);
  assert.deepEqual(tree.source.gh, {
    owner: 'acme',
    repo: 'lib',
    ref: 'main',
    subpath: 'library/mysql',
  });

  const git = classifyRef('git@github.com:acme/lib.git//library/redis@v2', base);
  assert.ok(git.kind === 'remote');
  assert.equal(git.source.backend, 'git');
  assert.equal(git.source.dirForm, true);
  assert.equal(git.source.gitSubpath, 'library/redis');

  const localDir = classifyRef('file:///abs/library/kind', base);
  assert.ok(localDir.kind === 'remote');
  assert.equal(localDir.source.backend, 'file');
  assert.equal(localDir.source.dirForm, true);
});

test('classify: plain https directory references fail closed', () => {
  assert.throws(
    () => classifyRef('https://cfg.acme.dev/library/mysql', '/ws'),
    /Directory profile sources are not supported for plain https/,
  );
  // A direct YAML document over https keeps working.
  const ok = classifyRef('https://cfg.acme.dev/profiles/base.yaml', '/ws');
  assert.ok(ok.kind === 'remote' && ok.source.backend === 'http');
});

// ---------------------------------------------------------------------------
// file:// directory sources
// ---------------------------------------------------------------------------

test('dir source (file): reads <dir>/qavor.yaml and siblings resolve via origin dir', async () => {
  const repo = await makeTempDir('qavor-dir-');
  // Library lives outside the workspace repo, as it does for real consumers.
  const lib = await makeTempDir('qavor-dirlib-');
  const cache = await makeTempDir('qavor-dirc-');
  try {
    await writeTree(lib, {
      'db/qavor.yaml': PROFILE_YAML,
      'db/docker-compose.yaml': COMPOSE_YAML,
    });
    await writeTree(repo, {
      'svc/qavor.yaml': [
        'kind: service',
        'name: svc',
        `profiles: ["file://${path.join(lib, 'db')}"]`,
        '',
      ].join('\n'),
    });
    const reg = await build(repo, cache);
    assert.equal(reg.issues.length, 0, JSON.stringify(reg.issues));
    const entry = serviceEntry(reg);
    assert.deepEqual(entry.appliedProfiles, ['lib-db']);
    const steps = serviceCommandSteps(entry.data as unknown as ServiceManifest, 'up');
    const origin = stepOriginDir(steps[0]!);
    assert.equal(origin, path.join(lib, 'db'));
    await fs.access(path.join(origin!, 'docker-compose.yaml'));
  } finally {
    await cleanup(repo);
    await cleanup(lib);
    await cleanup(cache);
  }
});

test('dir source (file): missing qavor.yaml in the directory is a manifest issue', async () => {
  const repo = await makeTempDir('qavor-dir-');
  const lib = await makeTempDir('qavor-dirlib-');
  const cache = await makeTempDir('qavor-dirc-');
  try {
    await writeTree(lib, { 'empty/docker-compose.yaml': COMPOSE_YAML });
    await writeTree(repo, {
      'svc/qavor.yaml': [
        'kind: service',
        'name: svc',
        `profiles: ["file://${path.join(lib, 'empty')}"]`,
        '',
      ].join('\n'),
    });
    const reg = await build(repo, cache);
    assert.ok(
      reg.issues.some((i) => /not found/.test(i.message)),
      JSON.stringify(reg.issues),
    );
  } finally {
    await cleanup(repo);
    await cleanup(lib);
    await cleanup(cache);
  }
});

// ---------------------------------------------------------------------------
// git directory sources (local file:// remote, whole clone in cache)
// ---------------------------------------------------------------------------

test('dir source (git): whole tree is cloned; profile and siblings materialize', async () => {
  const base = await makeTempDir('qavor-dirgit-');
  const cache = await makeTempDir('qavor-dirgitc-');
  try {
    // Source-of-truth library repo. The `.git` suffix marks the //-separated
    // git source form on a file:// URL.
    const lib = path.join(base, 'lib.git');
    await writeTree(lib, {
      'library/db/qavor.yaml': PROFILE_YAML,
      'library/db/docker-compose.yaml': COMPOSE_YAML,
    });
    await execa('git', ['init', '-q', '-b', 'main'], { cwd: lib });
    await execa('git', ['config', 'user.email', 't@example.com'], { cwd: lib });
    await execa('git', ['config', 'user.name', 't'], { cwd: lib });
    await execa('git', ['add', '-A'], { cwd: lib });
    await execa('git', ['commit', '-q', '-m', 'init'], { cwd: lib });

    const repo = path.join(base, 'ws');
    await writeTree(repo, {
      'svc/qavor.yaml': [
        'kind: service',
        'name: svc',
        `profiles: ["file://${lib}//library/db@main"]`,
        '',
      ].join('\n'),
    });
    const reg = await build(repo, cache);
    assert.equal(reg.issues.length, 0, JSON.stringify(reg.issues));
    const entry = serviceEntry(reg);
    assert.deepEqual(entry.appliedProfiles, ['lib-db']);
    const steps = serviceCommandSteps(entry.data as unknown as ServiceManifest, 'up');
    const origin = stepOriginDir(steps[0]!);
    assert.ok(origin, 'step must carry an origin dir');
    assert.ok(origin.includes('profiles-git'), `origin should live in the git cache: ${origin}`);
    await fs.access(path.join(origin, 'docker-compose.yaml'));
  } finally {
    await cleanup(base);
    await cleanup(cache);
  }
});
