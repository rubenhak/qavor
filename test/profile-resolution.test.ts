import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { buildWorkspaceRegistry } from '../src/manifest/discovery.js';
import { cleanup, makeTempDir } from './helpers/fixtures.js';

/**
 * Lay out one repo on disk with a set of `<subdir>/qavor.yaml` manifests, then
 * build the workspace registry rooted at it.
 */
async function buildRegistry(
  manifests: Record<string, string>,
): Promise<Awaited<ReturnType<typeof buildWorkspaceRegistry>>> {
  const repo = await makeTempDir('qavor-profres-');
  for (const [subdir, body] of Object.entries(manifests)) {
    const dir = path.join(repo, subdir);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'qavor.yaml'), body);
  }
  try {
    return await buildWorkspaceRegistry({
      workspaceRoot: repo,
      repos: new Map([['repo', repo]]),
    });
  } finally {
    await cleanup(repo);
  }
}

test('registry: profile runtime/mode/env are flattened into the service entry', async () => {
  const reg = await buildRegistry({
    'profiles/node-library': [
      'kind: profile',
      'name: node_library',
      'mode: native',
      'runtime:',
      '  native:',
      '    enabled: true',
      '    prepare: { cmd: "pnpm install" }',
      '    run: { cmd: "npm run build" }',
      'env: { common: { RUNTIME: node } }',
      '',
    ].join('\n'),
    helpers: ['kind: service', 'name: helpers', 'profiles: [node_library]', ''].join('\n'),
  });

  assert.equal(reg.issues.length, 0, `unexpected issues: ${JSON.stringify(reg.issues)}`);
  const helpers = reg.entries.find((e) => e.kind === 'service' && e.name === 'helpers');
  assert.ok(helpers, 'helpers entry should exist');

  // The inherited prepare command is now visible on the resolved entry.
  const data = helpers.data as {
    profiles?: unknown;
    mode?: string;
    runtime?: { native?: { prepare?: { cmd?: string }; run?: { cmd?: string } } };
    env?: { common?: Record<string, unknown> };
  };
  assert.equal(data.runtime?.native?.prepare?.cmd, 'pnpm install');
  assert.equal(data.runtime?.native?.run?.cmd, 'npm run build');
  assert.equal(data.mode, 'native');
  assert.equal(data.env?.common?.RUNTIME, 'node');

  // The now-redundant profiles: key is dropped, and provenance is recorded.
  assert.equal('profiles' in data, false);
  assert.deepEqual(helpers.appliedProfiles, ['node_library']);
});

test('registry: own service values win over profile values', async () => {
  const reg = await buildRegistry({
    base: [
      'kind: profile',
      'name: base',
      'runtime: { native: { run: { cmd: "profile run" } } }',
      'env: { common: { LOG: info, ONLY_PROFILE: yes } }',
      '',
    ].join('\n'),
    svc: [
      'kind: service',
      'name: svc',
      'profiles: [base]',
      'runtime: { native: { run: { cmd: "own run" } } }',
      'env: { common: { LOG: debug } }',
      '',
    ].join('\n'),
  });

  assert.equal(reg.issues.length, 0, `unexpected issues: ${JSON.stringify(reg.issues)}`);
  const svc = reg.entries.find((e) => e.kind === 'service' && e.name === 'svc');
  const data = svc?.data as {
    runtime?: { native?: { run?: { cmd?: string } } };
    env?: { common?: Record<string, unknown> };
  };
  assert.equal(data.runtime?.native?.run?.cmd, 'own run');
  assert.equal(data.env?.common?.LOG, 'debug');
  assert.equal(data.env?.common?.ONLY_PROFILE, 'yes');
});

test('registry: a profile cycle is reported as a manifest issue', async () => {
  const reg = await buildRegistry({
    a: ['kind: profile', 'name: a', 'profiles: [b]', ''].join('\n'),
    b: ['kind: profile', 'name: b', 'profiles: [a]', ''].join('\n'),
    svc: ['kind: service', 'name: svc', 'profiles: [a]', ''].join('\n'),
  });
  assert.ok(
    reg.issues.some((i) => /cycle detected/i.test(i.message)),
    `expected a cycle issue, got ${JSON.stringify(reg.issues)}`,
  );
});
